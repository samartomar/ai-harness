import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import {
  applyEccMaterialization,
  eccMaterializationReceiptPath,
} from "../../src/ecc/materialization.js";
import { ECC_MATERIALIZATION_RECEIPT_PATH } from "../../src/ecc/materialization-receipt.js";
import { resolveEccClaudeMaterialization } from "../../src/ecc/materialization-target-claude.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";

/**
 * F6: governed materialization removal composes into the top-level
 * `aih uninstall` as a receipt-proven member, on the hook-registrar precedent —
 * subtract exactly what the receipt proves AIH wrote, preserve everything else,
 * and refuse by name when the receipt cannot prove clean ownership.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

const SOURCE_TREE: Readonly<Record<string, string>> = {
  "agents/code-reviewer.md": "# code-reviewer\n",
  "rules/README.md": "# rules\n",
  "rules/common/coding-style.md": "# coding style\n",
};

/** Operator content, including files INSIDE directories AIH writes into. */
const OPERATOR_TREE: Readonly<Record<string, string>> = {
  ".claude/settings.json": '{\n    "env": {"OPERATOR": "1"}\n}\n',
  ".claude/agents/operator-agent.md": "# my own agent\n",
  ".claude/rules/OPERATOR-NOTES.md": "# my notes\n",
  "notes/OPERATOR.md": "# keep me\n",
};

const MATERIALIZED = [
  ".claude/agents/code-reviewer.md",
  ".claude/rules/README.md",
  ".claude/rules/common/coding-style.md",
] as const;

let root: string;
let sourceRoot: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-uninstall-materialization-source-"));
  writeTree(sourceRoot, SOURCE_TREE);
  root = mkdtempSync(join(tmpdir(), "aih-uninstall-materialization-root-"));
  writeTree(root, OPERATOR_TREE);
});
afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeTree(base: string, tree: Readonly<Record<string, string>>): void {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(base, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function context(apply: boolean): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
  };
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

/** Materialize through the engine, exactly as the governed install does. */
function materialize(): void {
  const target = resolveEccClaudeMaterialization({
    sourceRoot,
    components: [
      { id: "agent:code-reviewer", path: "agents/code-reviewer.md" },
      { id: "baseline:rules", path: "rules" },
    ].map((component) => ({
      id: component.id as "agent:code-reviewer",
      authorization: authorization(component.id),
      provenance: { repository: REPOSITORY, commit: COMMIT, componentPath: component.path },
    })),
  });
  expect(target.refused).toEqual([]);
  const applied = applyEccMaterialization({ root, components: target.components });
  expect(applied.written).toHaveLength(MATERIALIZED.length);
}

async function uninstall(apply: boolean): Promise<Awaited<ReturnType<typeof executePlan>>> {
  const ctx = context(apply);
  return executePlan(await uninstallCommand.plan(ctx), ctx, { skipWorktreeGate: true });
}

/**
 * The ONE digest row that names `path`. A substring check against the whole
 * digest passes on a row belonging to some other artifact entirely.
 */
function digestRowFor(result: Awaited<ReturnType<typeof executePlan>>, path: string): string {
  const digest = result.digests.find((entry) => entry.describe.includes("core install footprint"));
  const rows = (digest?.text ?? "").split("\n").filter((line) => line.includes(path));
  expect(rows, `expected exactly one digest row naming ${path}`).toHaveLength(1);
  return rows[0] ?? "";
}

describe("F6 — `aih uninstall` removes governed ECC materialization receipt-bound", () => {
  it("removes exactly the owned bytes and leaves operator content byte-identical", async () => {
    materialize();
    const operatorBefore = Object.fromEntries(
      Object.keys(OPERATOR_TREE).map((path) => [path, readFileSync(join(root, path))]),
    );

    await uninstall(true);

    for (const path of MATERIALIZED) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    for (const [path, bytes] of Object.entries(operatorBefore)) {
      expect(readFileSync(join(root, path)).equals(bytes), path).toBe(true);
    }
  });

  it("names the receipt-owned materialization in the dry run and removes nothing", async () => {
    materialize();

    const result = await uninstall(false);

    const row = digestRowFor(result, ECC_MATERIALIZATION_RECEIPT_PATH);
    expect(row).toMatch(/\[subtract\]/);
    expect(row).toMatch(/receipt-proven/);
    for (const path of MATERIALIZED) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(true);
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);
  });

  it("refuses by name when the receipt cannot prove ownership, and removes nothing", async () => {
    materialize();
    writeFileSync(eccMaterializationReceiptPath(root), "{ not a receipt\n", "utf8");

    const result = await uninstall(true);

    const row = digestRowFor(result, ECC_MATERIALIZATION_RECEIPT_PATH);
    expect(row).toMatch(/\[advisory\]/);
    expect(row).toMatch(/receipt/);
    // Nothing AIH cannot prove it wrote is removed, and the unreadable record
    // survives for manual remediation.
    for (const path of MATERIALIZED) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(true);
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);
  });

  /**
   * M1: the digest is rendered from what the engine ACTUALLY did, not from the
   * intent captured before it ran. The engine keeps a drifted destination
   * (`materialization-plan.ts:385-388`); a run that printed "operator content is
   * preserved" and exited clean would be telling the operator the opposite of
   * what happened to that file.
   */
  it("reports the drifted file the engine kept, and does not claim it removed it", async () => {
    materialize();
    const drifted = ".claude/rules/README.md";
    writeFileSync(join(root, ...drifted.split("/")), "# operator edited this\n", "utf8");

    const result = await uninstall(true);

    const row = digestRowFor(result, drifted);
    expect(row).toMatch(/\[advisory\]/);
    expect(row).toMatch(/drift/i);
    // The engine kept it, so the bytes AND the operator's edit survive.
    expect(readFileSync(join(root, ...drifted.split("/")), "utf8")).toBe(
      "# operator edited this\n",
    );
    // The two undrifted owned files still went.
    for (const path of MATERIALIZED.filter((entry) => entry !== drifted)) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
    }
    // The receipt row states the real count — two removed, not three — and the
    // receipt survives because it still records ownership of the kept file.
    const receiptRow = digestRowFor(result, ECC_MATERIALIZATION_RECEIPT_PATH);
    expect(receiptRow).toMatch(/removed 2 /);
    expect(receiptRow).not.toMatch(/removed 3 /);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);
  });

  /**
   * M4: the receipt is third-party text. An unbounded zod parse error rendered
   * verbatim turned a 3 MB hostile receipt into a multi-megabyte refusal; every
   * peer string in this family goes through `displaySafe`.
   */
  it("bounds the advisory detail when a hostile receipt produces a huge parse error", async () => {
    materialize();
    const hostile: Record<string, unknown> = { format: "aih-ecc-materialization-receipt" };
    for (let index = 0; index < 5_000; index += 1) {
      hostile[`unrecognized-key-${index}-${"p".repeat(200)}`] = index;
    }
    writeFileSync(eccMaterializationReceiptPath(root), JSON.stringify(hostile), "utf8");

    const result = await uninstall(true);

    // The whole rendered footprint, not one line of it: the raw parse error is
    // 2.3 MB of INDENTED JSON, so a per-row length check would pass on its short
    // first line while the rest forged extra rows inside AIH's own refusal.
    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect((digest?.text ?? "").length).toBeLessThan(5_000);
    const row = digestRowFor(result, ECC_MATERIALIZATION_RECEIPT_PATH);
    expect(row).toMatch(/\[advisory\]/);
    expect(row.length).toBeLessThan(300);
    // Still refuses every claim: nothing was removed.
    for (const path of MATERIALIZED) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(true);
    }
  });

  it("stays silent when no materialization receipt exists at all", async () => {
    const result = await uninstall(true);

    const digest = result.digests.find((entry) =>
      entry.describe.includes("core install footprint"),
    );
    expect(digest?.text).not.toContain(ECC_MATERIALIZATION_RECEIPT_PATH);
  });
});
