import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  buildCiscoShardResult,
  type CiscoShardJob,
  joinCiscoShardResults,
} from "../../src/trust/cisco-shards.js";
import {
  buildCiscoSourceShardManifest,
  joinedCiscoShardSarif,
  type PrecomputedDetectorSarifV1,
  runTrustDetectors,
} from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

// ---------------------------------------------------------------------------
// A verified Cisco shard join is exempt from the one-subject check only for
// the tree it was verified against: the same source root, the same job set,
// and every job's subject (subject-files-v1) unchanged since the join.
// Job digests are computed by hand with plain node:crypto over the contract
// framing, `UTF-8(path) || 0x00 || sha256 || 0x0A`, never Core's subject code.
// ---------------------------------------------------------------------------

const CISCO_LOCK = "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f";
const JOB_FILES = {
  "skills/alpha": { "skills/alpha/SKILL.md": "# alpha\n" },
  "skills/beta": { "skills/beta/SKILL.md": "# beta\n" },
} as const;
/** subject-files-v1 of each job's one file, by hand. */
const JOB_SUBJECTS: Readonly<Record<string, string>> = {
  "skills/alpha": "439283bdb63ecb24c6a5af487d4a88163b4a7de486efa7d844cb1fb6e0db379a",
  "skills/beta": "6637d24866ca58da16b6396feba0a0f7f3160d15c9f7ae0bcb99fb88e426f911",
};
/** `skills/alpha/SKILL.md` holding "# changed\n", by hand. */
const ALPHA_CHANGED = "00e7f471ec84d2321539f39b88be291086c98e33f7fd61f060637e4e1615c8e9";

const roots: string[] = [];
let sourceA: string;

function tree(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  for (const files of Object.values(JOB_FILES)) {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), body, "utf8");
    }
  }
  return root;
}

beforeEach(() => {
  sourceA = tree("aih-shard-binding-a-");
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One job's SARIF as Scan returns it, its completion evidence written out by hand. */
function jobSarif(job: CiscoShardJob): Record<string, unknown> {
  const subjectTreeSha256 = JOB_SUBJECTS[job.path];
  if (subjectTreeSha256 === undefined) throw new Error(`no vector for ${job.path}`);
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "cisco-ai-skill-scanner" } },
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              aihScanCompletionV1: {
                detectorId: "detector.cisco",
                subjectTreeSha256,
                analyzedFileCount: 1,
                analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
              },
            },
          },
        ],
        results: [],
      },
    ],
  };
}

function verifiedJoin(root: string) {
  const manifest = buildCiscoSourceShardManifest(root, {
    source: { id: "fixture", pinnedSha: "a".repeat(40) },
    analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
    policy: { version: "native.test", profile: "fixture" },
    shardCount: 1,
  });
  const results = manifest.shards.map((shard) =>
    buildCiscoShardResult(manifest, shard.id, jobSarif),
  );
  return joinCiscoShardResults(manifest, results, root);
}

async function scanCisco(root: string, cisco: PrecomputedDetectorSarifV1) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: ["cisco"],
    requiredDetectors: ["cisco"],
    precomputedSarif: { cisco },
  });
}

function ciscoCheck(checks: readonly Check[]): Check | undefined {
  return checks.find((check) => check.name === "trust detector cisco");
}

function expectRefused(
  result: Awaited<ReturnType<typeof scanCisco>>,
  reason: string | RegExp,
): void {
  expect(result.executions).toEqual([
    { detector: "cisco", executedBy: "precomputed-sarif", outcome: "failed" },
  ]);
  const detail = ciscoCheck(result.checks)?.detail ?? "";
  expect(detail).toContain("precomputed SARIF for detector.cisco is refused: ");
  if (typeof reason === "string") expect(detail).toContain(reason);
  else expect(detail).toMatch(reason);
}

describe("a verified Cisco shard join is bound to the tree it was verified against", () => {
  it("completes for the root, job set and job subjects it was verified against", async () => {
    const result = await scanCisco(sourceA, joinedCiscoShardSarif(verifiedJoin(sourceA)));
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
  });

  it("refuses a join verified for root A presented while scanning root B, even with equal bytes", async () => {
    const sourceB = mkdtempSync(join(tmpdir(), "aih-shard-binding-b-"));
    roots.push(sourceB);
    cpSync(sourceA, sourceB, { recursive: true });
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA));
    const result = await scanCisco(sourceB, issued);
    expectRefused(
      result,
      /the shard join Core verified is bound to source root .+aih-shard-binding-a-.+, not the root being scanned, .+aih-shard-binding-b-/,
    );
  });

  it("refuses a join whose root changed a job's files after the join and before the scan", async () => {
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA));
    writeFileSync(join(sourceA, "skills", "alpha", "SKILL.md"), "# changed\n", "utf8");
    const result = await scanCisco(sourceA, issued);
    expectRefused(
      result,
      `the tree changed after Core verified the shard join: job skills/alpha was verified with 1 files and subject tree ${JOB_SUBJECTS["skills/alpha"]}, and now has 1 files with subject tree ${ALPHA_CHANGED}`,
    );
  });

  it("refuses a join after a job was added to the tree", async () => {
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA));
    mkdirSync(join(sourceA, "skills", "gamma"), { recursive: true });
    writeFileSync(join(sourceA, "skills", "gamma", "SKILL.md"), "# gamma\n", "utf8");
    const result = await scanCisco(sourceA, issued);
    expectRefused(
      result,
      "the shard join Core verified covers jobs skills/alpha, skills/beta, and the tree being scanned has jobs skills/alpha, skills/beta, skills/gamma (added: skills/gamma; removed: none)",
    );
  });

  it("refuses a join after a job was removed from the tree", async () => {
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA));
    rmSync(join(sourceA, "skills", "beta"), { recursive: true, force: true });
    const result = await scanCisco(sourceA, issued);
    expectRefused(
      result,
      "the shard join Core verified covers jobs skills/alpha, skills/beta, and the tree being scanned has jobs skills/alpha (added: none; removed: skills/beta)",
    );
  });

  it("refuses a join presented for a projection root whose job files differ from the verified ones", async () => {
    const projection = mkdtempSync(join(tmpdir(), "aih-shard-binding-projection-"));
    roots.push(projection);
    mkdirSync(join(projection, "skills", "alpha"), { recursive: true });
    writeFileSync(join(projection, "skills", "alpha", "SKILL.md"), "# changed\n", "utf8");
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA), ["skills/alpha"], projection);
    const result = await scanCisco(projection, issued);
    expectRefused(
      result,
      `job skills/alpha was verified with 1 files and subject tree ${JOB_SUBJECTS["skills/alpha"]}, and now has 1 files with subject tree ${ALPHA_CHANGED}`,
    );
  });

  it("completes for a projection root that holds exactly the included jobs' verified files", async () => {
    const projection = mkdtempSync(join(tmpdir(), "aih-shard-binding-projection-"));
    roots.push(projection);
    mkdirSync(join(projection, "skills", "alpha"), { recursive: true });
    writeFileSync(join(projection, "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8");
    const issued = joinedCiscoShardSarif(verifiedJoin(sourceA), ["skills/alpha"], projection);
    const result = await scanCisco(projection, issued);
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
  });
});
