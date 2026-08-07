import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { resolveTrustSource } from "../../src/trust/fetch.js";

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
  ".mcp.json": '{"mcpServers":{}}\n',
  "mcp-configs/mcp-servers.json": '{"servers":{}}\n',
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

/** Evidence-passed, and lands on a surface another AIH lifecycle owns. */
const OTHER_LIFECYCLE: SelectionFixture = {
  kind: "mcp",
  id: "mcp:github",
  path: "mcp-configs/mcp-servers.json",
  paths: [".mcp.json", "mcp-configs/mcp-servers.json"],
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

function writeGovernedPolicy(
  selections: readonly SelectionFixture[],
  source: { repository?: string; commit?: string } = {},
): void {
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
                source: {
                  repository: source.repository ?? REPOSITORY,
                  commit: source.commit ?? COMMIT,
                  path: item.path,
                },
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

const CATALOGUED: readonly SelectionFixture[] = [...PASSED, BLOCKED, OTHER_LIFECYCLE];

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: COMMIT,
    components: CATALOGUED.map((item) => ({ id: item.id, paths: item.paths })),
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
        components: CATALOGUED.map((item) => ({
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

  /**
   * M2: on the DEFAULT source the evidence pipeline returns the acquisition plan
   * in dry run and never reaches the plan builder
   * (`baseline-evidence/pipeline.ts:126-135`), so a governed dry run that said
   * nothing would make the first run showing the plan the run that already
   * wrote. It must instead say plainly that file-level preview needs the source.
   */
  it("gives an honest dry run on the default remote source, fetching and writing nothing", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);
    const source = resolveTrustSource("affaan-m/ECC", { root, pin: COMMIT });
    if (source.kind !== "github") throw new Error("expected a GitHub source");
    const before = snapshot(root);

    const result = await executeEccCommand(ctx(false, { lifecycle: "install" }), {
      catalog: catalog(),
      source,
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
    });

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    // Names the pin the bytes would come from...
    expect(digest?.text).toContain(`affaan-m/ECC@${COMMIT}`);
    // ...every selected component id...
    for (const item of [...PASSED, BLOCKED]) {
      expect(digest?.text, item.id).toContain(item.id);
    }
    // ...and states plainly why this is not a file-level preview.
    expect(digest?.text).toContain("--ecc-path");
    expect(digest?.text).toContain("--apply");
    // Nothing fetched, nothing written, no quarantine left behind.
    expect(result.execs).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    expect(existsSync(source.quarantineRoot)).toBe(false);
  });

  /**
   * M3: an empty engine request is indistinguishable from "everything was
   * deselected", and the engine subtracts every prior receipt entry on that
   * reading. A selection the target refuses WHOLLY is ambiguity, so it fails
   * closed instead of wiping the prior install.
   */
  it("refuses a wholly-refused selection by name instead of subtracting the prior install", async () => {
    // A prior governed install, materialized and receipted.
    writeGovernedPolicy([...PASSED]);
    await runLifecycle("install", true);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);

    // Now the policy selects only a component whose content lands on a surface
    // another AIH lifecycle owns — the Claude target refuses all of it. The
    // baseline is taken AFTER the policy rewrite, so the only thing this can
    // catch is the materialization being touched.
    writeGovernedPolicy([OTHER_LIFECYCLE]);
    const settled = snapshot(root);
    const failure = await runLifecycle("install", true).then(
      () => undefined,
      (error: Error) => error,
    );

    // The safety property first: the prior install is untouched, every byte,
    // receipt included. This is what an empty request would have destroyed.
    expect(snapshot(root)).toEqual(settled);
    expect(failure?.message).toContain(OTHER_LIFECYCLE.id);
    expect(failure?.message).toContain("unowned-destination");
  });

  /**
   * M3, the other half. A receipt entry the new request no longer carries may be
   * a genuine deselection OR a component this run could not map, and this layer
   * does not check which. The subtract row must therefore not name a cause it
   * never established — not even here, where the deselection IS genuine.
   */
  it("subtracts a deselected component without claiming to know it was deselected", async () => {
    writeGovernedPolicy([...PASSED]);
    await runLifecycle("install", true);
    const deselected = ".claude/rules/README.md";
    expect(existsSync(join(root, ...deselected.split("/")))).toBe(true);

    // Genuinely narrower: `baseline:rules` and `skill:tdd-workflow` are dropped.
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    const result = await runLifecycle("install", true);

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    const row = (digest?.text ?? "").split("\n").find((line) => line.includes(deselected)) ?? "";
    // The subtraction really happened — a vacuous row would prove nothing.
    expect(row).toMatch(/\[removed\]/);
    expect(existsSync(join(root, ...deselected.split("/")))).toBe(false);
    // ...and it is described by what this layer knows, not by a cause it assumed.
    expect(row).toContain("no longer part of this materialization");
    expect(digest?.text).not.toContain("ownership no longer selected");
  });

  /**
   * L1: a refusal must not leave a quarantine directory behind. The source was
   * being resolved — which creates the quarantine — before the policy was
   * validated against the catalog.
   */
  it("creates no quarantine directory when the policy refuses before any source is resolved", async () => {
    // Governed, but selecting a framework this lifecycle does not materialize.
    writeFileSync(
      orgPolicyPath(root, {}),
      `${JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026-08-07.f6",
          catalog: { reviewed: [], custom: [] },
          externalSelections: [{ framework: "superpowers", items: [] }],
        },
      })}\n`,
      "utf8",
    );
    const temp = mkdtempSync(join(tmpdir(), "aih-governed-tmp-"));
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = temp;
    process.env.TEMP = temp;
    process.env.TMP = temp;

    let failure: Error | undefined;
    try {
      // No `deps.source`: the command resolves the source itself, which is
      // exactly the ordering under test.
      failure = await executeEccCommand(ctx(false, { lifecycle: "install" }), {
        catalog: catalog(),
      }).then(
        () => undefined,
        (error: Error) => error,
      );
    } finally {
      process.env.TMPDIR = saved.TMPDIR;
      process.env.TEMP = saved.TEMP;
      process.env.TMP = saved.TMP;
    }

    expect(failure?.message).toMatch(/selects no ECC component/);
    expect(readdirSync(temp).filter((name) => name.startsWith("aih-quarantine-"))).toEqual([]);
    rmSync(temp, { recursive: true, force: true });
  });

  /**
   * L2: the receipt's provenance is the policy's claim about where bytes came
   * from, while the bytes come from the catalog pin. Nothing compared them, so a
   * policy naming any repository/commit produced a receipt asserting it.
   */
  it("refuses a selection whose claimed pin disagrees with the catalog the bytes come from", async () => {
    writeGovernedPolicy([...PASSED], { commit: "b".repeat(40) });

    const failure = await runLifecycle("install", true).then(
      () => undefined,
      (error: Error) => error,
    );

    // Both values named, so the operator can see which one is wrong.
    expect(failure?.message).toContain("b".repeat(40));
    expect(failure?.message).toContain(COMMIT);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  it("refuses a selection whose claimed repository disagrees with the catalog", async () => {
    writeGovernedPolicy([...PASSED], { repository: "attacker/ECC" });

    const failure = await runLifecycle("install", true).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("attacker/ECC");
    expect(failure?.message).toContain(REPOSITORY);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

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
