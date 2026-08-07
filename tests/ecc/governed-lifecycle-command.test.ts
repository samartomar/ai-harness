import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { walkManagedRoot } from "../../src/ecc/install-manifest.js";
import { eccMaterializationReceiptPath } from "../../src/ecc/materialization.js";
import { executeEccCommand } from "../../src/ecc/pipeline.js";
import type { PlanResult } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { orgPolicyPath } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/**
 * F6: the governed framework lifecycle reached through the shipped command.
 *
 * The acceptance journey (`acceptance-governed-lifecycle.test.ts`) walks the
 * same chain by calling its exported functions directly; this file pins that an
 * OPERATOR reaches it — `aih ecc --lifecycle install` in a governed repository —
 * and that every neighbouring verb keeps the meaning it already had.
 *
 * `executeEccCommand` is driven in process, exactly as the peer command tests
 * do: the live wiring is `deps.execute = executeEccCommand` (src/commands/index.ts),
 * so this is the command path without a child process in it.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

const SOURCE_TREE: Readonly<Record<string, string>> = {
  "agents/code-reviewer.md": "# code-reviewer\n",
  "agents/planner.md": "# planner\n",
  "skills/tdd-workflow/SKILL.md": "# tdd-workflow\n",
  ".agents/skills/tdd-workflow/SKILL.md": "# tdd-workflow (agent copy)\n",
  "rules/README.md": "# rules\n",
  "rules/common/coding-style.md": "# coding style\n",
};

/** Operator content on the destination root, present before anything is applied. */
const OPERATOR_TREE: Readonly<Record<string, string>> = {
  ".claude/settings.json": '{\n    "env": {"OPERATOR": "1"}\n}\n',
  ".claude/agents/operator-agent.md": "# my own agent\n",
  "notes/OPERATOR.md": "# keep me\n",
};

interface SelectionFixture {
  kind: string;
  id: string;
  path: string;
  /** Catalog/evidence paths, which a component may declare more than one of. */
  paths: string[];
}

const PASSED: readonly SelectionFixture[] = [
  {
    kind: "agent",
    id: "agent:code-reviewer",
    path: "agents/code-reviewer.md",
    paths: ["agents/code-reviewer.md"],
  },
  {
    kind: "skill",
    id: "skill:tdd-workflow",
    path: "skills/tdd-workflow",
    paths: [".agents/skills/tdd-workflow", "skills/tdd-workflow"],
  },
  { kind: "baseline", id: "baseline:rules", path: "rules", paths: ["rules"] },
];

/** Selected and blocked by signed evidence: visible, selectable, never materialized. */
const BLOCKED: SelectionFixture = {
  kind: "agent",
  id: "agent:planner",
  path: "agents/planner.md",
  paths: ["agents/planner.md"],
};

/** What must land, and from which source file, once the command applies. */
const MATERIALIZED: ReadonlyArray<{ source: string; destination: string }> = [
  { source: "agents/code-reviewer.md", destination: ".claude/agents/code-reviewer.md" },
  { source: "rules/README.md", destination: ".claude/rules/README.md" },
  { source: "rules/common/coding-style.md", destination: ".claude/rules/common/coding-style.md" },
  {
    source: ".agents/skills/tdd-workflow/SKILL.md",
    destination: ".agents/skills/tdd-workflow/SKILL.md",
  },
  { source: "skills/tdd-workflow/SKILL.md", destination: ".claude/skills/tdd-workflow/SKILL.md" },
];

let root: string;
let sourceRoot: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-governed-lifecycle-source-"));
  writeTree(sourceRoot, SOURCE_TREE);
  root = mkdtempSync(join(tmpdir(), "aih-governed-lifecycle-root-"));
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

function bytesAt(base: string, path: string): Buffer {
  return readFileSync(join(base, ...path.split("/")));
}

/** Every regular file under a root, by path, with its exact bytes. */
function snapshot(base: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const path of walkManagedRoot(base)) entries[path] = bytesAt(base, path).toString("base64");
  return entries;
}

function ctx(apply: boolean, options: Record<string, unknown>): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

function writeGovernedPolicy(selections: readonly SelectionFixture[]): void {
  writeFileSync(
    orgPolicyPath(root, {}),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026-08-07.f6",
          catalog: { reviewed: [], custom: [] },
          externalSelections: [
            {
              framework: "ecc",
              items: selections.map((item) => ({
                kind: item.kind,
                id: item.id,
                source: { repository: REPOSITORY, commit: COMMIT, path: item.path },
              })),
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeUngovernedPolicy(): void {
  writeFileSync(
    orgPolicyPath(root, {}),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: COMMIT,
    components: [...PASSED, BLOCKED].map((item) => ({ id: item.id, paths: item.paths })),
  });
}

function vendorLock() {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: COMMIT,
        components: [...PASSED, BLOCKED].map((item) => ({
          id: item.id,
          paths: item.paths,
          treeSha256: hashComponentTree(sourceRoot, item.paths).treeSha256,
          verdict: item.id === BLOCKED.id ? "blocked" : "pass",
          analyzers: [{ name: "aih-native", version: "2.7.0" }],
          findings:
            item.id === BLOCKED.id ? [{ code: "malicious-code", detail: "blocked by vet" }] : [],
        })),
      },
    ],
  });
}

async function runLifecycle(lifecycle: string, apply: boolean): Promise<PlanResult> {
  return executeEccCommand(ctx(apply, { lifecycle, eccPath: sourceRoot }), {
    catalog: catalog(),
    vendorLock: vendorLock(),
    vendorLockSha256: "f".repeat(64),
    executeProfileLifecycle: async () => {
      throw new Error("the governed install must not fall through to the profile lifecycle");
    },
  });
}

/** The one digest the governed materialization emits, with its machine payload. */
function materializationDigest(result: PlanResult): {
  applied: boolean;
  write: Array<{ componentId: string; path: string }>;
  excluded: Array<{ id: string; reason: string; findingCodes: string[] }>;
  refused: Array<{ id: string; reason: string }>;
} {
  const entry = result.digests.find((digest) =>
    digest.describe.includes("governed ECC framework materialization"),
  );
  if (entry === undefined) {
    throw new Error(
      `expected a governed materialization digest, saw: ${result.digests
        .map((digest) => digest.describe)
        .join(", ")}`,
    );
  }
  return entry.data as ReturnType<typeof materializationDigest>;
}

describe("F6 — the governed framework lifecycle reached through `aih ecc`", () => {
  it("previews the governed install without --apply and writes nothing", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);
    const before = snapshot(root);

    const result = await runLifecycle("install", false);

    // The plan genuinely has work queued: "wrote nothing" over an empty plan
    // would prove nothing at all.
    const reported = materializationDigest(result);
    expect(reported.applied).toBe(false);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      MATERIALIZED.map((file) => file.destination).sort(),
    );
    // ...and not one byte of it landed.
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    for (const file of MATERIALIZED) {
      expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(false);
    }
  });

  it("materializes the evidence-passed selection with its receipt under --apply", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);

    const result = await runLifecycle("install", true);

    const reported = materializationDigest(result);
    expect(reported.applied).toBe(true);
    for (const file of MATERIALIZED) {
      expect(
        bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
        file.destination,
      ).toBe(true);
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);
    // The vet-blocked component is reported by name and never reached a
    // destination — evidence, not selection, is what admits a component.
    expect(
      reported.excluded.map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        findingCodes: entry.findingCodes,
      })),
    ).toEqual([{ id: BLOCKED.id, reason: "vet-blocked", findingCodes: ["malicious-code"] }]);
    expect(existsSync(join(root, ".claude", "agents", "planner.md"))).toBe(false);
    // Operator content the lifecycle does not own survives untouched.
    for (const path of Object.keys(OPERATOR_TREE)) {
      expect(bytesAt(root, path).toString("utf8"), path).toBe(OPERATOR_TREE[path]);
    }
  });

  for (const lifecycle of ["update", "repair", "rollback"]) {
    it(`still refuses --lifecycle ${lifecycle} in a governed repository, naming what is wired`, async () => {
      writeGovernedPolicy([...PASSED]);

      const failure = await runLifecycle(lifecycle, false).then(
        () => undefined,
        (error: Error) => error,
      );

      expect(failure?.message).toContain(`aih ecc --lifecycle ${lifecycle}`);
      // The message must name where install and removal actually live, and must
      // no longer point at a design that has since landed.
      expect(failure?.message).toContain("aih ecc --lifecycle install");
      expect(failure?.message).toContain("aih uninstall");
      expect(failure?.message).not.toContain("after the non-MCP framework lifecycle is designed");
      expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    });
  }

  it("leaves --lifecycle uninstall on the profile lifecycle in a governed repository", async () => {
    writeGovernedPolicy([...PASSED]);
    const executeProfileLifecycle = vi.fn(async () => profileLifecycleResult());

    const result = await executeEccCommand(ctx(false, { lifecycle: "uninstall" }), {
      executeProfileLifecycle,
    });

    expect(executeProfileLifecycle).toHaveBeenCalledOnce();
    expect(result.capability).toBe("ecc lifecycle");
  });

  it("leaves --lifecycle install on the profile lifecycle when nothing governs the repository", async () => {
    writeUngovernedPolicy();
    const executeProfileLifecycle = vi.fn(async () => profileLifecycleResult());

    const result = await executeEccCommand(ctx(false, { lifecycle: "install" }), {
      executeProfileLifecycle,
    });

    expect(executeProfileLifecycle).toHaveBeenCalledOnce();
    expect(result.capability).toBe("ecc lifecycle");
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });
});

function profileLifecycleResult(): PlanResult {
  return {
    capability: "ecc lifecycle",
    applied: false,
    writes: [],
    docs: [],
    probes: [],
    execs: [],
    digests: [],
    backups: [],
    removed: [],
  };
}
