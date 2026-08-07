import { createHash } from "node:crypto";
import {
  existsSync,
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
    expect(() => applyEccMaterialization(request(polluting))).toThrow(
      /invalid ECC materialization receipt/i,
    );
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

  it("refuses a destination root that is not an absolute real directory", () => {
    expect(() =>
      applyEccMaterialization({ root: "relative/root", components: [skillComponent()] }),
    ).toThrow(/absolute/i);
    expect(() =>
      applyEccMaterialization({ root: join(root, "missing"), components: [skillComponent()] }),
    ).toThrow(/directory/i);
  });
});
