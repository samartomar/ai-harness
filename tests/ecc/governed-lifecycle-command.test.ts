import { createHash } from "node:crypto";
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
import { readEccMaterializationReceipt } from "../../src/ecc/materialization-receipt.js";
import { executeEccCommand } from "../../src/ecc/pipeline.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import type { PlanResult } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { orgPolicyPath } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { resolveTrustSource } from "../../src/trust/fetch.js";
import { removeEccMaterialization } from "../../src/uninstall/ecc-materialization.js";

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
  // The target-independent rows, which every target shares and which are the
  // ONLY rows OpenCode carries.
  "AGENTS.md": "# agents bootloader\n",
  ".agents/plugins/marketplace.json": '{"plugins":[]}\n',
  ".kiro/skills/tdd-workflow/SKILL.md": "# Kiro tdd-workflow\n",
  ".kiro/skills/not-selected/SKILL.md": "# not selected\n",
  ".kiro/steering/security.md": "# Kiro security\n",
  ".kiro/steering/testing.md": "# Kiro testing\n",
  ".kiro/agents/code-reviewer.md": "---\nname: code-reviewer\n---\n\n# Markdown agent\n",
  ".kiro/agents/code-reviewer.json":
    '{"name":"code-reviewer","mcpServers":{},"hooks":{},"prompt":"JSON agent"}\n',
  ".kiro/settings/mcp.json.example": "{}\n",
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
  {
    kind: "baseline",
    id: "baseline:rules",
    path: "rules",
    paths: ["rules/README.md", "rules/common"],
  },
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

/**
 * Evidence-passed, and declares ONLY target-independent sources. Selected apart
 * from `PASSED` because it is the one component OpenCode can materialize, so it
 * is what makes an OpenCode run non-empty.
 */
const SHARED_ONLY: SelectionFixture = {
  kind: "baseline",
  id: "baseline:agents",
  path: "AGENTS.md",
  paths: [".agents/plugins/marketplace.json", "AGENTS.md"],
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
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          supportedClis: SUPPORTED_CLIS,
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
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const KIRO_RUNTIME: SelectionFixture = {
  kind: "runtime",
  id: "runtime:ecc-kiro",
  path: ".kiro",
  paths: [".kiro"],
};

const CATALOGUED: readonly SelectionFixture[] = [
  ...PASSED,
  BLOCKED,
  OTHER_LIFECYCLE,
  SHARED_ONLY,
  KIRO_RUNTIME,
];

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

/**
 * Governed lifecycle success paths are Enterprise paths. They receive an
 * already-verified organization evidence record through the production
 * injection seam, rather than accidentally falling back to the packaged
 * vendor lock for this deliberately synthetic pin.
 */
function verifiedOrgEvidence(lock: ReturnType<typeof vendorLock>) {
  return async (input: { posture: string; catalog: ReturnType<typeof catalog> }) => {
    expect(input.posture).toBe("enterprise");
    expect(input.catalog).toMatchObject({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: COMMIT,
    });
    return {
      checks: [],
      evidence: {
        tier: "org" as const,
        issuer: "github:acme/engineering-governance",
        evidenceSha256: "e".repeat(64),
        lock,
      },
    };
  };
}

async function runLifecycle(
  lifecycle: string,
  apply: boolean,
  cli?: string,
  lock = vendorLock(),
): Promise<PlanResult> {
  return executeEccCommand(
    ctx(apply, { lifecycle, eccPath: sourceRoot, ...(cli === undefined ? {} : { cli }) }),
    {
      catalog: catalog(),
      resolveOrgEvidence: verifiedOrgEvidence(lock),
      executeProfileLifecycle: async () => {
        throw new Error("the governed install must not fall through to the profile lifecycle");
      },
    },
  );
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
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026-08-07.f6",
          supportedClis: ["claude"],
          catalog: { reviewed: [], custom: [] },
          externalSelections: [{ framework: "superpowers", items: [] }],
        },
      })}\n`,
      "utf8",
    );
    const temp = mkdtempSync(join(tmpdir(), "aih-governed-tmp-"));
    // The quarantine goes under `os.tmpdir()` with no injection point
    // (`src/trust/fetch.ts:101-102`), so proving none was created means pointing
    // the OS temp dir at an observable directory for the length of this call.
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
      // Restore by DELETING what was unset. Assigning `undefined` to a
      // `process.env` key stores the literal string "undefined", and POSIX
      // `os.tmpdir()` reads TMPDIR first — so every later `mkdtempSync` in this
      // file would target a directory named "undefined". GitHub's ubuntu runners
      // set none of these three (only RUNNER_TEMP); Windows always sets TEMP and
      // macOS always sets TMPDIR, which is why only Linux saw it.
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

/**
 * F4, second target: the SAME operator route with `--cli` naming the target.
 *
 * The discriminator is the workstation CLI selection every other target-scoped
 * operation already uses — no governed-only flag and no policy grammar for it —
 * so the block above, which passes no `--cli`, is also the proof that the
 * default stays `claude` and behaves exactly as it shipped.
 */
/** Whether this volume stores NFC and NFD spellings as two entries (APFS does not). */
function preservesUnicodeSpelling(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-governed-nfd-probe-"));
  try {
    writeFileSync(join(probe, "café.md".normalize("NFC")), "x", "utf8");
    return !existsSync(join(probe, "café.md".normalize("NFD")));
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe("F4 — the governed framework lifecycle for the Codex target", () => {
  /** Where each source file lands for Codex; the shared row is target-independent. */
  const CODEX_MATERIALIZED: ReadonlyArray<{ source: string; destination: string }> = [
    { source: "agents/code-reviewer.md", destination: ".codex/agents/code-reviewer.md" },
    { source: "rules/README.md", destination: ".codex/rules/README.md" },
    { source: "rules/common/coding-style.md", destination: ".codex/rules/common/coding-style.md" },
    {
      source: ".agents/skills/tdd-workflow/SKILL.md",
      destination: ".agents/skills/tdd-workflow/SKILL.md",
    },
    { source: "skills/tdd-workflow/SKILL.md", destination: ".codex/skills/tdd-workflow/SKILL.md" },
  ];

  it("previews `--cli codex` against the Codex rows and writes nothing", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);
    const before = snapshot(root);

    const reported = materializationDigest(await runLifecycle("install", false, "codex"));

    expect(reported.applied).toBe(false);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      CODEX_MATERIALIZED.map((file) => file.destination).sort(),
    );
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  it("applies, receipts and then uninstalls the Codex materialization", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);

    const reported = materializationDigest(await runLifecycle("install", true, "codex"));

    expect(reported.applied).toBe(true);
    for (const file of CODEX_MATERIALIZED) {
      expect(
        bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
        file.destination,
      ).toBe(true);
    }
    // Nothing landed on the Claude surfaces this run did not target.
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(false);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);

    // Removal is the shipped `aih uninstall` member, receipt-bound and
    // target-agnostic: the receipt is what proves ownership, not the flag.
    const removed = removeEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed.sort()).toEqual(
      CODEX_MATERIALIZED.map((file) => file.destination).sort(),
    );
    for (const file of CODEX_MATERIALIZED) {
      expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(false);
    }
    for (const path of Object.keys(OPERATOR_TREE)) {
      expect(bytesAt(root, path).toString("utf8"), path).toBe(OPERATOR_TREE[path]);
    }
  });

  it("names the Codex target in its own refusal row", async () => {
    writeGovernedPolicy([...PASSED, OTHER_LIFECYCLE]);

    const result = await runLifecycle("install", false, "codex");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    expect(digest?.text).toContain("Evidence-passed, and refused by the Codex target:");
    expect(digest?.text).toContain(
      `[unowned-destination] ${OTHER_LIFECYCLE.id} - the Codex target owns no content destination for .mcp.json`,
    );
    expect(digest?.text).not.toContain("refused by the Claude target");
  });

  it("materializes `--cli claude,codex` as one union with the shared row written once", async () => {
    writeGovernedPolicy([...PASSED]);

    const reported = materializationDigest(await runLifecycle("install", true, "claude,codex"));

    const written = reported.write.map((file) => file.path).sort();
    expect(written).toEqual(
      [
        ...MATERIALIZED.map((file) => file.destination),
        ...CODEX_MATERIALIZED.map((f) => f.destination),
      ]
        .filter((path, index, all) => all.indexOf(path) === index)
        .sort(),
    );
    // The shared row appears exactly once in the plan and once in the receipt —
    // a component claiming one destination twice is refused by the engine, so
    // this is correctness, not tidiness.
    const shared = ".agents/skills/tdd-workflow/SKILL.md";
    expect(written.filter((path) => path === shared)).toEqual([shared]);

    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    const skill = receipt.receipt.components.find(
      (component) => component.id === "skill:tdd-workflow",
    );
    expect(skill?.files.map((file) => file.path)).toEqual([
      shared,
      ".claude/skills/tdd-workflow/SKILL.md",
      ".codex/skills/tdd-workflow/SKILL.md",
    ]);
    // ONE receipt at ONE path: no per-target root and no second document.
    expect(walkManagedRoot(root).filter((path) => path.startsWith(".aih/"))).toEqual([
      ".aih/ecc/materialization-v1.json",
    ]);
  });

  it("subtracts the dropped target's files when a later apply narrows `--cli`", async () => {
    // One component, deliberately: two applies of the whole selection is the
    // slowest shape in this file and the reconcile needs exactly one row each
    // side — one the dropped target owned alone, one the remaining target keeps.
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    await runLifecycle("install", true, "claude,codex");
    expect(existsSync(join(root, ".codex", "agents", "code-reviewer.md"))).toBe(true);
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(true);

    const result = await runLifecycle("install", true, "claude");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    // Subtracted, and reported — never silently.
    expect(existsSync(join(root, ".codex", "agents", "code-reviewer.md"))).toBe(false);
    expect(digest?.text).toContain("[removed] .codex/agents/code-reviewer.md");
    // The remaining target's row survives: narrowing subtracts what the dropped
    // target owned alone, never what the remaining target still claims.
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(true);
    expect(digest?.text).not.toContain("[removed] .claude/agents/code-reviewer.md");
  });

  it("refuses a CLI that is not a governed materialization target, before any source", async () => {
    writeGovernedPolicy([...PASSED]);
    const before = snapshot(root);

    const failure = await runLifecycle("install", true, "zed").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("zed is not a governed materialization target");
    expect(failure?.message).toContain("claude, codex, kimi, cursor, opencode");
    // ...and what IS wired, which is now the whole ruled set.
    expect(failure?.message).toContain(
      "claude, codex, kimi, cursor, opencode, kiro are wired today",
    );
    // The remedy, not just the diagnosis: the target set can come from a
    // committed marker the operator is not thinking about, so the refusal has
    // to say which flag overrides it.
    expect(failure?.message).toContain("--cli claude,codex,kimi,cursor,opencode");
    expect(failure?.message).toContain(".aih-config.json");
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  /**
   * A committed `.aih-config.json` naming a tool outside the wired set refuses
   * the governed install rather than narrowing to the intersection: narrowing
   * would materialize less than the workstation configuration says while
   * reporting success. The refusal therefore has to carry the way out.
   */
  it("refuses on committed marker targets outside the wired set, naming the flag that outranks them", async () => {
    writeGovernedPolicy([...PASSED]);
    writeFileSync(
      join(root, ".aih-config.json"),
      `${JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude", "gemini"] })}\n`,
      "utf8",
    );

    const failure = await runLifecycle("install", true).then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("gemini is not a governed materialization target");
    expect(failure?.message).toContain("--cli claude,codex,kimi,cursor,opencode");
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);

    // ...and taking the named remedy actually works, so the message is a route
    // and not just an apology.
    const reported = materializationDigest(await runLifecycle("install", true, "claude"));
    expect(reported.applied).toBe(true);
  });

  /**
   * Two of ONE target's own sources folding onto one destination is a defect in
   * the pinned checkout. It must be refused and REPORTED, never collapsed into
   * a component that installs one file short.
   */
  it.skipIf(!preservesUnicodeSpelling())(
    "reports a duplicate-destination refusal under the target that made it",
    async () => {
      writeGovernedPolicy([...PASSED]);
      const skill = join(sourceRoot, "skills", "tdd-workflow");
      writeFileSync(join(skill, "café.md".normalize("NFC")), "# precomposed\n");
      writeFileSync(join(skill, "café.md".normalize("NFD")), "# decomposed\n");

      const result = await runLifecycle("install", false, "codex");

      const digest = result.digests.find((entry) =>
        entry.describe.includes("governed ECC framework materialization"),
      );
      expect(digest?.text).toContain("Evidence-passed, and refused by the Codex target:");
      expect(digest?.text).toContain("[duplicate-destination] skill:tdd-workflow");
      expect(digest?.text).toContain("two pinned sources claim one Codex destination");
      // Positive control: the other components still materialize, so the
      // refusal is scoped to the component that carries the collision.
      expect(materializationDigest(result).write.map((file) => file.path)).toContain(
        ".codex/agents/code-reviewer.md",
      );
      expect(materializationDigest(result).write.map((file) => file.path)).not.toContain(
        ".codex/skills/tdd-workflow/SKILL.md",
      );
    },
  );

  it("names the component the pinned catalog does not carry, instead of an ellipsis", async () => {
    writeGovernedPolicy([
      ...PASSED,
      { kind: "skill", id: "skill:not-in-this-catalog", path: "skills/nope", paths: [] },
    ]);

    const failure = await runLifecycle("install", false, "codex").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain("skill:not-in-this-catalog");
  });
});

/**
 * F4, third target: the same operator route with `--cli kimi`, whose project
 * root is `.kimi-code` rather than the `.kimi` a parameterized root produces.
 */
describe("F4 — the governed framework lifecycle for the Kimi target", () => {
  /** Where each source file lands for Kimi; the shared row is target-independent. */
  const KIMI_MATERIALIZED: ReadonlyArray<{ source: string; destination: string }> = [
    { source: "agents/code-reviewer.md", destination: ".kimi-code/agents/code-reviewer.md" },
    { source: "rules/README.md", destination: ".kimi-code/rules/README.md" },
    {
      source: "rules/common/coding-style.md",
      destination: ".kimi-code/rules/common/coding-style.md",
    },
    {
      source: ".agents/skills/tdd-workflow/SKILL.md",
      destination: ".agents/skills/tdd-workflow/SKILL.md",
    },
    {
      source: "skills/tdd-workflow/SKILL.md",
      destination: ".kimi-code/skills/tdd-workflow/SKILL.md",
    },
  ];

  it("previews `--cli kimi` against the .kimi-code rows and writes nothing", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);
    const before = snapshot(root);

    const reported = materializationDigest(await runLifecycle("install", false, "kimi"));

    expect(reported.applied).toBe(false);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      KIMI_MATERIALIZED.map((file) => file.destination).sort(),
    );
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  it("applies, receipts and then uninstalls the Kimi materialization", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);

    const reported = materializationDigest(await runLifecycle("install", true, "kimi"));

    expect(reported.applied).toBe(true);
    for (const file of KIMI_MATERIALIZED) {
      expect(
        bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
        file.destination,
      ).toBe(true);
    }
    // Neither the other targets' roots nor the obsolete `.kimi` directory.
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(false);
    expect(existsSync(join(root, ".kimi"))).toBe(false);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);

    const removed = removeEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed.sort()).toEqual(KIMI_MATERIALIZED.map((f) => f.destination).sort());
    for (const file of KIMI_MATERIALIZED) {
      expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(false);
    }
    for (const path of Object.keys(OPERATOR_TREE)) {
      expect(bytesAt(root, path).toString("utf8"), path).toBe(OPERATOR_TREE[path]);
    }
  });

  it("names the Kimi target in its own refusal row", async () => {
    writeGovernedPolicy([...PASSED, OTHER_LIFECYCLE]);

    const result = await runLifecycle("install", false, "kimi");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    expect(digest?.text).toContain("Evidence-passed, and refused by the Kimi target:");
    expect(digest?.text).toContain(
      `[unowned-destination] ${OTHER_LIFECYCLE.id} - the Kimi target owns no content destination for .mcp.json`,
    );
    expect(digest?.text).not.toContain("refused by the Claude target");
  });

  it("materializes `--cli claude,kimi` as one union with the shared row written once", async () => {
    writeGovernedPolicy([...PASSED]);

    const reported = materializationDigest(await runLifecycle("install", true, "claude,kimi"));

    const written = reported.write.map((file) => file.path).sort();
    expect(written).toEqual(
      [
        ...MATERIALIZED.map((file) => file.destination),
        ...KIMI_MATERIALIZED.map((file) => file.destination),
      ]
        .filter((path, index, all) => all.indexOf(path) === index)
        .sort(),
    );
    // Both roots really materialized — a union that wrote only one target's rows
    // would still satisfy a laxer assertion.
    expect(written.some((path) => path.startsWith(".claude/"))).toBe(true);
    expect(written.some((path) => path.startsWith(".kimi-code/"))).toBe(true);
    const shared = ".agents/skills/tdd-workflow/SKILL.md";
    expect(written.filter((path) => path === shared)).toEqual([shared]);

    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    const skill = receipt.receipt.components.find(
      (component) => component.id === "skill:tdd-workflow",
    );
    expect(skill?.files.map((file) => file.path)).toEqual([
      shared,
      ".claude/skills/tdd-workflow/SKILL.md",
      ".kimi-code/skills/tdd-workflow/SKILL.md",
    ]);
    // ONE receipt at ONE path: no per-target root and no second document.
    expect(walkManagedRoot(root).filter((path) => path.startsWith(".aih/"))).toEqual([
      ".aih/ecc/materialization-v1.json",
    ]);
  });

  it("subtracts the `.kimi-code` files when a later apply narrows `--cli` back to claude", async () => {
    writeGovernedPolicy([...PASSED]);
    await runLifecycle("install", true, "claude,kimi");
    // Every digest the union wrote, so the narrowing below is checked against
    // bytes rather than against mere existence.
    const digests = Object.fromEntries(
      walkManagedRoot(root).map((path) => [
        path,
        createHash("sha256").update(bytesAt(root, path)).digest("hex"),
      ]),
    );
    const kimiPaths = Object.keys(digests).filter((path) => path.startsWith(".kimi-code/"));
    expect(kimiPaths.sort()).toEqual(
      KIMI_MATERIALIZED.map((file) => file.destination)
        .filter((path) => path.startsWith(".kimi-code/"))
        .sort(),
    );

    const result = await runLifecycle("install", true, "claude");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    for (const path of kimiPaths) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
      expect(digest?.text, path).toContain(`[removed] ${path}`);
    }
    // The remaining target keeps every byte it had — same digest, not merely
    // still present — and the shared row is not collateral of the subtraction.
    // The receipt is the one file that MUST change: it is the record of what is
    // owned, and it no longer owns the dropped target's rows.
    const receiptPath = ".aih/ecc/materialization-v1.json";
    for (const [path, sha] of Object.entries(digests)) {
      if (path.startsWith(".kimi-code/") || path === receiptPath) continue;
      expect(createHash("sha256").update(bytesAt(root, path)).digest("hex"), path).toBe(sha);
      expect(digest?.text ?? "", path).not.toContain(`[removed] ${path}`);
    }
    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    expect(
      receipt.receipt.components.flatMap((component) =>
        component.files.map((file) => file.path).filter((path) => path.startsWith(".kimi-code/")),
      ),
    ).toEqual([]);
  });
});

/**
 * F4, fourth target: the same operator route with `--cli cursor`. The mapping
 * needed no Cursor row — `.${target}` is already the project root upstream's own
 * Cursor adapter uses — so what this block pins is the wiring: the operator can
 * ask for it, the rows land, the receipt owns them, and `aih uninstall` takes
 * them back.
 */
describe("F4 — the governed framework lifecycle for the Cursor target", () => {
  /** Where each source file lands for Cursor; the shared row is target-independent. */
  const CURSOR_MATERIALIZED: ReadonlyArray<{ source: string; destination: string }> = [
    { source: "agents/code-reviewer.md", destination: ".cursor/agents/code-reviewer.md" },
    { source: "rules/README.md", destination: ".cursor/rules/README.md" },
    { source: "rules/common/coding-style.md", destination: ".cursor/rules/common/coding-style.md" },
    {
      source: ".agents/skills/tdd-workflow/SKILL.md",
      destination: ".agents/skills/tdd-workflow/SKILL.md",
    },
    { source: "skills/tdd-workflow/SKILL.md", destination: ".cursor/skills/tdd-workflow/SKILL.md" },
  ];

  it("previews `--cli cursor` against the .cursor rows and writes nothing", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);
    const before = snapshot(root);

    const reported = materializationDigest(await runLifecycle("install", false, "cursor"));

    expect(reported.applied).toBe(false);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      CURSOR_MATERIALIZED.map((file) => file.destination).sort(),
    );
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  it("applies, receipts and then uninstalls the Cursor materialization", async () => {
    writeGovernedPolicy([...PASSED, BLOCKED]);

    const reported = materializationDigest(await runLifecycle("install", true, "cursor"));

    expect(reported.applied).toBe(true);
    for (const file of CURSOR_MATERIALIZED) {
      expect(
        bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
        file.destination,
      ).toBe(true);
    }
    // Nothing landed on a target this run did not ask for.
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(false);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);

    const removed = removeEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed.sort()).toEqual(CURSOR_MATERIALIZED.map((f) => f.destination).sort());
    for (const file of CURSOR_MATERIALIZED) {
      expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(false);
    }
    for (const path of Object.keys(OPERATOR_TREE)) {
      expect(bytesAt(root, path).toString("utf8"), path).toBe(OPERATOR_TREE[path]);
    }
  });

  it("names the Cursor target in its own refusal row", async () => {
    writeGovernedPolicy([...PASSED, OTHER_LIFECYCLE]);

    const result = await runLifecycle("install", false, "cursor");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    expect(digest?.text).toContain("Evidence-passed, and refused by the Cursor target:");
    expect(digest?.text).toContain(
      `[unowned-destination] ${OTHER_LIFECYCLE.id} - the Cursor target owns no content destination for .mcp.json`,
    );
    expect(digest?.text).not.toContain("refused by the Claude target");
  });

  it("materializes `--cli claude,cursor` as one union with the shared row written once", async () => {
    writeGovernedPolicy([...PASSED]);

    const reported = materializationDigest(await runLifecycle("install", true, "claude,cursor"));

    const written = reported.write.map((file) => file.path).sort();
    expect(written).toEqual(
      [
        ...MATERIALIZED.map((file) => file.destination),
        ...CURSOR_MATERIALIZED.map((file) => file.destination),
      ]
        .filter((path, index, all) => all.indexOf(path) === index)
        .sort(),
    );
    // Both roots really materialized — a union that wrote only one target's rows
    // would still satisfy a laxer assertion.
    expect(written.some((path) => path.startsWith(".claude/"))).toBe(true);
    expect(written.some((path) => path.startsWith(".cursor/"))).toBe(true);
    const shared = ".agents/skills/tdd-workflow/SKILL.md";
    expect(written.filter((path) => path === shared)).toEqual([shared]);

    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    const skill = receipt.receipt.components.find(
      (component) => component.id === "skill:tdd-workflow",
    );
    expect(skill?.files.map((file) => file.path)).toEqual([
      shared,
      ".claude/skills/tdd-workflow/SKILL.md",
      ".cursor/skills/tdd-workflow/SKILL.md",
    ]);
    // ONE receipt at ONE path: no per-target root and no second document.
    expect(walkManagedRoot(root).filter((path) => path.startsWith(".aih/"))).toEqual([
      ".aih/ecc/materialization-v1.json",
    ]);
  });

  it("subtracts the `.cursor` files when a later apply narrows `--cli` back to claude", async () => {
    writeGovernedPolicy([...PASSED]);
    await runLifecycle("install", true, "claude,cursor");
    // Every digest the union wrote, so the narrowing below is checked against
    // bytes rather than against mere existence.
    const digests = Object.fromEntries(
      walkManagedRoot(root).map((path) => [
        path,
        createHash("sha256").update(bytesAt(root, path)).digest("hex"),
      ]),
    );
    const cursorPaths = Object.keys(digests).filter((path) => path.startsWith(".cursor/"));
    expect(cursorPaths.sort()).toEqual(
      CURSOR_MATERIALIZED.map((file) => file.destination)
        .filter((path) => path.startsWith(".cursor/"))
        .sort(),
    );

    const result = await runLifecycle("install", true, "claude");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    for (const path of cursorPaths) {
      expect(existsSync(join(root, ...path.split("/"))), path).toBe(false);
      expect(digest?.text, path).toContain(`[removed] ${path}`);
    }
    // The remaining target keeps every byte it had — same digest, not merely
    // still present. The receipt is the one file that MUST change: it is the
    // record of what is owned, and it no longer owns the dropped target's rows.
    const receiptPath = ".aih/ecc/materialization-v1.json";
    for (const [path, sha] of Object.entries(digests)) {
      if (path.startsWith(".cursor/") || path === receiptPath) continue;
      expect(createHash("sha256").update(bytesAt(root, path)).digest("hex"), path).toBe(sha);
      expect(digest?.text ?? "", path).not.toContain(`[removed] ${path}`);
    }
    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    expect(
      receipt.receipt.components.flatMap((component) =>
        component.files.map((file) => file.path).filter((path) => path.startsWith(".cursor/")),
      ),
    ).toEqual([]);
  });
});

/**
 * F4, fifth and last target: `--cli opencode`, whose scope is the shared rows
 * and nothing else. What this block pins is the honest-small shape end to end —
 * the operator asks for OpenCode, gets the tool-shared project surfaces, and
 * reads by name every component OpenCode does not own.
 *
 * It also closes the mixed-outcome path. Until a target existed that refuses
 * ordinary content while another accepts it, "a target that refuses a component
 * does not veto the others" and "the total-refusal gate spans the WHOLE
 * requested target set" were implemented but not reachable from the command.
 */
describe("F4 — the governed framework lifecycle for the OpenCode target", () => {
  /** The only rows OpenCode carries: target-independent, at the project root. */
  const OPENCODE_MATERIALIZED: ReadonlyArray<{ source: string; destination: string }> = [
    { source: "AGENTS.md", destination: "AGENTS.md" },
    {
      source: ".agents/plugins/marketplace.json",
      destination: ".agents/plugins/marketplace.json",
    },
  ];

  it("materializes only the shared rows for `--cli opencode`, and nothing under .opencode/", async () => {
    writeGovernedPolicy([...PASSED, SHARED_ONLY, BLOCKED]);

    const reported = materializationDigest(await runLifecycle("install", true, "opencode"));

    expect(reported.applied).toBe(true);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      OPENCODE_MATERIALIZED.map((file) => file.destination).sort(),
    );
    for (const file of OPENCODE_MATERIALIZED) {
      expect(
        bytesAt(root, file.destination).equals(bytesAt(sourceRoot, file.source)),
        file.destination,
      ).toBe(true);
    }
    // No invented per-tool directory, and no other target's root either.
    expect(existsSync(join(root, ".opencode"))).toBe(false);
    expect(walkManagedRoot(root).filter((path) => path.startsWith(".opencode/"))).toEqual([]);
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(false);
  });

  it("names the OpenCode target in the refusal rows for the content it does not own", async () => {
    writeGovernedPolicy([...PASSED, SHARED_ONLY]);

    const result = await runLifecycle("install", false, "opencode");

    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    expect(digest?.text).toContain("Evidence-passed, and refused by the OpenCode target:");
    expect(digest?.text).toContain(
      "[unowned-destination] agent:code-reviewer - the OpenCode target owns no content destination for agents/code-reviewer.md",
    );
    // A component with one shared row and one generic row refuses WHOLE, rather
    // than installing the half OpenCode can map.
    expect(digest?.text).toContain("[unowned-destination] skill:tdd-workflow");
    expect(materializationDigest(result).write.map((file) => file.path)).not.toContain(
      ".agents/skills/tdd-workflow/SKILL.md",
    );
  });

  it("materializes for Claude what OpenCode refuses, without firing the total-refusal gate", async () => {
    writeGovernedPolicy([...PASSED, SHARED_ONLY]);

    const result = await runLifecycle("install", true, "claude,opencode");
    const reported = materializationDigest(result);

    // Claude's rows all landed — one target refusing everything it was handed is
    // not total refusal while another still materializes.
    expect(reported.applied).toBe(true);
    expect(reported.write.map((file) => file.path).sort()).toEqual(
      [
        ...MATERIALIZED.map((file) => file.destination),
        ...OPENCODE_MATERIALIZED.map((file) => file.destination),
      ]
        .filter((path, index, all) => all.indexOf(path) === index)
        .sort(),
    );
    // ...and the refusals are reported against the target that made them.
    const digest = result.digests.find((entry) =>
      entry.describe.includes("governed ECC framework materialization"),
    );
    expect(digest?.text).toContain("Evidence-passed, and refused by the OpenCode target:");
    expect(digest?.text).not.toContain("refused by the Claude target");
    expect(reported.refused.map((entry) => entry.id).sort()).toEqual(
      PASSED.map((item) => item.id).sort(),
    );
    // `AGENTS.md` is a row both targets agree on, so the union claims it once.
    expect(reported.write.filter((file) => file.path === "AGENTS.md")).toHaveLength(1);
    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    expect(
      receipt.receipt.components
        .find((component) => component.id === SHARED_ONLY.id)
        ?.files.map((file) => file.path),
    ).toEqual([".agents/plugins/marketplace.json", "AGENTS.md"]);
  });

  it("still fires the total-refusal gate when every target refuses every component", async () => {
    // No shared-row component in the selection, so OpenCode — the only target —
    // refuses all of it. That is indistinguishable from "everything was
    // deselected", on which apply would subtract a whole prior install.
    writeGovernedPolicy([...PASSED]);
    const before = snapshot(root);

    const failure = await runLifecycle("install", true, "opencode").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toContain(
      "the OpenCode target refused every evidence-passed component",
    );
    expect(failure?.message).toContain("indistinguishable from deselecting all of them");
    // Every refusal named, not just the count.
    for (const item of PASSED) expect(failure?.message, item.id).toContain(item.id);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
  });

  it("uninstalls the OpenCode materialization and leaves operator content alone", async () => {
    writeGovernedPolicy([...PASSED, SHARED_ONLY]);
    await runLifecycle("install", true, "opencode");
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(true);

    const removed = removeEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed.sort()).toEqual(
      OPENCODE_MATERIALIZED.map((file) => file.destination).sort(),
    );
    for (const file of OPENCODE_MATERIALIZED) {
      expect(existsSync(join(root, ...file.destination.split("/"))), file.destination).toBe(false);
    }
    for (const path of Object.keys(OPERATOR_TREE)) {
      expect(bytesAt(root, path).toString("utf8"), path).toBe(OPERATOR_TREE[path]);
    }
  });
});

describe("the governed framework lifecycle for the Kiro target", () => {
  const KIRO_MATERIALIZED = [
    ".kiro/agents/code-reviewer.json",
    ".kiro/agents/code-reviewer.md",
    ".kiro/skills/tdd-workflow/SKILL.md",
    ".kiro/steering/security.md",
    ".kiro/steering/testing.md",
  ] as const;

  function lockWithoutRuntime() {
    const lock = vendorLock();
    return parseBaselineEvidenceLock({
      ...lock,
      sources: lock.sources.map((source) => ({
        ...source,
        components: source.components.filter((component) => component.id !== KIRO_RUNTIME.id),
      })),
    });
  }

  function lockWithHeldRuntime() {
    const lock = vendorLock();
    return parseBaselineEvidenceLock({
      ...lock,
      sources: lock.sources.map((source) => ({
        ...source,
        components: source.components.map((component) =>
          component.id === KIRO_RUNTIME.id
            ? {
                ...component,
                verdict: "blocked" as const,
                findings: [{ code: "malicious-code", detail: "runtime held by vet" }],
              }
            : component,
        ),
      })),
    });
  }

  it("applies selected agents, skills, and steering with dual evidence", async () => {
    writeGovernedPolicy([...PASSED]);

    const reported = materializationDigest(await runLifecycle("install", true, "kiro"));

    expect(reported.write.map((file) => file.path).sort()).toEqual([...KIRO_MATERIALIZED].sort());
    expect(reported.refused.find((entry) => entry.id === "agent:code-reviewer")).toBeUndefined();
    expect(bytesAt(root, ".kiro/skills/tdd-workflow/SKILL.md").toString("utf8")).toBe(
      "# Kiro tdd-workflow\n",
    );
    const receipt = readEccMaterializationReceipt(root);
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    expect(
      receipt.receipt.components.find((component) => component.id === "skill:tdd-workflow")
        ?.files[0],
    ).toMatchObject({
      contentAuthorization: { componentId: "runtime:ecc-kiro" },
      contentSourcePath: ".kiro/skills/tdd-workflow/SKILL.md",
    });
    expect(
      receipt.receipt.components
        .find((component) => component.id === "agent:code-reviewer")
        ?.files.map((file) => ({
          path: file.path,
          authorization: file.contentAuthorization?.componentId,
          source: file.contentSourcePath,
        })),
    ).toEqual([
      {
        path: ".kiro/agents/code-reviewer.json",
        authorization: "runtime:ecc-kiro",
        source: ".kiro/agents/code-reviewer.json",
      },
      {
        path: ".kiro/agents/code-reviewer.md",
        authorization: "agent:code-reviewer",
        source: "agents/code-reviewer.md",
      },
    ]);
    expect(existsSync(join(root, ".kiro", "agents", "code-reviewer.json"))).toBe(true);
    expect(bytesAt(root, ".kiro/agents/code-reviewer.md").toString("utf8")).toBe(
      "# code-reviewer\n",
    );
    expect(existsSync(join(root, ".kiro", "settings", "mcp.json.example"))).toBe(false);
  });

  it("subtracts a genuinely deselected Kiro surface", async () => {
    writeGovernedPolicy([...PASSED]);
    await runLifecycle("install", true, "kiro");
    expect(existsSync(join(root, ".kiro", "steering", "security.md"))).toBe(true);

    writeGovernedPolicy([PASSED[1] as SelectionFixture]);
    await runLifecycle("install", true, "kiro");

    expect(existsSync(join(root, ".kiro", "skills", "tdd-workflow", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".kiro", "steering", "security.md"))).toBe(false);
    expect(existsSync(join(root, ".kiro", "agents", "code-reviewer.json"))).toBe(false);
    expect(existsSync(join(root, ".kiro", "agents", "code-reviewer.md"))).toBe(false);
  });

  it("is deterministic when the selected Kiro agent is reapplied", async () => {
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    await runLifecycle("install", true, "kiro");
    const settled = snapshot(root);

    const repeated = materializationDigest(await runLifecycle("install", true, "kiro"));

    expect(repeated.write).toEqual([]);
    expect(snapshot(root)).toEqual(settled);
  });

  it("refuses a same-name operator Markdown agent without changing either representation", async () => {
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    writeTree(root, { ".kiro/agents/code-reviewer.md": "# operator Markdown agent\n" });
    const before = snapshot(root);

    const failure = await runLifecycle("install", true, "kiro").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(
      /Kiro agent.*collision|same-name.*agent|unowned.*destination/i,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a case-folded operator JSON agent on case-sensitive filesystems", async () => {
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    writeTree(root, { ".kiro/agents/Code-Reviewer.JSON": '{"name":"operator"}\n' });
    const before = snapshot(root);

    const failure = await runLifecycle("install", true, "kiro").then(
      () => undefined,
      (error: Error) => error,
    );

    expect(failure?.message).toMatch(/Kiro agent.*collision|unowned.*destination/i);
    expect(snapshot(root)).toEqual(before);
  });

  it("uninstalls only the unchanged receipt-owned Kiro agent variants", async () => {
    writeGovernedPolicy([PASSED[0] as SelectionFixture]);
    await runLifecycle("install", true, "kiro");
    writeTree(root, { ".kiro/agents/operator.json": '{"name":"operator"}\n' });

    const removed = removeEccMaterialization(root);

    expect(removed.removed).toContain(".kiro/agents/code-reviewer.json");
    expect(removed.removed).toContain(".kiro/agents/code-reviewer.md");
    expect(existsSync(join(root, ".kiro", "agents", "code-reviewer.json"))).toBe(false);
    expect(existsSync(join(root, ".kiro", "agents", "code-reviewer.md"))).toBe(false);
    expect(bytesAt(root, ".kiro/agents/operator.json").toString("utf8")).toBe(
      '{"name":"operator"}\n',
    );
  });

  it("preserves prior Kiro ownership when runtime evidence is absent or held", async () => {
    writeGovernedPolicy([PASSED[1] as SelectionFixture]);
    await runLifecycle("install", true, "claude,kiro");
    const settled = snapshot(root);

    for (const lock of [lockWithoutRuntime(), lockWithHeldRuntime()]) {
      const failure = await runLifecycle("install", true, "claude,kiro", lock).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(failure?.message).toMatch(/runtime:ecc-kiro|runtime evidence/i);
      expect(snapshot(root)).toEqual(settled);
    }
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
