import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  buildCiscoShardManifest,
  buildCiscoShardResult,
  type CiscoShardJob,
  joinCiscoShardResults,
  verifiedCiscoShardJobSarifV1,
} from "../../src/trust/cisco-shards.js";
import {
  buildCiscoSourceShardManifest,
  type CiscoShardJoinProjectionResultV1,
  joinedCiscoShardSarif,
  type PrecomputedDetectorSarifV1,
  runTrustDetectors,
  type VerifiedCiscoShardSarifV1,
  withCiscoShardJoinProjectionV1,
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

/** Each job's subject (subject-files-v1 digest and file count), by hand. */
type HandSubjects = Readonly<Record<string, readonly [string, number]>>;

const ONE_FILE_JOBS: HandSubjects = Object.fromEntries(
  Object.entries(JOB_SUBJECTS).map(([path, sha]) => [path, [sha, 1] as const]),
);

/** One job's SARIF as Scan returns it, its completion evidence written out by hand. */
function jobSarif(
  job: CiscoShardJob,
  results: readonly unknown[] = [],
  subjects: HandSubjects = ONE_FILE_JOBS,
): Record<string, unknown> {
  const subject = subjects[job.path];
  if (subject === undefined) throw new Error(`no vector for ${job.path}`);
  const [subjectTreeSha256, analyzedFileCount] = subject;
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
                analyzedFileCount,
                analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
              },
            },
          },
        ],
        results: [...results],
      },
    ],
  };
}

/** One Cisco finding in `<job>/SKILL.md`, so a join that loses it is visible. */
function finding(job: CiscoShardJob): Record<string, unknown> {
  return {
    ruleId: "fixture",
    level: "error",
    message: { text: `finding in ${job.path}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: `${job.path}/SKILL.md` },
          region: { startLine: 1 },
        },
      },
    ],
  };
}

function verifiedJoin(root: string, withFindings = false, subjects: HandSubjects = ONE_FILE_JOBS) {
  const manifest = buildCiscoSourceShardManifest(root, {
    source: { id: "fixture", pinnedSha: "a".repeat(40) },
    analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
    policy: { version: "native.test", profile: "fixture" },
    shardCount: 1,
  });
  const results = manifest.shards.map((shard) =>
    buildCiscoShardResult(manifest, shard.id, (job) =>
      jobSarif(job, withFindings ? [finding(job)] : [], subjects),
    ),
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

/** The scan's own result: Core prepared the projection, scanned it and removed it. */
function scanned<T>(outcome: CiscoShardJoinProjectionResultV1<T>): T {
  if (outcome.kind !== "scanned") throw new Error(`expected a scan, got ${outcome.kind}`);
  expect(outcome.cleanupFailure).toBeUndefined();
  return outcome.result;
}

/** A projection that must be prepared, scanned and removed: the scan's own result. */
async function projectScanned<T>(
  ...args: Parameters<typeof withCiscoShardJoinProjectionV1<T>>
): Promise<T> {
  return scanned(await withCiscoShardJoinProjectionV1(...args));
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

  it("refuses join A presented at root B that holds the same jobs and job bytes, whatever a caller passes", async () => {
    const sourceB = mkdtempSync(join(tmpdir(), "aih-shard-binding-b-"));
    roots.push(sourceB);
    cpSync(sourceA, sourceB, { recursive: true });
    writeFileSync(join(sourceB, "outside.md"), "not in any job\n", "utf8");
    // The reviewer's case: a caller names root B for a join verified at A. No
    // exported parameter takes a root, so the extra argument changes nothing.
    const issue = joinedCiscoShardSarif as (...args: unknown[]) => VerifiedCiscoShardSarifV1;
    const issued = issue(verifiedJoin(sourceA), undefined, sourceB);
    const result = await scanCisco(sourceB, issued);
    expectRefused(
      result,
      /the shard join Core verified is bound to source root .+aih-shard-binding-a-.+, not the root being scanned, .+aih-shard-binding-b-/,
    );
  });
});

describe("a verified shard join is rebound only to a projection Core makes itself", () => {
  it("copies the included jobs from the verified root and completes there", async () => {
    let seen: string | undefined;
    const result = await projectScanned(
      verifiedJoin(sourceA),
      ["skills/alpha"],
      async (projection) => {
        seen = projection.root;
        expect(realpathSync.native(dirname(projection.root))).toBe(
          realpathSync.native(dirname(sourceA)),
        );
        expect(readFileSync(join(projection.root, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
          "# alpha\n",
        );
        expect(existsSync(join(projection.root, "skills", "beta"))).toBe(false);
        return scanCisco(projection.root, projection.cisco);
      },
    );
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(seen !== undefined && existsSync(seen)).toBe(false);
  });

  it("refuses the projection's join presented anywhere but the projection", async () => {
    const alphaOnly = mkdtempSync(join(tmpdir(), "aih-shard-binding-alpha-"));
    roots.push(alphaOnly);
    cpSync(join(sourceA, "skills", "alpha"), join(alphaOnly, "skills", "alpha"), {
      recursive: true,
    });
    // While the projection still exists, so the root, not the revocation, refuses it.
    const result = await projectScanned(verifiedJoin(sourceA), ["skills/alpha"], (projection) =>
      scanCisco(alphaOnly, projection.cisco),
    );
    expectRefused(
      result,
      /the shard join Core verified is bound to source root .+, not the root being scanned, .+aih-shard-binding-alpha-/,
    );
  });

  it("refuses the projection when a caller changes a copied job before the scan", async () => {
    const result = await projectScanned(
      verifiedJoin(sourceA),
      ["skills/alpha"],
      async (projection) => {
        writeFileSync(join(projection.root, "skills", "alpha", "SKILL.md"), "# changed\n", "utf8");
        return scanCisco(projection.root, projection.cisco);
      },
    );
    expectRefused(
      result,
      `job skills/alpha was verified with 1 files and subject tree ${JOB_SUBJECTS["skills/alpha"]}, and now has 1 files with subject tree ${ALPHA_CHANGED}`,
    );
  });

  it("refuses the projection's join after the projection is gone, even at a recreated pathname", async () => {
    const leaked = await projectScanned(
      verifiedJoin(sourceA),
      ["skills/alpha"],
      async (projection) => projection,
    );
    expect(existsSync(leaked.root)).toBe(false);
    // Recreate the same pathname with the same job bytes and present the old join there.
    roots.push(leaked.root);
    mkdirSync(join(leaked.root, "skills", "alpha"), { recursive: true });
    writeFileSync(join(leaked.root, "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8");
    const result = await scanCisco(leaked.root, leaked.cisco);
    expectRefused(
      result,
      "the shard join's projection no longer exists: Core removed it when the projection's scan settled",
    );
  });

  it("refuses the projection's join when the projection directory was replaced at the same pathname", async () => {
    const result = await projectScanned(
      verifiedJoin(sourceA),
      ["skills/alpha"],
      async (projection) => {
        const aside = `${projection.root}-aside`;
        roots.push(aside);
        renameSync(projection.root, aside);
        mkdirSync(join(projection.root, "skills", "alpha"), { recursive: true });
        writeFileSync(join(projection.root, "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8");
        return scanCisco(projection.root, projection.cisco);
      },
    );
    expectRefused(
      result,
      /the shard join is bound to the projection directory Core created at .+aih-cisco-shard-projection-.+, and the directory there now is another one/,
    );
  });

  it("refuses the projection when the verified root's job changed after the join", async () => {
    const joined = verifiedJoin(sourceA);
    writeFileSync(join(sourceA, "skills", "alpha", "SKILL.md"), "# changed\n", "utf8");
    const result = await projectScanned(joined, ["skills/alpha"], (projection) =>
      scanCisco(projection.root, projection.cisco),
    );
    expectRefused(
      result,
      `job skills/alpha was verified with 1 files and subject tree ${JOB_SUBJECTS["skills/alpha"]}, and now has 1 files with subject tree ${ALPHA_CHANGED}`,
    );
  });
});

/** The record's shape, as a caller holding the accessor's result could write to it. */
interface WritableJoinRecord {
  root: string;
  jobs: {
    path: string;
    sarif: string;
    subject: { subjectTreeSha256: string; analyzedFileCount: number };
  }[];
}

/** Runs one write against what the accessor returned; a frozen value refuses it, which is the point. */
function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // A frozen record throws in strict mode; the assertions below judge the outcome.
  }
}

/** Evidence-less, zero-findings SARIF that passes the shape check. */
const EVIDENCE_LESS = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "cisco-ai-skill-scanner" } },
      invocations: [{ executionSuccessful: true }],
      results: [],
    },
  ],
});

describe("the verified shard record cannot be changed through its accessor", () => {
  it.each([
    [
      "replacing a job's SARIF with evidence-less zero-findings SARIF",
      (record: WritableJoinRecord) => {
        const job = record.jobs[0];
        if (job !== undefined) job.sarif = EVIDENCE_LESS;
      },
    ],
    [
      "replacing the job list's entries",
      (record: WritableJoinRecord) => {
        record.jobs.splice(0, record.jobs.length);
      },
    ],
    [
      "pushing a job",
      (record: WritableJoinRecord) => {
        record.jobs.push({
          path: "skills/gamma",
          sarif: EVIDENCE_LESS,
          subject: { subjectTreeSha256: "0".repeat(64), analyzedFileCount: 1 },
        });
      },
    ],
    [
      "editing a job's path",
      (record: WritableJoinRecord) => {
        const job = record.jobs[0];
        if (job !== undefined) job.path = "skills/other";
      },
    ],
    [
      "editing a job's verified subject",
      (record: WritableJoinRecord) => {
        const job = record.jobs[0];
        if (job !== undefined) job.subject.subjectTreeSha256 = ALPHA_CHANGED;
      },
    ],
    [
      "editing the verified root",
      (record: WritableJoinRecord) => {
        record.root = "/elsewhere";
      },
    ],
  ])("ignores %s", async (_label, write) => {
    const joined = verifiedJoin(sourceA, true);
    const before = joinedCiscoShardSarif(joined).sarif;
    const returned = verifiedCiscoShardJobSarifV1(joined) as unknown as WritableJoinRecord;
    attempt(() => write(returned));

    const issued = joinedCiscoShardSarif(joined);
    expect(issued.sarif).toBe(before);
    const again = verifiedCiscoShardJobSarifV1(joined);
    expect(again?.jobs.map((job) => job.path)).toEqual(["skills/alpha", "skills/beta"]);
    expect(again?.jobs[0]?.subject.subjectTreeSha256).toBe(JOB_SUBJECTS["skills/alpha"]);
    expect(again?.jobs[0]?.sarif).not.toBe(EVIDENCE_LESS);
    const result = await scanCisco(sourceA, issued);
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(result.rawOccurrences.map((occurrence) => occurrence.location?.uri).sort()).toEqual([
      "skills/alpha/SKILL.md",
      "skills/beta/SKILL.md",
    ]);
  });
});

// Nested jobs: skills/a holds skills/a/nested, so job skills/a's subject has
// both files. skills/c is no job; only skills/c/nested is. Digests by hand.
const NESTED_FILES = {
  "skills/a/SKILL.md": "# a\n",
  "skills/a/nested/SKILL.md": "# nested\n",
  "skills/b/SKILL.md": "# b\n",
  "skills/c/README.md": "# c\n",
  "skills/c/nested/SKILL.md": "# c nested\n",
} as const;
const NESTED_SUBJECTS: HandSubjects = {
  "skills/a": ["b26d6d6c70b92f699fea319a857b3c4fc58c5b872aea0d4c2ca9685ca1638d0e", 2],
  "skills/a/nested": ["f5a106be33b9b7102276fd376a3da45e9aaf465bedb42245422f218e3e326f81", 1],
  "skills/b": ["635898ed6dddcd65f5d834bc0ef417153166563c5b670f2aecc57cb0952c308e", 1],
  "skills/c/nested": ["b423cac7ed29f94ab01e6806108efe6d993cabd66ff9b72effda17ec74cfb3b1", 1],
};

/**
 * A valid join over overlapping jobs, built from an explicit manifest as
 * `buildCiscoShardManifest` accepts it (the source-tree builder never nests jobs).
 */
function nestedJoin(root: string, withFindings: boolean) {
  const manifest = buildCiscoShardManifest({
    source: { id: "fixture", pinnedSha: "a".repeat(40), treeSha256: "e".repeat(64) },
    analyzer: { name: "cisco", version: "2.0.14", lockSha256: CISCO_LOCK },
    policy: { version: "native.test", profile: "fixture" },
    jobs: Object.keys(NESTED_SUBJECTS).map((path, index) => ({
      path,
      inputSha256: String(index + 1).repeat(64),
    })),
    shardCount: 2,
  });
  const results = manifest.shards.map((shard) =>
    buildCiscoShardResult(manifest, shard.id, (job) =>
      jobSarif(job, withFindings ? [finding(job)] : [], NESTED_SUBJECTS),
    ),
  );
  return joinCiscoShardResults(manifest, results, root);
}

function nestedTree(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-shard-binding-nested-"));
  roots.push(root);
  for (const [path, body] of Object.entries(NESTED_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
  return root;
}

describe("a projection copies only the outermost selected jobs and still verifies every one", () => {
  it.each([
    ["a parent and its nested child", ["skills/a"], ["skills/a", "skills/a/nested"]],
    ["a nested child whose parent is no job", ["skills/c/nested"], ["skills/c/nested"]],
    ["siblings", ["skills/a/nested", "skills/b"], ["skills/a", "skills/a/nested", "skills/b"]],
  ] as const)("completes for %s", async (_label, included, jobs) => {
    const source = nestedTree();
    const result = await projectScanned(nestedJoin(source, true), included, async (projection) => {
      for (const path of Object.keys(NESTED_FILES))
        expect(existsSync(join(projection.root, path))).toBe(
          jobs.some((job) => path.startsWith(`${job}/`)),
        );
      return scanCisco(projection.root, projection.cisco);
    });
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(
      [...new Set(result.rawOccurrences.map((occurrence) => occurrence.location?.uri))].sort(),
    ).toEqual(jobs.map((job) => `${job}/SKILL.md`));
  });

  it("rehashes a nested job selected with its parent", async () => {
    const source = nestedTree();
    const result = await projectScanned(
      nestedJoin(source, false),
      ["skills/a"],
      async (projection) => {
        writeFileSync(join(projection.root, "skills", "a", "nested", "SKILL.md"), "# a\n", "utf8");
        return scanCisco(projection.root, projection.cisco);
      },
    );
    // skills/a/nested/SKILL.md now holds "# a\n"; both bound jobs see it.
    expectRefused(
      result,
      /the tree changed after Core verified the shard join: job skills\/a(\/nested)? was verified with/,
    );
  });
});
