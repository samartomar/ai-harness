import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  ECC_MATERIALIZATION_RECEIPT_PATH,
  readEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

function componentInput(
  id: EccComponentId,
  files: Array<{ path: string; kind?: "copy-file" | "merge-json"; contents: string }>,
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

    const result = applyEccMaterialization(request(skillComponent()));

    expect(result.removed.map((entry) => entry.path)).toEqual([AGENT_PATH]);
    expect(existsSync(join(root, AGENT_PATH))).toBe(false);
    expect(read(SKILL_PATH)).toBe(SKILL_BODY);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
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

  it("removes owned content before the ownership record, so a crash never orphans a claim", () => {
    applyEccMaterialization(request(skillComponent()));

    expect(() =>
      uninstallEccMaterialization(root, {
        onStep: (step) => {
          if (step.phase === "receipt") throw new Error("injected crash before the record write");
        },
      }),
    ).toThrow(/injected crash/);

    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
    expect(ownedReceipt().components.map((component) => component.id)).toEqual([
      "skill:tdd-workflow",
    ]);
  });

  it("degrades a drifted owned file to an advisory and never deletes it", () => {
    applyEccMaterialization(request(skillComponent()));
    put(SKILL_PATH, `${SKILL_BODY}operator edit\n`);

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

  it("subtracts owned merge-json keys and leaves operator bytes byte-identical", () => {
    put(SETTINGS_PATH, OPERATOR_SETTINGS);
    const before = readFileSync(join(root, SETTINGS_PATH));

    applyEccMaterialization(request(settingsComponent()));
    const merged = JSON.parse(read(SETTINGS_PATH));
    expect(merged.statusLine).toEqual({ type: "command", command: "aih status" });
    expect(merged.model).toBe("operator-choice");

    uninstallEccMaterialization(root);

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

  it("refuses traversal, absolute, and AIH-state destination paths", () => {
    for (const path of ["../escape.md", "/absolute.md", "C:/absolute.md", ".aih/stolen.json"]) {
      expect(
        () =>
          applyEccMaterialization(
            request(componentInput("skill:tdd-workflow", [{ path, contents: SKILL_BODY }])),
          ),
        path,
      ).toThrow();
    }
    expect(tree()).toEqual([]);
  });

  it("refuses a symlinked destination segment instead of writing through it", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-ecc-materialization-outside-"));
    try {
      try {
        symlinkSync(
          outside,
          join(root, ".claude"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch {
        return;
      }
      expect(() => applyEccMaterialization(request(skillComponent()))).toThrow(/symlink/i);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
