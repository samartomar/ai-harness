import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import {
  emptyRegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
} from "../../src/ecc/registration.js";
import { verifiedEccInstallPlan } from "../../src/ecc/verified.js";
import type { Action, DigestAction, ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-verified-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: root } }),
    env: { HOME: root },
    options: {},
  };
}

function authorization(componentId = "runtime:ecc-installer"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((action): action is ExecAction => action.kind === "exec");

function driverSteps(actions: Action[]): Array<{
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
}> {
  const driver = execs(actions).find((action) => action.describe.includes("verified ECC checkout"));
  expect(driver).toBeDefined();
  const encoded = driver?.argv.at(-1);
  if (!encoded) throw new Error("missing verified ECC step payload");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Array<{
    argv: string[];
    cwd: string;
    env?: Record<string, string>;
  }>;
}

function selection(): EccComponentSelection {
  return {
    scope: "scoped",
    components: [
      "baseline:rules",
      "baseline:agents",
      "baseline:platform",
      "baseline:commands",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "lang:typescript",
    ],
    mcps: ["mcp:sequential-thinking"],
    recommendations: [],
  };
}

describe("verifiedEccInstallPlan", () => {
  it("uses one sequential driver with a filtered manifest payload and never npx", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      {
        clis: ["claude"],
        profile: "core",
        packs: ["typescript"],
        selection: selection(),
      },
      [authorization()],
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv).toEqual([
      "npm",
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(steps[0]?.cwd).toBe(sourceRoot);
    expect(steps[1]?.argv.slice(0, 2)).toEqual([process.execPath, "-e"]);
    const encoded = steps[1]?.argv.at(-1);
    if (encoded === undefined) throw new Error("missing materialization payload");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      target: string;
      scope: string;
      moduleIds: string[];
      skills: string[];
      agents: string[];
    };
    expect(payload).toMatchObject({
      target: "claude",
      scope: "scoped",
      moduleIds: [
        "rules-core",
        "agents-core",
        "platform-configs",
        "commands-core",
        "workflow-quality",
        "framework-language",
      ],
      skills: expect.arrayContaining(["tdd-workflow", "api-design"]),
      agents: ["code-reviewer"],
    });
    expect(steps[1]?.env?.ECC_DISABLED_MCPS).toBe("context7,exa,github,memory,playwright,supabase");
    expect(steps[1]?.cwd).toBe(root);
    expect(JSON.stringify(steps)).not.toContain("npx");
    expect(JSON.stringify(steps)).not.toContain("https://");
    expect(JSON.stringify(steps)).not.toContain("install-apply.js");
  });

  it("keeps Codex on the add-only merge path inside the same sequential driver", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["codex"], profile: "core", packs: [], selection: selection() },
      [authorization()],
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv[0]).toBe("npm");
    expect(steps[1]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
    expect(steps[1]?.argv).toContain(join(sourceRoot, "scripts", "codex", "merge-codex-config.js"));
    const specB64 = steps[1]?.argv.at(-1);
    if (specB64 === undefined) throw new Error("missing Codex materialization spec");
    expect(JSON.parse(Buffer.from(specB64, "base64").toString("utf8"))).toMatchObject({
      scope: "scoped",
      moduleIds: expect.arrayContaining(["agents-core", "platform-configs"]),
      agents: ["code-reviewer"],
    });
    expect(steps[1]?.env?.ECC_DISABLED_MCPS).toBe("context7,exa,github,memory,playwright,supabase");
    expect(
      plan.actions.some(
        (action) => action.kind === "write" && action.describe.includes("Codex config.toml"),
      ),
    ).toBe(true);
  });

  it("runs Kiro's script only from the verified checkout", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["kiro"], profile: "core", packs: [] },
      [authorization("runtime:ecc-kiro")],
    );
    const steps = driverSteps(plan.actions);
    expect(steps).toEqual([
      {
        argv: ["bash", join(sourceRoot, ".kiro", "install.sh"), root],
        cwd: sourceRoot,
      },
    ]);
  });

  it("emits machine-readable evidence authorization receipts", () => {
    const receipt = authorization();
    const plan = verifiedEccInstallPlan(
      ctx(),
      join(root, "tree"),
      { clis: ["claude"], profile: "core", packs: [] },
      [receipt],
    );
    const digest = plan.actions.find(
      (action): action is DigestAction =>
        action.kind === "digest" && action.describe.includes("evidence"),
    );
    expect(digest?.data).toEqual({ authorizations: [receipt] });
    expect(digest?.text).toContain("vendor");
    expect(digest?.text).toContain("runtime:ecc-installer");
  });

  it("commits the ledger only after every install step succeeds", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      {
        clis: ["claude"],
        profile: "core",
        packs: [],
        selection: {
          scope: "scoped",
          components: ["baseline:rules"],
          mcps: [],
          recommendations: [],
        },
        project: {
          root,
          scope: "scoped",
          components: ["baseline:rules"],
          mcps: [],
        },
        ledger: emptyRegistrationLedger(),
      },
      [authorization(), authorization("module:rules-core")],
    );
    const driver = execs(built.actions).find((action) =>
      action.describe.includes("verified ECC checkout"),
    );
    if (driver === undefined) throw new Error("missing verified ECC driver");
    const executable = driver.argv[0];
    if (executable === undefined) throw new Error("missing verified ECC driver executable");
    const steps = driverSteps(built.actions);
    const ledgerStep = steps.at(-1);
    expect(ledgerStep?.argv.join(" ")).toContain("registration-ledger");

    const run = (firstExit: number) => {
      const deterministic = steps.map((step, index) =>
        index === steps.length - 1
          ? step
          : {
              argv: [process.execPath, "-e", `process.exit(${index === 0 ? firstExit : 0})`],
              cwd: root,
            },
      );
      const encoded = Buffer.from(JSON.stringify(deterministic), "utf8").toString("base64");
      return spawnSync(executable, [...driver.argv.slice(1, -1), encoded], {
        cwd: root,
        encoding: "utf8",
      });
    };

    expect(run(7).status).toBe(7);
    expect(existsSync(registrationLedgerPath(root))).toBe(false);
    expect(run(0).status).toBe(0);
    expect(readRegistrationLedger(root).projects).toEqual([
      expect.objectContaining({ root, components: ["baseline:rules"] }),
    ]);
  });

  it("preserves consult-only guidance alongside verified mutating targets", () => {
    const built = verifiedEccInstallPlan(
      ctx(),
      join(root, "tree"),
      {
        clis: ["claude", "windsurf"],
        profile: "core",
        packs: [],
        stackSummary: "TypeScript using React",
      },
      [authorization()],
    );

    const guidance = built.actions
      .filter((action) => action.kind === "doc")
      .map((action) => action.text)
      .join("\n");
    expect(guidance).toContain('npx ecc consult "TypeScript using React" --target windsurf');
  });
});
