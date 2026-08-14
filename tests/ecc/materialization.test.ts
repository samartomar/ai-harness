import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import {
  applyEccMaterialization,
  type EccMaterializationComponentInput,
  type EccMaterializationLedgerUpdate,
  type EccMaterializationRequest,
  type EccMaterializationStep,
  previewEccMaterialization,
  repairEccMaterialization,
  uninstallEccMaterialization,
} from "../../src/ecc/materialization.js";
import {
  MAX_MATERIALIZED_FILE_BYTES,
  writeDestinationAtomic,
} from "../../src/ecc/materialization-fs.js";
import {
  planEccComponentSubtraction,
  planEccMaterialization,
  readBoundedKiroAgentPaths,
} from "../../src/ecc/materialization-plan.js";
import {
  ECC_MATERIALIZATION_RECEIPT_PATH,
  MAX_MATERIALIZATION_RECEIPT_BYTES,
  readEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";
import { resolveVerifiedKiroMaterialization } from "../../src/ecc/materialization-target-kiro.js";
import { eccComponentSourcePaths } from "../../src/ecc/materialize.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

it("bounds Kiro agent collision inventory before accepting an oversized directory", () => {
  const agents = join(root, ".kiro", "agents");
  mkdirSync(agents, { recursive: true });
  for (const name of ["one.json", "two.json", "three.json"]) {
    writeFileSync(join(agents, name), "{}\n", "utf8");
  }

  expect(() => readBoundedKiroAgentPaths(root, 2)).toThrow(/Kiro agent.*oversized/i);
});

const SKILL_PATH = ".claude/skills/tdd-workflow/SKILL.md";
const SKILL_BODY = "# tdd-workflow\n\nRed, green, refactor.\n";
const AGENT_PATH = ".claude/agents/code-reviewer.md";
const AGENT_BODY = "# code-reviewer\n\nReview after writing code.\n";
const SETTINGS_PATH = ".claude/settings.json";
const OPERATOR_SETTINGS = `${JSON.stringify(
  { model: "operator-choice", permissions: { allow: ["Bash(ls:*)"] } },
  null,
  2,
)}\n`;
const OWNED_FRAGMENT = JSON.stringify({ statusLine: { type: "command", command: "aih status" } });

function authorization(componentId: string): BaselineAuthorization {
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

function provenanceForTest(): EccMaterializationComponentInput["provenance"] {
  return {
    repository: "affaan-m/ECC",
    commit: "a".repeat(40),
    componentPath: "skills/tdd-workflow",
  };
}

function componentInput(
  id: EccComponentId,
  files: Array<{
    path: string;
    kind?: "copy-file" | "merge-json";
    contents: string;
  }>,
): EccMaterializationComponentInput {
  return {
    id,
    authorization: authorization(id),
    provenance: {
      repository: "affaan-m/ECC",
      commit: "a".repeat(40),
      componentPath: `skills/${id.split(":")[1] ?? id}`,
    },
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind ?? "copy-file",
      contents: file.contents,
    })),
  };
}

function skillComponent(): EccMaterializationComponentInput {
  return componentInput("skill:tdd-workflow", [{ path: SKILL_PATH, contents: SKILL_BODY }]);
}

function agentComponent(): EccMaterializationComponentInput {
  return componentInput("agent:code-reviewer", [{ path: AGENT_PATH, contents: AGENT_BODY }]);
}

function settingsComponent(): EccMaterializationComponentInput {
  return componentInput("skill:verification-loop", [
    { path: SETTINGS_PATH, kind: "merge-json", contents: OWNED_FRAGMENT },
  ]);
}

function request(...components: EccMaterializationComponentInput[]): EccMaterializationRequest {
  return { root, components };
}

function verifiedKiroComponentForEngine(accepted = false) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-kiro-proof-"));
  try {
    for (const [path, contents] of Object.entries({
      "skills/tdd-workflow/SKILL.md": "# selected skill\n",
      ".agents/skills/tdd-workflow/SKILL.md": "# selected agent skill\n",
      ".kiro/skills/tdd-workflow/SKILL.md": "# curated Kiro skill\n",
      ".kiro/steering/security.md": "# security\n",
    })) {
      const absolute = join(sourceRoot, ...path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
    }
    const selectedAuthorization: BaselineAuthorization = {
      ...authorization("skill:tdd-workflow"),
      treeSha256: hashComponentTree(sourceRoot, eccComponentSourcePaths("skill:tdd-workflow"))
        .treeSha256,
      ...(accepted
        ? {
            effective: "accepted-with-conditions" as const,
            acceptance: {
              decisionId: "selected-decision",
              recordSha256: "e".repeat(64),
              acceptedFindingCodes: ["selected-finding"],
            },
          }
        : {}),
    };
    const runtimeAuthorization: BaselineAuthorization = {
      ...authorization("runtime:ecc-kiro"),
      treeSha256: hashComponentTree(sourceRoot, [".kiro"]).treeSha256,
      ...(accepted
        ? {
            effective: "accepted-with-conditions" as const,
            acceptance: {
              decisionId: "runtime-decision",
              recordSha256: "f".repeat(64),
              acceptedFindingCodes: ["runtime-finding"],
            },
          }
        : {}),
    };
    return resolveVerifiedKiroMaterialization({
      sourceRoot,
      components: [
        {
          id: "skill:tdd-workflow",
          authorization: selectedAuthorization,
          provenance: {
            repository: "affaan-m/ECC",
            commit: "a".repeat(40),
            componentPath: "skills/tdd-workflow",
          },
        },
      ],
      evidence: {
        authorizations: [selectedAuthorization, runtimeAuthorization],
        held: [],
      },
    }).components[0];
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

function put(relativePath: string, contents: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tree(directory = root): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      return entry.isDirectory()
        ? tree(absolute)
        : [relative(root, absolute).split("\\").join("/")];
    })
    .sort((left, right) => left.localeCompare(right));
}

/** Symlink creation is privileged on Windows; make the skip visible, not silent. */
function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * A filesystem alias that reaches `name` under a different spelling — NTFS 8.3
 * short names on this platform. Returns undefined where the volume generates
 * none, so the skip is visible rather than silent.
 */
function shortNameAlias(name: string): string | undefined {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-alias-probe-"));
  try {
    mkdirSync(join(probe, name), { recursive: true });
    const candidate = `${name.replace(/^\./, "").slice(0, 6).toUpperCase()}~1`;
    return existsSync(join(probe, candidate)) ? candidate : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Whether this process can actually be denied a stat. Root bypasses directory
 * permissions, so the check would be vacuous there; make the skip visible.
 */
function canObserveInaccessiblePath(): boolean {
  if (process.platform === "win32") return false;
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-eacces-probe-"));
  try {
    mkdirSync(join(probe, "locked"));
    writeFileSync(join(probe, "locked", "file"), "x", "utf8");
    chmodSync(join(probe, "locked"), 0o000);
    try {
      lstatSync(join(probe, "locked", "file"));
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    try {
      chmodSync(join(probe, "locked"), 0o700);
    } catch {
      // best effort
    }
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Whether this volume distinguishes `a` from `A`. */
function caseSensitiveVolume(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-case-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "x", "utf8");
    return !existsSync(join(probe, "PROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

function ownedReceipt() {
  const state = readEccMaterializationReceipt(root);
  if (state.state !== "valid") throw new Error(`expected a valid receipt, got ${state.state}`);
  return state.receipt;
}

describe("F1/F5 — AIH-direct per-component materialization", () => {
  it("previews the full per-component, per-file plan and writes nothing", () => {
    const plan = previewEccMaterialization(request(skillComponent(), settingsComponent()));

    expect(plan.write).toEqual([
      {
        componentId: "skill:tdd-workflow",
        path: SKILL_PATH,
        operation: "copy-file",
        action: "create",
      },
      {
        componentId: "skill:verification-loop",
        path: SETTINGS_PATH,
        operation: "merge-json",
        action: "create",
      },
    ]);
    expect(plan.subtract).toEqual([]);
    expect(tree()).toEqual([]);
  });

  it("writes owned content before the ownership record and pins the exact bytes", () => {
    const steps: EccMaterializationStep[] = [];
    const ledger: EccMaterializationLedgerUpdate[] = [];

    const result = applyEccMaterialization(request(skillComponent()), {
      onStep: (step) => steps.push(step),
      onLedgerUpdate: (update) => ledger.push(update),
    });

    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(steps.map((step) => `${step.phase}:${step.kind}:${step.path}`)).toEqual([
      `content:write:${SKILL_PATH}`,
      `receipt:write:${ECC_MATERIALIZATION_RECEIPT_PATH}`,
    ]);
    expect(result.written.map((entry) => entry.path)).toEqual([SKILL_PATH]);

    const receipt = ownedReceipt();
    expect(receipt.components).toHaveLength(1);
    expect(receipt.components[0]?.id).toBe("skill:tdd-workflow");
    expect(receipt.components[0]?.provenance).toEqual({
      repository: "affaan-m/ECC",
      commit: "a".repeat(40),
      componentPath: "skills/tdd-workflow",
    });
    expect(receipt.components[0]?.files).toEqual([
      { path: SKILL_PATH, operation: "copy-file", contentSha256: sha256(SKILL_BODY) },
    ]);
    expect(ledger).toEqual([
      {
        root: expect.any(String),
        components: [
          { id: "skill:tdd-workflow", authorization: authorization("skill:tdd-workflow") },
        ],
      },
    ]);
  });

  it("refuses to launder curated Kiro bytes through only the selected component authorization", () => {
    const laundered = componentInput("skill:tdd-workflow", [
      { path: ".kiro/skills/tdd-workflow/SKILL.md", contents: SKILL_BODY },
    ]);

    expect(() => applyEccMaterialization(request(laundered))).toThrow(
      /future verified-source Kiro adapter/i,
    );
    expect(tree()).toEqual([]);
  });

  it("admits exact adapter-proven Kiro bytes and persists dual evidence", () => {
    const component = verifiedKiroComponentForEngine();
    if (component === undefined) throw new Error("expected a verified Kiro component");

    applyEccMaterialization(request(component));

    expect(read(".kiro/skills/tdd-workflow/SKILL.md")).toBe("# curated Kiro skill\n");
    expect(ownedReceipt().components[0]?.files[0]).toMatchObject({
      path: ".kiro/skills/tdd-workflow/SKILL.md",
      contentAuthorization: { componentId: "runtime:ecc-kiro" },
      contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
    });
  });

  it("refuses forged or mutated adapter proof objects", () => {
    const attempts: Array<() => EccMaterializationComponentInput> = [
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        const file = component.files[0];
        if (file === undefined) throw new Error("expected file");
        return { ...component, files: [{ ...file }] };
      },
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        return { ...component, files: [new Proxy(component.files[0] as object, {}) as never] };
      },
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        const file = component.files[0];
        if (file === undefined) throw new Error("expected file");
        const contents = file.contents;
        contents[0] = (contents[0] ?? 0) ^ 1;
        return component;
      },
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        const file = component.files[0];
        if (file === undefined) throw new Error("expected file");
        file.path = ".kiro/skills/tdd-workflow/OTHER.md";
        return component;
      },
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        component.provenance = { ...component.provenance, componentPath: "skills/other" };
        return component;
      },
      () => {
        const component = verifiedKiroComponentForEngine();
        if (component === undefined) throw new Error("expected component");
        component.authorization = { ...component.authorization, treeSha256: "d".repeat(64) };
        return component;
      },
      () => {
        const component = verifiedKiroComponentForEngine(true);
        if (component === undefined || component.authorization.acceptance === undefined) {
          throw new Error("expected selected acceptance");
        }
        component.authorization.acceptance.decisionId = "mutated-selected-decision";
        return component;
      },
      () => {
        const component = verifiedKiroComponentForEngine(true);
        const contentAuthorization = component?.files[0]?.contentAuthorization;
        if (component === undefined || contentAuthorization?.acceptance === undefined) {
          throw new Error("expected runtime acceptance");
        }
        contentAuthorization.acceptance.acceptedFindingCodes.push("mutated-runtime-code");
        return component;
      },
    ];

    for (const attempt of attempts) {
      expect(() => previewEccMaterialization(request(attempt()))).toThrow(
        /future verified-source Kiro adapter|adapter proof/i,
      );
    }
    expect(tree()).toEqual([]);
  });

  it("never invokes branded file accessors or rereads enclosing component accessors", () => {
    const invalid = verifiedKiroComponentForEngine();
    const invalidFile = invalid?.files[0];
    if (invalid === undefined || invalidFile === undefined) throw new Error("expected component");
    let fileGetterCalls = 0;
    Object.defineProperty(invalidFile, "contents", {
      configurable: true,
      enumerable: true,
      get: () => {
        fileGetterCalls += 1;
        return Buffer.from("poison");
      },
    });
    expect(() => previewEccMaterialization(request(invalid))).toThrow(/adapter proof/i);
    expect(fileGetterCalls).toBe(0);

    const valid = verifiedKiroComponentForEngine();
    if (valid === undefined) throw new Error("expected component");
    const selectedAuthorization = valid.authorization;
    let authorizationGetterCalls = 0;
    Object.defineProperty(valid, "authorization", {
      configurable: true,
      enumerable: true,
      get: () => {
        authorizationGetterCalls += 1;
        return authorizationGetterCalls === 1
          ? selectedAuthorization
          : { ...selectedAuthorization, treeSha256: "d".repeat(64) };
      },
    });
    expect(previewEccMaterialization(request(valid)).write.map((file) => file.path)).toEqual([
      ".kiro/skills/tdd-workflow/SKILL.md",
    ]);
    expect(authorizationGetterCalls).toBe(1);

    const nested = verifiedKiroComponentForEngine(true);
    const acceptance = nested?.authorization.acceptance;
    if (nested === undefined || acceptance === undefined) {
      throw new Error("expected accepted component");
    }
    let decisionGetterCalls = 0;
    Object.defineProperty(acceptance, "decisionId", {
      configurable: true,
      enumerable: true,
      get: () => {
        decisionGetterCalls += 1;
        return decisionGetterCalls === 1 ? "selected-decision" : "poisoned-decision";
      },
    });
    let provenanceGetterCalls = 0;
    Object.defineProperty(nested.provenance, "componentPath", {
      configurable: true,
      enumerable: true,
      get: () => {
        provenanceGetterCalls += 1;
        return provenanceGetterCalls === 1 ? "skills/tdd-workflow" : "skills/other";
      },
    });
    expect(applyEccMaterialization(request(nested)).written.map((file) => file.path)).toEqual([
      ".kiro/skills/tdd-workflow/SKILL.md",
    ]);
    expect(decisionGetterCalls).toBe(1);
    expect(provenanceGetterCalls).toBe(1);
    expect(ownedReceipt().components[0]).toMatchObject({
      id: "skill:tdd-workflow",
      authorization: {
        effective: "accepted-with-conditions",
        acceptance: { decisionId: "selected-decision" },
      },
      provenance: { componentPath: "skills/tdd-workflow" },
    });
  });

  it("refuses mixed adapter proofs that disagree on the selected component identity", () => {
    const passed = verifiedKiroComponentForEngine();
    const accepted = verifiedKiroComponentForEngine(true);
    const passedFile = passed?.files[0];
    const acceptedFile = accepted?.files[0];
    if (
      passed === undefined ||
      accepted === undefined ||
      passedFile === undefined ||
      acceptedFile === undefined ||
      accepted.authorization.acceptance === undefined
    ) {
      throw new Error("expected two verified Kiro components");
    }
    let effectiveReads = 0;
    let acceptanceReads = 0;
    const authorization = {
      ...passed.authorization,
      get effective() {
        effectiveReads += 1;
        return effectiveReads === 1
          ? passed.authorization.effective
          : accepted.authorization.effective;
      },
      get acceptance() {
        acceptanceReads += 1;
        return acceptanceReads === 1 ? undefined : accepted.authorization.acceptance;
      },
    };

    expect(() =>
      previewEccMaterialization(
        request({ ...passed, authorization, files: [passedFile, acceptedFile] }),
      ),
    ).toThrow(/every verified file proof to agree/i);
    expect(tree()).toEqual([]);
  });

  it("refuses generic Kiro writes until the verified-source adapter exists", () => {
    const paths = [
      ".kiro/skills/tdd-workflow/SKILL.md",
      ".kiro/agents/code-reviewer.md",
      ".kiro/agents/code-reviewer.json",
      ".kiro/steering/rules.md",
      ".kiro/settings/mcp.json",
      ".kiro/hooks/on-save.json",
      ".kiro/scripts/install.sh",
    ];

    for (const path of paths) {
      const component = componentInput("skill:tdd-workflow", [
        {
          path,
          contents: SKILL_BODY,
        },
      ]);
      expect(() => previewEccMaterialization(request(component)), path).toThrow(
        /future verified-source Kiro adapter/i,
      );
      expect(() => applyEccMaterialization(request(component)), path).toThrow(
        /future verified-source Kiro adapter/i,
      );
    }
    expect(tree()).toEqual([]);
  });

  it("refuses cross-component Kiro claims before any generic preview or apply", () => {
    const component = componentInput("skill:tdd-workflow", [
      {
        path: ".kiro/skills/other/SKILL.md",
        contents: SKILL_BODY,
      },
    ]);

    expect(() => previewEccMaterialization(request(component))).toThrow(
      /future verified-source Kiro adapter/i,
    );
    expect(tree()).toEqual([]);
  });

  it("fails closed when selected authorization and component provenance diverge", () => {
    const cases: Array<[string, EccMaterializationComponentInput]> = [
      [
        "selected component",
        {
          ...componentInput("skill:tdd-workflow", [{ path: SKILL_PATH, contents: SKILL_BODY }]),
          authorization: authorization("skill:verification-loop"),
        },
      ],
      [
        "provenance repository",
        {
          ...componentInput("skill:tdd-workflow", [{ path: SKILL_PATH, contents: SKILL_BODY }]),
          provenance: { ...provenanceForTest(), repository: "other/ECC" },
        },
      ],
      [
        "provenance pin",
        {
          ...componentInput("skill:tdd-workflow", [{ path: SKILL_PATH, contents: SKILL_BODY }]),
          provenance: { ...provenanceForTest(), commit: "d".repeat(40) },
        },
      ],
    ];

    for (const [label, component] of cases) {
      expect(() => previewEccMaterialization(request(component)), label).toThrow(
        /materialization receipt evidence binding/i,
      );
    }
    expect(tree()).toEqual([]);
  });

  it("keeps apply atomic: a failed rename leaves no partial content and no ownership claim", () => {
    expect(() =>
      applyEccMaterialization(request(skillComponent()), {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    ).toThrow(/injected rename failure/);

    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
    expect(tree().filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("is deterministic on a second apply: nothing rewritten, bytes and receipt identical", () => {
    applyEccMaterialization(request(skillComponent(), settingsComponent()));
    const contentBefore = read(SKILL_PATH);
    const settingsBefore = read(SETTINGS_PATH);
    const receiptBefore = read(ECC_MATERIALIZATION_RECEIPT_PATH);

    const steps: EccMaterializationStep[] = [];
    const second = applyEccMaterialization(request(skillComponent(), settingsComponent()), {
      onStep: (step) => steps.push(step),
    });

    expect(second.written).toEqual([]);
    expect(second.unchanged.map((entry) => entry.path)).toEqual([SKILL_PATH, SETTINGS_PATH]);
    expect(steps).toEqual([]);
    expect(read(SKILL_PATH)).toBe(contentBefore);
    expect(read(SETTINGS_PATH)).toBe(settingsBefore);
    expect(read(ECC_MATERIALIZATION_RECEIPT_PATH)).toBe(receiptBefore);
  });

  it("refuses an existing destination file the receipt does not own", () => {
    put(SKILL_PATH, "# operator's own skill\n");

    expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(/SKILL\.md/);
    expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(/skill:tdd-workflow/);
    expect(read(SKILL_PATH)).toBe("# operator's own skill\n");
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
  });

  it("refuses a merge-json key the receipt does not own and preserves the operator document", () => {
    put(
      SETTINGS_PATH,
      `${JSON.stringify({ statusLine: { type: "command", command: "operator" } }, null, 2)}\n`,
    );
    const before = read(SETTINGS_PATH);

    expect(() => applyEccMaterialization(request(settingsComponent()))).toThrow(/statusLine/);
    expect(() => applyEccMaterialization(request(settingsComponent()))).toThrow(
      /skill:verification-loop/,
    );
    expect(read(SETTINGS_PATH)).toBe(before);
  });

  it("subtracts a component the new selection no longer carries", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));
    expect(existsSync(join(root, AGENT_PATH))).toBe(true);

    const preview = previewEccMaterialization(request(skillComponent()));
    expect(preview.subtract).toEqual([
      {
        componentId: "agent:code-reviewer",
        path: AGENT_PATH,
        operation: "copy-file",
        action: "remove",
      },
    ]);
    expect(preview.advisories).toEqual([]);
    expect(existsSync(join(root, AGENT_PATH))).toBe(true);

    const result = applyEccMaterialization(request(skillComponent()));

    expect(result.removed.map((entry) => entry.path)).toEqual([AGENT_PATH]);
    expect(existsSync(join(root, AGENT_PATH))).toBe(false);
    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
  });

  it("plans receipt-only subtraction for one component without source bytes", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));

    const operation = planEccComponentSubtraction(root, ["agent:code-reviewer"]);

    expect(operation.subtract.map(({ componentId, path }) => ({ componentId, path }))).toEqual([
      { componentId: "agent:code-reviewer", path: AGENT_PATH },
    ]);
    expect(operation.components.map(({ id }) => id)).toEqual(["skill:tdd-workflow"]);
    expect(operation.steps.at(-1)?.phase).toBe("receipt");
    expect(read(AGENT_PATH)).toBe(AGENT_BODY);
  });

  it("subtracts an owned file a still-selected component no longer carries", () => {
    const before = componentInput("skill:tdd-workflow", [
      { path: SKILL_PATH, contents: SKILL_BODY },
      { path: ".claude/skills/tdd-workflow/REFERENCE.md", contents: "# reference\n" },
    ]);
    applyEccMaterialization(request(before));

    const result = applyEccMaterialization(request(skillComponent()));

    expect(result.removed.map((entry) => entry.path)).toEqual([
      ".claude/skills/tdd-workflow/REFERENCE.md",
    ]);
    expect(existsSync(join(root, ".claude/skills/tdd-workflow/REFERENCE.md"))).toBe(false);
    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(ownedReceipt().components[0]?.files.map((file) => file.path)).toEqual([SKILL_PATH]);
  });

  it("folds two components merging disjoint keys into one destination", () => {
    const other = componentInput("skill:strategic-compact", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ env: { AIH: "1" } }) },
    ]);

    applyEccMaterialization(request(settingsComponent(), other));

    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({
      env: { AIH: "1" },
      statusLine: { type: "command", command: "aih status" },
    });

    const second = applyEccMaterialization(request(settingsComponent(), other));
    expect(second.written).toEqual([]);

    uninstallEccMaterialization(root);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);
  });

  it("uninstalls every owned component, removing only matching owned bytes", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));
    const ledger: EccMaterializationLedgerUpdate[] = [];

    const result = uninstallEccMaterialization(root, {
      onLedgerUpdate: (update) => ledger.push(update),
    });

    expect(result.removed.map((entry) => entry.path)).toEqual([AGENT_PATH, SKILL_PATH]);
    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
    expect(existsSync(join(root, AGENT_PATH))).toBe(false);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
    expect(ledger).toEqual([{ root: expect.any(String), components: [] }]);
  });

  it("orders owned content before the ownership record and rolls back a failed boundary", () => {
    applyEccMaterialization(request(skillComponent()));
    const receiptBefore = read(ECC_MATERIALIZATION_RECEIPT_PATH);
    const steps: EccMaterializationStep[] = [];

    expect(() =>
      uninstallEccMaterialization(root, {
        onStep: (step) => {
          steps.push(step);
          if (step.phase === "receipt") throw new Error("injected crash at the record boundary");
        },
      }),
    ).toThrow(/injected crash/);

    // Owned content is always stepped before the ownership record...
    expect(steps.map((step) => `${step.phase}:${step.kind}`)).toEqual([
      "content:remove",
      "receipt:remove",
    ]);
    // ...and failing at that boundary orphans nothing in either direction: the
    // content step is rolled back, so the record still describes exactly what
    // is on disk.
    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(read(ECC_MATERIALIZATION_RECEIPT_PATH)).toBe(receiptBefore);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
  });

  it("degrades a drifted owned file to an advisory and never deletes it", () => {
    applyEccMaterialization(request(skillComponent()));
    put(SKILL_PATH, `${SKILL_BODY}operator edit\n`);

    // Preview reports the same verdict before anything is touched.
    const preview = previewEccMaterialization({ root, components: [] });
    expect(preview.subtract).toEqual([]);
    expect(preview.advisories).toEqual([
      {
        componentId: "skill:tdd-workflow",
        path: SKILL_PATH,
        reason: "drifted",
        detail: expect.stringContaining(SKILL_PATH),
      },
    ]);

    const result = uninstallEccMaterialization(root);

    expect(result.removed).toEqual([]);
    expect(result.advisories).toEqual([
      {
        componentId: "skill:tdd-workflow",
        path: SKILL_PATH,
        reason: "drifted",
        detail: expect.stringContaining(SKILL_PATH),
      },
    ]);
    expect(read(SKILL_PATH)).toBe(`${SKILL_BODY}operator edit\n`);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
  });

  it("reports an already-absent owned file as an advisory and replays nothing", () => {
    applyEccMaterialization(request(skillComponent()));
    rmSync(join(root, SKILL_PATH));

    const result = uninstallEccMaterialization(root);

    expect(result.advisories.map((advisory) => advisory.reason)).toEqual(["missing"]);
    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
  });

  /**
   * The honest statement of what merge-json preserves. The operator's document
   * is written in AIH's own canonical form (2-space, trailing newline), so a
   * differently formatted operator file does NOT survive byte-for-byte — this
   * fixture is deliberately 4-space indented so the test states that instead of
   * hiding it behind AIH's own formatter. What IS preserved byte-for-byte is
   * every operator key, its value, and its position.
   */
  it("subtracts owned merge-json keys, preserving operator content but not its formatting", () => {
    const operatorFormatted = `${JSON.stringify(
      { model: "operator-choice", permissions: { allow: ["Bash(ls:*)"] } },
      null,
      4,
    )}\n`;
    put(SETTINGS_PATH, operatorFormatted);

    applyEccMaterialization(request(settingsComponent()));
    const merged = JSON.parse(read(SETTINGS_PATH));
    expect(merged.statusLine).toEqual({ type: "command", command: "aih status" });
    expect(merged.model).toBe("operator-choice");

    uninstallEccMaterialization(root);

    const after = readFileSync(join(root, SETTINGS_PATH));
    // Values and key order: identical. Bytes: normalized, and this asserts it.
    expect(JSON.parse(after.toString("utf8"))).toEqual(JSON.parse(operatorFormatted));
    expect(Object.keys(JSON.parse(after.toString("utf8")))).toEqual(["model", "permissions"]);
    expect(after.equals(Buffer.from(operatorFormatted, "utf8"))).toBe(false);
    expect(after.toString("utf8")).toBe(OPERATOR_SETTINGS);
  });

  it("keeps a canonically formatted operator document byte-identical across apply and uninstall", () => {
    put(SETTINGS_PATH, OPERATOR_SETTINGS);
    const before = readFileSync(join(root, SETTINGS_PATH));

    applyEccMaterialization(request(settingsComponent()));
    uninstallEccMaterialization(root);

    expect(readFileSync(join(root, SETTINGS_PATH)).equals(before)).toBe(true);
  });

  it("refuses a JSONC destination outright rather than silently dropping its comments", () => {
    put(SETTINGS_PATH, '{\n  // operator note\n  "model": "operator-choice"\n}\n');
    const before = readFileSync(join(root, SETTINGS_PATH));

    expect(() => applyEccMaterialization(request(settingsComponent()))).toThrow(/JSON object/i);
    expect(readFileSync(join(root, SETTINGS_PATH)).equals(before)).toBe(true);
  });

  it("removes a merge-json destination only when AIH created it and owns its sole content", () => {
    applyEccMaterialization(request(settingsComponent()));
    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({
      statusLine: { type: "command", command: "aih status" },
    });

    uninstallEccMaterialization(root);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);

    applyEccMaterialization(request(settingsComponent()));
    put(
      SETTINGS_PATH,
      `${JSON.stringify(
        { ...JSON.parse(read(SETTINGS_PATH)), model: "operator-choice" },
        null,
        2,
      )}\n`,
    );

    uninstallEccMaterialization(root);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(true);
    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({ model: "operator-choice" });
  });

  it("keeps a pre-existing merge-json destination even when subtraction empties it", () => {
    put(SETTINGS_PATH, `${JSON.stringify({}, null, 2)}\n`);
    applyEccMaterialization(request(settingsComponent()));

    uninstallEccMaterialization(root);

    expect(existsSync(join(root, SETTINGS_PATH))).toBe(true);
    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({});
  });

  it("repairs only owned files whose live bytes still match the receipt", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));
    rmSync(join(root, SKILL_PATH));
    put(AGENT_PATH, `${AGENT_BODY}operator edit\n`);

    const result = repairEccMaterialization(request(skillComponent(), agentComponent()));

    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(read(AGENT_PATH)).toBe(`${AGENT_BODY}operator edit\n`);
    expect(result.written.map((entry) => entry.path)).toEqual([SKILL_PATH]);
    expect(result.advisories).toEqual([
      {
        componentId: "agent:code-reviewer",
        path: AGENT_PATH,
        reason: "drifted",
        detail: expect.stringContaining(AGENT_PATH),
      },
    ]);
  });

  it("fails closed on a malformed receipt: no ownership claim, no delete, removal is advisory", () => {
    applyEccMaterialization(request(skillComponent()));
    const owned = read(SKILL_PATH);
    put(ECC_MATERIALIZATION_RECEIPT_PATH, "{ not a receipt");

    expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(
      /materialization receipt/i,
    );
    expect(() => previewEccMaterialization(request(skillComponent()))).toThrow(
      /materialization receipt/i,
    );
    expect(() => repairEccMaterialization(request(skillComponent()))).toThrow(
      /materialization receipt/i,
    );

    const result = uninstallEccMaterialization(root);
    expect(result.removed).toEqual([]);
    expect(result.advisories.map((advisory) => advisory.reason)).toEqual(["malformed-receipt"]);
    expect(read(SKILL_PATH)).toBe(owned);
    expect(read(ECC_MATERIALIZATION_RECEIPT_PATH)).toBe("{ not a receipt");
  });

  it("refuses traversal, absolute, and AIH-state destination paths by name", () => {
    const cases: Array<[string, RegExp]> = [
      ["../escape.md", /unsafe ECC materialization destination/i],
      ["/absolute.md", /unsafe ECC materialization destination/i],
      ["C:/absolute.md", /unsafe ECC materialization destination/i],
      [".aih/stolen.json", /AIH's own state area/i],
      [".aih-config.json", /AIH's own state area/i],
      [".git/hooks/pre-commit", /git/i],
    ];
    for (const [path, message] of cases) {
      expect(
        () =>
          applyEccMaterialization(
            request(componentInput("skill:tdd-workflow", [{ path, contents: SKILL_BODY }])),
          ),
        path,
      ).toThrow(message);
    }
    // `tree()` only walks inside the root, so assert the escape target directly.
    expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
    expect(tree()).toEqual([]);
  });

  it.skipIf(!canSymlink())(
    "refuses a symlinked destination segment instead of writing through it",
    () => {
      const outside = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-outside-"));
      try {
        symlinkSync(
          outside,
          join(root, ".claude"),
          process.platform === "win32" ? "junction" : "dir",
        );
        expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(/symlink/i);
        expect(readdirSync(outside)).toEqual([]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it("never re-inserts JSON keys the same apply just subtracted", () => {
    const alpha = componentInput("skill:aaa-first", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ alpha: 1 }) },
    ]);
    const beta = componentInput("skill:bbb-second", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ beta: 2 }) },
    ]);
    applyEccMaterialization(request(alpha));

    applyEccMaterialization(request(beta));

    // The subtraction of `alpha` and the write of `beta` are one ordered pass:
    // the merge base is what subtraction left, not the pre-subtraction bytes.
    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({ beta: 2 });
    expect(ownedReceipt().components.flatMap((component) => component.files)).toEqual([
      expect.objectContaining({ path: SETTINGS_PATH, ownedKeys: ["beta"] }),
    ]);

    uninstallEccMaterialization(root);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);
  });

  it("validates the whole ownership record before the first byte is written", () => {
    const polluting = componentInput("skill:tdd-workflow", [
      { path: SKILL_PATH, contents: SKILL_BODY },
      {
        path: SETTINGS_PATH,
        kind: "merge-json",
        contents: JSON.stringify({ ["__proto__"]: { polluted: true } }),
      },
    ]);
    // Refused at the input boundary now that keys are validated there; either
    // way it must be refused BEFORE any content is written.
    expect(() => applyEccMaterialization(request(polluting))).toThrow(/JSON key/i);
    expect(tree()).toEqual([]);

    const tooManyKeys = componentInput("skill:tdd-workflow", [
      {
        path: SETTINGS_PATH,
        kind: "merge-json",
        contents: JSON.stringify(
          Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`key${index}`, index])),
        ),
      },
    ]);
    expect(() => applyEccMaterialization(request(tooManyKeys))).toThrow(
      /invalid ECC materialization receipt/i,
    );
    expect(tree()).toEqual([]);

    const badProvenance = {
      ...skillComponent(),
      provenance: { repository: "affaan-m/ECC", commit: "not-a-commit", componentPath: "skills/x" },
    };
    expect(() => applyEccMaterialization(request(badProvenance))).toThrow(
      /invalid ECC materialization receipt/i,
    );
    expect(tree()).toEqual([]);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
  });

  it("refuses one destination claimed as both a whole file and a JSON merge", () => {
    const whole = componentInput("skill:tdd-workflow", [
      { path: SETTINGS_PATH, contents: '{"a":1}\n' },
    ]);
    const merge = componentInput("skill:verification-loop", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ b: 2 }) },
    ]);

    expect(() => applyEccMaterialization(request(whole, merge))).toThrow(
      /copy-file and merge-json/i,
    );
    expect(tree()).toEqual([]);
  });

  it("refuses a receipt that would exceed its own read cap", () => {
    const longSegment = "s".repeat(190);
    const components = Array.from({ length: 9 }, (_, componentIndex) =>
      componentInput(`skill:bulk-${componentIndex}`, [
        ...Array.from({ length: 2_048 }, (_, fileIndex) => ({
          path: `.claude/skills/${longSegment}/${longSegment}/${longSegment}/${longSegment}/${longSegment}/f${componentIndex}-${fileIndex}.md`,
          contents: "x",
        })),
      ]),
    );

    expect(() => applyEccMaterialization(request(...components))).toThrow(/receipt|exceed/i);
    expect(tree()).toEqual([]);
  });

  it("reports an unreadable owned destination as an advisory and subtracts the rest", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));
    // Oversized past the engine's own read bound: portable, and exactly what a
    // planted hard link or a grown file does to every later operation.
    writeFileSync(join(root, SKILL_PATH), Buffer.alloc(5 * 1024 * 1024, 0x61));

    const result = uninstallEccMaterialization(root);

    expect(result.removed.map((entry) => entry.path)).toEqual([AGENT_PATH]);
    expect(existsSync(join(root, AGENT_PATH))).toBe(false);
    expect(result.advisories).toEqual([
      {
        componentId: "skill:tdd-workflow",
        path: SKILL_PATH,
        reason: "unreadable",
        detail: expect.stringContaining(SKILL_PATH),
      },
    ]);
    expect(existsSync(join(root, SKILL_PATH))).toBe(true);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
  });

  it("refuses a merge whose result would exceed the readable size bound", () => {
    const huge = componentInput("skill:verification-loop", [
      {
        path: SETTINGS_PATH,
        kind: "merge-json",
        contents: JSON.stringify({ blob: "z".repeat(5 * 1024 * 1024) }),
      },
    ]);

    expect(() => applyEccMaterialization(request(huge))).toThrow(/bound|exceed|bytes/i);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);
  });

  it("subtracts an owned JSON key the component no longer carries", () => {
    const both = componentInput("skill:verification-loop", [
      {
        path: SETTINGS_PATH,
        kind: "merge-json",
        contents: JSON.stringify({ statusLine: { type: "command" }, env: { AIH: "1" } }),
      },
    ]);
    applyEccMaterialization(request(both));

    applyEccMaterialization(
      request(
        componentInput("skill:verification-loop", [
          {
            path: SETTINGS_PATH,
            kind: "merge-json",
            contents: JSON.stringify({ statusLine: { type: "command" } }),
          },
        ]),
      ),
    );

    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({ statusLine: { type: "command" } });
    expect(ownedReceipt().components[0]?.files).toEqual([
      expect.objectContaining({ ownedKeys: ["statusLine"] }),
    ]);
  });

  it("re-pins every destination at commit and rolls back when one changed", () => {
    applyEccMaterialization(request(skillComponent(), agentComponent()));
    const receiptBefore = read(ECC_MATERIALIZATION_RECEIPT_PATH);

    expect(() =>
      uninstallEccMaterialization(root, {
        onStep: (step) => {
          // The window the peer closes: something touches the destination
          // between the plan-time hash and the commit.
          if (step.path === SKILL_PATH) put(SKILL_PATH, `${SKILL_BODY}late operator edit\n`);
        },
      }),
    ).toThrow(/changed before commit/i);

    expect(read(SKILL_PATH)).toBe(`${SKILL_BODY}late operator edit\n`);
    expect(read(AGENT_PATH)).toBe(AGENT_BODY);
    expect(read(ECC_MATERIALIZATION_RECEIPT_PATH)).toBe(receiptBefore);
  });

  it("rolls back the writes it already made when a later write fails", () => {
    let renames = 0;
    expect(() =>
      applyEccMaterialization(request(skillComponent(), agentComponent()), {
        rename: (from, to) => {
          renames += 1;
          if (renames > 1) throw new Error("injected rename failure");
          renameSync(from, to);
        },
      }),
    ).toThrow(/injected rename failure/);

    expect(existsSync(join(root, AGENT_PATH))).toBe(false);
    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
  });

  it("refuses a repair whose request operation contradicts the receipt", () => {
    applyEccMaterialization(request(settingsComponent()));
    rmSync(join(root, SETTINGS_PATH));

    const contradicting = componentInput("skill:verification-loop", [
      { path: SETTINGS_PATH, contents: OWNED_FRAGMENT },
    ]);

    expect(() => repairEccMaterialization(request(contradicting))).toThrow(/contradict/i);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);
  });

  it("repairs a merge-json destination shared by two components in one document", () => {
    const other = componentInput("skill:strategic-compact", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ env: { AIH: "1" } }) },
    ]);
    applyEccMaterialization(request(settingsComponent(), other));
    rmSync(join(root, SETTINGS_PATH));

    const result = repairEccMaterialization(request(settingsComponent(), other));

    expect(JSON.parse(read(SETTINGS_PATH))).toEqual({
      env: { AIH: "1" },
      statusLine: { type: "command", command: "aih status" },
    });
    expect(result.advisories).toEqual([]);
  });

  it("removes a shared merge-json destination AIH created even when a component joined later", () => {
    applyEccMaterialization(request(settingsComponent()));
    const joiner = componentInput("skill:strategic-compact", [
      { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ env: { AIH: "1" } }) },
    ]);
    applyEccMaterialization(request(settingsComponent(), joiner));

    uninstallEccMaterialization(root);

    expect(existsSync(join(root, SETTINGS_PATH))).toBe(false);
  });

  it("degrades a pathologically nested owned value to an advisory, not a crash", () => {
    applyEccMaterialization(request(settingsComponent()));
    // Built as text: a value this deep cannot be produced with JSON.stringify,
    // which is itself the reason the engine must not recurse over it blindly.
    const nested = `${'{"n":'.repeat(500)}1${"}".repeat(500)}`;
    put(SETTINGS_PATH, `{"statusLine":${nested}}\n`);

    const result = uninstallEccMaterialization(root);

    expect(result.advisories.map((advisory) => advisory.reason)).toEqual(["drifted"]);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(true);
  });

  it("refuses every contradictory request shape by name", () => {
    const cases: Array<[string, EccMaterializationComponentInput[], RegExp]> = [
      [
        "same component twice",
        [skillComponent(), skillComponent()],
        /duplicate ECC materialization component/i,
      ],
      [
        "same destination twice inside one component",
        [
          componentInput("skill:tdd-workflow", [
            { path: SKILL_PATH, contents: SKILL_BODY },
            { path: SKILL_PATH.toUpperCase(), contents: SKILL_BODY },
          ]),
        ],
        /duplicate ECC materialization destination/i,
      ],
      [
        "one destination claimed by two components",
        [
          skillComponent(),
          componentInput("skill:verification-loop", [{ path: SKILL_PATH, contents: SKILL_BODY }]),
        ],
        /claimed by two components/i,
      ],
      [
        "one JSON key claimed by two components",
        [
          settingsComponent(),
          componentInput("skill:strategic-compact", [
            { path: SETTINGS_PATH, kind: "merge-json", contents: OWNED_FRAGMENT },
          ]),
        ],
        /JSON key is claimed by two components/i,
      ],
      [
        "a merge that owns no keys",
        [
          componentInput("skill:verification-loop", [
            { path: SETTINGS_PATH, kind: "merge-json", contents: "{}" },
          ]),
        ],
        /owns no keys/i,
      ],
      [
        "a merge fragment that is not a JSON object",
        [
          componentInput("skill:verification-loop", [
            { path: SETTINGS_PATH, kind: "merge-json", contents: "[1,2,3]" },
          ]),
        ],
        /not a JSON object/i,
      ],
      [
        "a component with no files at all",
        [{ ...skillComponent(), files: [] }],
        /file count is outside the lifecycle boundary/i,
      ],
      [
        "content beyond the per-file bound",
        [
          componentInput("skill:tdd-workflow", [
            { path: SKILL_PATH, contents: "x".repeat(5 * 1024 * 1024) },
          ]),
        ],
        /bytes exceed the lifecycle boundary/i,
      ],
    ];

    for (const [label, components, message] of cases) {
      expect(() => applyEccMaterialization({ root, components }), label).toThrow(message);
    }
    expect(tree()).toEqual([]);
  });

  it("refuses a reserved directory named in any segment, not just the first", () => {
    mkdirSync(join(root, "vendor", "libfoo", ".git", "hooks"), { recursive: true });

    for (const [path, message] of [
      ["vendor/libfoo/.git/hooks/post-checkout", /git/i],
      ["sub/.aih/state.json", /AIH's own state area/i],
      ["nested/deep/.AIH-config.json", /AIH's own state area/i],
    ] as Array<[string, RegExp]>) {
      expect(
        () =>
          applyEccMaterialization(
            request(componentInput("skill:tdd-workflow", [{ path, contents: "payload\n" }])),
          ),
        path,
      ).toThrow(message);
    }
    expect(existsSync(join(root, "vendor", "libfoo", ".git", "hooks", "post-checkout"))).toBe(
      false,
    );
  });

  it.skipIf(shortNameAlias(".git") === undefined)(
    "refuses a reserved directory reached through a filesystem alias",
    () => {
      const alias = shortNameAlias(".git");
      if (alias === undefined) throw new Error("expected a short-name alias");
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });

      // The requested string is not reserved; what the OS resolves it to is.
      expect(() =>
        applyEccMaterialization(
          request(
            componentInput("skill:tdd-workflow", [
              { path: `${alias}/hooks/pre-commit`, contents: "#!/bin/sh\necho owned\n" },
            ]),
          ),
        ),
      ).toThrow(/git|reserved|AIH/i);
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
    },
  );

  it("degrades a deep operator value to an advisory instead of throwing out of every operation", () => {
    put(SETTINGS_PATH, OPERATOR_SETTINGS);
    applyEccMaterialization(request(settingsComponent()));
    // Deeper than JSON.stringify survives, shallower than JSON.parse refuses:
    // the parse gate opens and the render gate is where it detonates. The owned
    // fragment is byte-identical, so subtraction is authorised.
    const nested = `${'{"n":'.repeat(20_000)}1${"}".repeat(20_000)}`;
    put(
      SETTINGS_PATH,
      `{"model":"operator-choice","statusLine":{"type":"command","command":"aih status"},"deep":${nested}}\n`,
    );

    expect(() => previewEccMaterialization(request(settingsComponent()))).toThrow(/nest|depth/i);
    expect(() => applyEccMaterialization(request(settingsComponent()))).toThrow(/nest|depth/i);

    const result = uninstallEccMaterialization(root);
    expect(result.advisories.map((advisory) => advisory.reason)).toEqual(["unreadable"]);
    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, SETTINGS_PATH))).toBe(true);
  });

  it("bounds the ownership record by the same reader that has to read it back", () => {
    expect(MAX_MATERIALIZATION_RECEIPT_BYTES).toBe(MAX_MATERIALIZED_FILE_BYTES);

    // A record between the two former bounds: valid, written, and then
    // unreadable — every later operation threw, permanently.
    const longSegment = "s".repeat(190);
    const components = Array.from({ length: 5 }, (_, componentIndex) =>
      componentInput(`skill:mid-${componentIndex}`, [
        ...Array.from({ length: 1_024 }, (_, fileIndex) => ({
          path: `.claude/skills/${longSegment}/${longSegment}/${longSegment}/${longSegment}/${longSegment}/f${componentIndex}-${fileIndex}.md`,
          contents: "x",
        })),
      ]),
    );

    expect(() => applyEccMaterialization(request(...components))).toThrow(/exceed/i);
    expect(tree()).toEqual([]);
  });

  it("never destroys content that appeared at a path between a step and its rollback", () => {
    let renames = 0;
    let hijacked = false;

    expect(() =>
      applyEccMaterialization(request(agentComponent(), skillComponent()), {
        rename: (from, to) => {
          renames += 1;
          if (renames > 1) throw new Error("injected rename failure");
          renameSync(from, to);
        },
        onStep: (step) => {
          // A concurrent writer takes the path AIH just created, inside the
          // announce window this module documents as caller-observable.
          if (step.path !== SKILL_PATH || hijacked) return;
          hijacked = true;
          put(AGENT_PATH, "operator took this path\n");
        },
      }),
    ).toThrow(/injected rename failure/);

    // Rollback re-pins: it restores or removes only what its own step left.
    expect(read(AGENT_PATH)).toBe("operator took this path\n");
    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
  });

  it("reports what a rollback could not restore instead of swallowing it", () => {
    let renames = 0;
    let hijacked = false;

    try {
      applyEccMaterialization(request(agentComponent(), skillComponent()), {
        rename: (from, to) => {
          renames += 1;
          if (renames > 1) throw new Error("injected rename failure");
          renameSync(from, to);
        },
        onStep: (step) => {
          if (step.path !== SKILL_PATH || hijacked) return;
          hijacked = true;
          put(AGENT_PATH, "operator took this path\n");
        },
      });
      throw new Error("expected the apply to fail");
    } catch (error) {
      expect((error as Error).message).toMatch(/injected rename failure/);
      expect((error as Error).message).toMatch(/rollback/i);
      expect((error as Error).message).toContain(AGENT_PATH);
    }
  });

  it("neutralises and bounds hostile identifiers before they reach an operator message", () => {
    const hostileKey = "ok\u001b[2J\u0007installed";
    let message = "";
    try {
      applyEccMaterialization(
        request(
          componentInput("skill:verification-loop", [
            {
              path: SETTINGS_PATH,
              kind: "merge-json",
              contents: JSON.stringify({ [hostileKey]: 1 }),
            },
          ]),
        ),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone is the point
    expect(/[\u0000-\u001f\u007f]/.test(message)).toBe(false);

    let longMessage = "";
    try {
      applyEccMaterialization({
        root,
        components: [
          {
            ...skillComponent(),
            id: `skill:${"x".repeat(200_000)}` as EccComponentId,
          },
        ],
      });
    } catch (error) {
      longMessage = (error as Error).message;
    }
    expect(longMessage.length).toBeGreaterThan(0);
    expect(longMessage.length).toBeLessThan(1_000);
    expect(tree()).toEqual([]);
  });

  it.skipIf(caseSensitiveVolume())(
    "treats case-folded spellings of one destination as one destination",
    () => {
      const alpha = componentInput("skill:aaa-first", [
        { path: SETTINGS_PATH, kind: "merge-json", contents: JSON.stringify({ alpha: 1 }) },
      ]);
      const beta = componentInput("skill:bbb-second", [
        {
          path: ".claude/Settings.json",
          kind: "merge-json",
          contents: JSON.stringify({ beta: 2 }),
        },
      ]);
      applyEccMaterialization(request(alpha));

      applyEccMaterialization(request(beta));

      expect(JSON.parse(read(SETTINGS_PATH))).toEqual({ beta: 2 });
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the operator's file mode through a merge and through a rollback",
    () => {
      const settings = (command: string) =>
        componentInput("skill:aaa-settings", [
          {
            path: SETTINGS_PATH,
            kind: "merge-json",
            contents: JSON.stringify({ statusLine: { type: "command", command } }),
          },
        ]);
      put(SETTINGS_PATH, OPERATOR_SETTINGS);
      chmodSync(join(root, SETTINGS_PATH), 0o600);

      applyEccMaterialization(request(settings("aih status")));
      // The forward path must not widen an operator's permissions either.
      expect(lstatSync(join(root, SETTINGS_PATH)).mode & 0o777).toBe(0o600);

      let renames = 0;
      expect(() =>
        applyEccMaterialization(request(settings("aih status --json"), agentComponent()), {
          rename: (from, to) => {
            renames += 1;
            if (renames > 1) throw new Error("injected rename failure");
            renameSync(from, to);
          },
        }),
      ).toThrow(/injected rename failure/);

      expect(read(SETTINGS_PATH)).toContain("aih status");
      expect(lstatSync(join(root, SETTINGS_PATH)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!canObserveInaccessiblePath())(
    "fails closed when a path segment cannot be inspected at all",
    () => {
      mkdirSync(join(root, ".claude"), { recursive: true });
      chmodSync(join(root, ".claude"), 0o000);
      try {
        expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(
          /inaccessible|refusing/i,
        );
        expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
      } finally {
        chmodSync(join(root, ".claude"), 0o700);
      }
    },
  );

  it("carries the destination's existing mode into the step that may have to restore it", () => {
    put(SETTINGS_PATH, OPERATOR_SETTINGS);

    const plan = planEccMaterialization(request(settingsComponent()));
    const step = plan.steps.find((candidate) => candidate.path === SETTINGS_PATH);

    expect(step?.prior).toBeDefined();
    // Without this the rollback restores at the engine's default and silently
    // widens an operator's permissions; the type is what keeps it plumbed.
    expect(step?.priorMode).toBeGreaterThan(0);
  });

  it("refuses a reserved directory it would have to create", () => {
    expect(() =>
      writeDestinationAtomic(root, ".git/hooks/pre-commit", Buffer.from("payload\n"), 0o644),
    ).toThrow(/git/i);
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("refuses a destination root that is not an absolute real directory", () => {
    expect(() =>
      applyEccMaterialization({ root: "relative/root", components: [skillComponent()] }),
    ).toThrow(/absolute/i);
    expect(() =>
      applyEccMaterialization({ root: join(root, "missing"), components: [skillComponent()] }),
    ).toThrow(/directory/i);
  });
});

describe("the filesystem boundary's own preconditions", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("refuses to load at all without the native realpath binding", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    // The JS implementation leaves an NTFS 8.3 short name as it found it, so
    // every reserved-name check downstream would compare the wrong string.
    // Silently falling back to it reopens the class the guard exists to close.
    const withoutNative: typeof actual = {
      ...actual,
      realpathSync: ((path: string) => actual.realpathSync(path)) as typeof actual.realpathSync,
    };
    vi.resetModules();
    vi.doMock("node:fs", () => ({ ...withoutNative, default: withoutNative }));

    await expect(import("../../src/ecc/materialization-fs.js")).rejects.toThrow(/native/i);
  });
});
