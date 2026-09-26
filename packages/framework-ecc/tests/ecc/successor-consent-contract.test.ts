import "../core-invocation.js";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../../../src/baseline-evidence/verify.js";
import { generateEccInstallPreviewArtifact } from "../../../../src/ecc/install-preview-generate.js";
import { registeredExecStdinPayload } from "../../../../src/internals/exec-stdin.js";
import type { Action, ExecAction, PlanContext } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import { eccEvidenceComponentIdsForSelection } from "../../src/ecc/evidence.js";
import { codexEccActions } from "../../src/ecc/index.js";
import { parseEccInstallState } from "../../src/ecc/reconcile.js";
import { verifiedEccInstallPlan } from "../../src/ecc/verified.js";

const CANDIDATE_SHA = "549c14692ccf610f127a4b95eb6f496bb45ab6c9";
// Operation and receipt fragments below come from Git tree
// 62e41c660764ee289c0fbe46c8edfd5f2687fd63 retained in candidate-549c/plans.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "aih-ecc-consent-contract-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function context(home = root): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: home } }),
    env: { HOME: home, USERPROFILE: home },
    options: {},
  };
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: CANDIDATE_SHA,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  };
}

function authorizations(target: "claude" | "opencode", selection: EccComponentSelection) {
  return eccEvidenceComponentIdsForSelection(target, selection).map(authorization);
}

function directMaterializeStep(actions: Action[]): {
  argv: string[];
  cwd: string;
  input?: string;
} {
  const driver = actions.find(
    (action): action is ExecAction =>
      action.kind === "exec" && action.describe.includes("verified ECC checkout"),
  );
  const serialized = driver === undefined ? undefined : registeredExecStdinPayload(driver)?.data;
  if (serialized === undefined) throw new Error("missing verified ECC steps stdin");
  const step = (
    JSON.parse(serialized) as Array<{ argv: string[]; cwd: string; input?: string }>
  )[1];
  if (step === undefined) throw new Error("missing verified ECC materialization step");
  return step;
}

function runDirectTarget(
  target: "claude" | "opencode",
  sourceRoot: string,
  selection: EccComponentSelection,
  governance = false,
) {
  const built = verifiedEccInstallPlan(
    context(),
    sourceRoot,
    {
      clis: [target],
      profile: "core",
      packs: [],
      selection,
      ...(governance ? { governance: true as const } : {}),
    },
    authorizations(target, selection),
  );
  const step = directMaterializeStep(built.actions);
  const executable = step.argv[0];
  if (executable === undefined) throw new Error("missing materialization executable");
  return spawnSync(executable, step.argv.slice(1), {
    cwd: step.cwd,
    input: step.input,
    encoding: "utf8",
  });
}

function candidateRequest(hookConsent: unknown = null): Record<string, unknown> {
  return {
    profile: "core",
    modules: [],
    includeComponents: [],
    excludeComponents: [],
    legacyLanguages: [],
    legacyMode: false,
    hookConsent,
  };
}

function successorHelper(callPath: string): string {
  return `
const fs = require("node:fs");
const isHook = (operation) => operation.kind === "update-claude-settings" || operation.moduleId === "hooks-runtime";
exports.withHookConsent = (plan, hookConsent) => {
  fs.writeFileSync(${JSON.stringify(callPath)}, hookConsent, "utf8");
  if (hookConsent !== "enabled" && hookConsent !== "declined") throw new Error("unknown fixture hook consent");
  if (hookConsent === "enabled") {
    return { ...plan, hookConsent, statePreview: { ...plan.statePreview, request: { ...plan.statePreview.request, hookConsent } } };
  }
  const operations = plan.operations.filter((operation) => !isHook(operation));
  const stateOperations = plan.statePreview.operations.filter((operation) => !isHook(operation));
  return {
    ...plan,
    hookConsent,
    operations,
    selectedModuleIds: plan.selectedModuleIds.filter((id) => id !== "hooks-runtime"),
    excludedModuleIds: [...new Set([...plan.excludedModuleIds, "hooks-runtime"])],
    statePreview: {
      ...plan.statePreview,
      request: { ...plan.statePreview.request, hookConsent },
      resolution: {
        ...plan.statePreview.resolution,
        selectedModules: plan.statePreview.resolution.selectedModules.filter((id) => id !== "hooks-runtime"),
      },
      operations: stateOperations,
    },
  };
};
`;
}

function candidateInstaller(plan: Record<string, unknown>, capturePath: string): string {
  return `
exports.createManifestInstallPlan = () => JSON.parse(${JSON.stringify(JSON.stringify(plan))});
exports.applyInstallPlan = (plan) => {
  const hookRuntime = plan.operations.some((operation) => operation.kind === "update-claude-settings" || operation.moduleId === "hooks-runtime");
  if (hookRuntime && plan.hookConsent !== "enabled") throw new Error("candidate hook consent preflight refused the plan");
  require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(plan), "utf8");
};
`;
}

function candidatePlan(
  target: "claude" | "opencode",
  operations: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const targetRoot =
    target === "claude" ? join(root, ".claude") : join(root, ".config", "opencode");
  const statePath =
    target === "claude"
      ? join(targetRoot, "ecc", "install-state.json")
      : join(targetRoot, "ecc-install-state.json");
  const selectedModules = ["commands-core", "hooks-runtime", "workflow-quality"];
  return {
    mode: "manifest",
    target,
    selectedModuleIds: selectedModules,
    excludedModuleIds: [],
    operations,
    statePreview: {
      schemaVersion: "ecc.install.v1",
      installedAt: "2026-09-15T00:00:00.000Z",
      target: {
        id: `${target}-home`,
        target,
        kind: "home",
        root: targetRoot,
        installStatePath: statePath,
      },
      request: candidateRequest(),
      resolution: { selectedModules, skippedModules: [] },
      source: { repoVersion: "2.2.1", repoCommit: CANDIDATE_SHA, manifestVersion: 1 },
      operations: operations.map((operation) => ({ ...operation })),
    },
    installStatePath: statePath,
  };
}

function writeSuccessorFixture(
  name: string,
  target: "claude" | "opencode",
  operations: Array<Record<string, unknown>>,
) {
  const sourceRoot = join(root, name);
  const capture = join(root, `${name}-applied.json`);
  const helperCall = join(root, `${name}-helper.txt`);
  put(join(sourceRoot, "package.json"), '{"name":"ecc-successor-fixture"}\n');
  put(
    join(sourceRoot, "scripts", "lib", "install", "hook-consent.js"),
    successorHelper(helperCall),
  );
  put(
    join(sourceRoot, "scripts", "lib", "install-executor.js"),
    candidateInstaller(candidatePlan(target, operations), capture),
  );
  return { sourceRoot, capture, helperCall };
}

describe("ECC successor consent receipt", () => {
  it.each([undefined, null, "enabled", "declined"])(
    "strictly accepts the optional candidate hook consent value %s",
    (hookConsent) => {
      const targetRoot = join(root, ".codex");
      const statePath = join(targetRoot, "ecc-install-state.json");
      const request = candidateRequest(hookConsent);
      if (hookConsent === undefined) delete request.hookConsent;
      const parsed = parseEccInstallState(
        JSON.stringify({
          schemaVersion: "ecc.install.v1",
          installedAt: "2026-09-15T00:00:00.000Z",
          target: {
            id: "codex-home",
            target: "codex",
            kind: "home",
            root: targetRoot,
            installStatePath: statePath,
          },
          request,
          resolution: { selectedModules: [], skippedModules: [] },
          source: { repoVersion: "2.2.1", repoCommit: CANDIDATE_SHA, manifestVersion: 1 },
          operations: [],
        }),
        statePath,
      );
      expect(parsed.request.hookConsent).toBe(hookConsent);
    },
  );

  it.each(["accepted", true, 1])("refuses unknown hook consent value %s", (hookConsent) => {
    const targetRoot = join(root, ".codex");
    const statePath = join(targetRoot, "ecc-install-state.json");
    expect(() =>
      parseEccInstallState(
        JSON.stringify({
          schemaVersion: "ecc.install.v1",
          installedAt: "2026-09-15T00:00:00.000Z",
          target: {
            id: "codex-home",
            target: "codex",
            kind: "home",
            root: targetRoot,
            installStatePath: statePath,
          },
          request: candidateRequest(hookConsent),
          resolution: { selectedModules: [], skippedModules: [] },
          source: { repoVersion: "2.2.1", repoCommit: CANDIDATE_SHA, manifestVersion: 1 },
          operations: [],
        }),
        statePath,
      ),
    ).toThrow(/invalid ECC install state/i);
  });
});

describe("ECC successor direct materialization", () => {
  it.each(["enabled", "declined"] as const)(
    "propagates OpenCode %s consent and keeps plan, state, and modules synchronized",
    (decision) => {
      const content = {
        kind: "copy-file",
        moduleId: "commands-core",
        sourceRelativePath: "commands/aside.md",
        destinationPath: join(root, ".config", "opencode", "commands", "aside.md"),
      };
      const hook = {
        kind: "copy-file",
        moduleId: "hooks-runtime",
        sourceRelativePath: "hooks/README.md",
        destinationPath: join(root, ".config", "opencode", "hooks", "README.md"),
      };
      const fixture = writeSuccessorFixture(`opencode-${decision}`, "opencode", [content, hook]);
      const selection: EccComponentSelection = {
        scope: "scoped",
        components:
          decision === "enabled" ? ["baseline:commands", "baseline:hooks"] : ["baseline:commands"],
        mcps: [],
        recommendations: [],
        ...(decision === "declined" ? { moduleIds: ["hooks-runtime"] } : {}),
      };

      const result = runDirectTarget("opencode", fixture.sourceRoot, selection);

      expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
      expect(readFileSync(fixture.helperCall, "utf8")).toBe(decision);
      const applied = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
        hookConsent: string;
        selectedModuleIds: string[];
        excludedModuleIds: string[];
        operations: Array<{ moduleId: string }>;
        statePreview: {
          request: { hookConsent: string };
          resolution: { selectedModules: string[] };
          operations: Array<{ moduleId: string }>;
        };
      };
      expect(applied.hookConsent).toBe(decision);
      expect(applied.statePreview.request.hookConsent).toBe(decision);
      expect(applied.statePreview.operations).toEqual(applied.operations);
      expect(applied.statePreview.resolution.selectedModules).toEqual(applied.selectedModuleIds);
      expect(applied.operations.some((operation) => operation.moduleId === "hooks-runtime")).toBe(
        decision === "enabled",
      );
      expect(applied.selectedModuleIds.includes("hooks-runtime")).toBe(decision === "enabled");
      if (decision === "declined") expect(applied.excludedModuleIds).toContain("hooks-runtime");
    },
  );

  it("passes a policy-owned baseline:hooks selection to the helper as declined", () => {
    const operations = [
      {
        kind: "copy-file",
        moduleId: "commands-core",
        sourceRelativePath: "commands/aside.md",
        destinationPath: join(root, ".config", "opencode", "commands", "aside.md"),
      },
      {
        kind: "copy-file",
        moduleId: "hooks-runtime",
        sourceRelativePath: "hooks/README.md",
        destinationPath: join(root, ".config", "opencode", "hooks", "README.md"),
      },
    ];
    const fixture = writeSuccessorFixture("opencode-policy", "opencode", operations);
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: ["baseline:commands", "baseline:hooks"],
      mcps: [],
      recommendations: [],
    };

    const result = runDirectTarget("opencode", fixture.sourceRoot, selection, true);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(readFileSync(fixture.helperCall, "utf8")).toBe("declined");
    const applied = JSON.parse(readFileSync(fixture.capture, "utf8")) as {
      hookConsent: string;
      operations: Array<{ moduleId: string }>;
      selectedModuleIds: string[];
    };
    expect(applied.hookConsent).toBe("declined");
    expect(applied.operations.some((operation) => operation.moduleId === "hooks-runtime")).toBe(
      false,
    );
    expect(applied.selectedModuleIds).not.toContain("hooks-runtime");
  });

  it("accepts candidate-native Claude decline but keeps enabled settings updates refused pre-effect", () => {
    const content = {
      kind: "copy-file",
      moduleId: "workflow-quality",
      sourceRelativePath: "skills/tdd-workflow/SKILL.md",
      destinationPath: join(root, ".claude", "skills", "tdd-workflow", "SKILL.md"),
    };
    const settings = {
      kind: "update-claude-settings",
      moduleId: "hooks-runtime",
      sourceRelativePath: "hooks/hooks.json",
      destinationPath: join(root, ".claude", "settings.json"),
      strategy: "merge-hook-ids",
      ownership: "managed",
      scaffoldOnly: false,
      managedHooks: { PreToolUse: [] },
    };
    const declined = writeSuccessorFixture("claude-declined", "claude", [content, settings]);
    const declinedSelection: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
      moduleIds: ["hooks-runtime"],
    };

    const declinedResult = runDirectTarget("claude", declined.sourceRoot, declinedSelection);
    expect(declinedResult.status, `${declinedResult.stderr}${declinedResult.stdout}`).toBe(0);
    expect(readFileSync(declined.helperCall, "utf8")).toBe("declined");
    const declinedPlan = JSON.parse(readFileSync(declined.capture, "utf8")) as {
      operations: Array<{ kind: string }>;
      selectedModuleIds: string[];
    };
    expect(declinedPlan.operations.map((operation) => operation.kind)).toEqual(["copy-file"]);
    expect(declinedPlan.selectedModuleIds).not.toContain("hooks-runtime");

    const enabled = writeSuccessorFixture("claude-enabled", "claude", [content, settings]);
    const enabledSelection: EccComponentSelection = {
      ...declinedSelection,
      components: ["skill:tdd-workflow", "baseline:hooks"],
    };
    const enabledResult = runDirectTarget("claude", enabled.sourceRoot, enabledSelection);
    expect(enabledResult.status).not.toBe(0);
    expect(`${enabledResult.stderr}${enabledResult.stdout}`).toMatch(
      /unsupported ECC manifest operation kind: update-claude-settings/,
    );
    expect(readFileSync(enabled.helperCall, "utf8")).toBe("enabled");
    expect(existsSync(enabled.capture)).toBe(false);
  });

  it("keeps the helper-absent qualified-pin driver path unchanged", () => {
    const sourceRoot = join(root, "legacy-qualified");
    const capture = join(root, "legacy-qualified-applied.json");
    const operation = {
      kind: "copy-file",
      moduleId: "workflow-quality",
      sourceRelativePath: "skills/tdd-workflow/SKILL.md",
      destinationPath: join(root, ".claude", "skills", "tdd-workflow", "SKILL.md"),
    };
    const plan = candidatePlan("claude", [operation]);
    const statePreview = plan.statePreview as { request: Record<string, unknown> };
    delete statePreview.request.hookConsent;
    delete plan.selectedModuleIds;
    delete plan.excludedModuleIds;
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      candidateInstaller(plan, capture),
    );
    const selection: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
    };

    const result = runDirectTarget("claude", sourceRoot, selection);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    const applied = JSON.parse(readFileSync(capture, "utf8")) as Record<string, unknown>;
    expect(applied).not.toHaveProperty("hookConsent");
  });
});

describe("ECC successor preview generation", () => {
  it("uses the optional helper while leaving a helper-absent preview compatible", () => {
    const sourceRoot = join(root, "preview-successor");
    const helperCall = join(root, "preview-helper.txt");
    put(join(sourceRoot, "package.json"), '{"name":"ecc-successor-preview"}\n');
    put(
      join(sourceRoot, "scripts", "lib", "install", "hook-consent.js"),
      successorHelper(helperCall),
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-manifests.js"),
      'exports.listInstallComponents = () => [{ id: "baseline:rules" }];\n',
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-targets", "registry.js"),
      `exports.getInstallTargetAdapter = (target) => ({
        resolveRoot: ({ projectRoot, homeDir }) => ({
          claude: homeDir + "/.claude",
          codex: homeDir + "/.codex",
          cursor: projectRoot + "/.cursor",
          antigravity: projectRoot + "/.agent",
          gemini: projectRoot + "/.gemini",
          opencode: homeDir + "/.config/opencode",
          zed: projectRoot + "/.zed",
        })[target],
      });\n`,
    );
    put(
      join(sourceRoot, "scripts", "lib", "install", "plan.js"),
      `const { getInstallTargetAdapter } = require("../install-targets/registry.js");
      exports.createManifestInstallPlan = (input) => {
        const targetRoot = getInstallTargetAdapter(input.target).resolveRoot(input);
        // The rules destination each PINNED adapter writes for rules/common/security.md:
        // claude-home.js namespaces rules under rules/ecc/, cursor-project.js flattens
        // rules to <dir>-<file>.mdc, antigravity-project.js and zed-project.js flatten
        // to <dir>-<file>.md, and codex/gemini scaffold the root-relative path.
        const rulesSuffix = {
          claude: "/rules/ecc/common/security.md",
          codex: "/rules/common/security.md",
          cursor: "/rules/common-security.mdc",
          antigravity: "/rules/common-security.md",
          gemini: "/rules/common/security.md",
          opencode: "/rules/common/security.md",
          zed: "/rules/common-security.md",
        }[input.target];
        const operation = {
          kind: "copy-file",
          moduleId: "rules-core",
          sourceRelativePath: "rules/common/security.md",
          destinationPath: targetRoot + rulesSuffix,
        };
        return {
          target: input.target,
          hookConsent: null,
          selectedModuleIds: ["rules-core"],
          excludedModuleIds: [],
          operations: [operation],
          statePreview: {
            request: ${JSON.stringify(candidateRequest())},
            resolution: { selectedModules: ["rules-core"], skippedModules: [] },
            operations: [{ ...operation }],
          },
        };
      };\n`,
    );

    const artifact = generateEccInstallPreviewArtifact(sourceRoot, CANDIDATE_SHA);
    expect(readFileSync(helperCall, "utf8")).toBe("declined");
    expect(artifact.operations).toContainEqual(
      expect.objectContaining({
        componentId: "baseline:rules",
        source: "rules/common/security.md",
      }),
    );
  });
});

describe("ECC successor Codex fallback", () => {
  it("embeds the same optional upstream consent contract in the Codex driver", () => {
    const actions = codexEccActions(
      context(),
      { dir: root, posix: root.replace(/\\/g, "/"), explicit: true, hasCache: false },
      "core",
      {
        scope: "scoped",
        moduleIds: [],
        wholeModules: [],
        skills: [],
        agents: [],
        sourceRoots: [],
        agentScaffolding: false,
        executableConsent: "declined",
      },
    );
    const action = actions.find(
      (candidate): candidate is ExecAction =>
        candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
    );
    const program = action?.argv[2];
    if (program === undefined) throw new Error("missing Codex fallback program");
    const packed = /inflateRawSync\(Buffer\.from\("([^"\\]+)", "base64"\)\)/.exec(program);
    if (packed?.[1] === undefined) throw new Error("missing compressed Codex program");
    const source = inflateRawSync(Buffer.from(packed[1], "base64")).toString("utf8");
    expect(source).toContain('scripts", "lib", "install", "hook-consent.js');
    expect(source).toContain("applyEccUpstreamHookConsent");
  });
});
