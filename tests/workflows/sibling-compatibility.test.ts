import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import * as core from "../../src/index.js";
import {
  buildCompatibilityArtifact,
  COMBINATIONS,
  CONTRACT_CHECK_IDS,
  type CompatibilityBaseline,
  type ContractCheckResult,
  planCombinations,
  READER_REQUIRED_CHECKS,
  renderStepSummary,
  runContractChecks,
  selectTrio,
  validateBaseline,
  validateLegReport,
} from "../../tools/sibling-compatibility-checks.mjs";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | readonly string[];
  if?: string;
  "continue-on-error"?: string;
  outputs?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: Record<string, unknown> };
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const root = resolve(import.meta.dirname, "../..");
const raw = readFileSync(resolve(root, ".github/workflows/sibling-compatibility.yml"), "utf8");

describe("sibling-compatibility workflow file", () => {
  const document = parseDocument(raw);
  const workflow = document.toJSON() as Workflow;
  const scriptsOf = (job: Job | undefined) =>
    (job?.steps ?? []).map((step) => step.run ?? "").join("\n");

  it("is scheduled and dispatchable, read-only, and pins every action to a full commit", () => {
    expect(document.errors).toEqual([]);
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      for (const step of job.steps) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/u);
        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
    for (const line of raw.split("\n").filter((text) => text.includes("uses:")))
      expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
  });

  it("never runs aih, and reaches the siblings only through tarballs it packs", () => {
    const scripts = Object.values(workflow.jobs).map(scriptsOf).join("\n");
    expect(scripts).not.toMatch(/(?:^|[\s;&|(])(?:npx\s+)?aih(?:-scan|-supported)?\s/mu);
    expect(scripts).not.toMatch(/dist\/cli\.js|src\/cli\.ts|npm link/u);
    expect(scripts).toContain("--ignore-scripts");
    expect(scripts).toContain("tools/sibling-compatibility-checks.mjs");
  });

  it("resolves the registry once, then runs one combination job per runnable id", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "branch-tarballs",
      "combinations",
      "resolve",
      "summary",
    ]);
    const resolveJob = workflow.jobs.resolve;
    const step = resolveJob?.steps.find((candidate) => candidate.run?.includes(" resolve "));
    expect(step?.id).toBeDefined();
    expect(step?.run).toContain("resolve --out baseline/baseline.json");
    expect(step?.run).toContain('>> "$GITHUB_OUTPUT"');
    expect(resolveJob?.outputs).toEqual({
      combinations: `\${{ steps.${step?.id}.outputs.combinations }}`,
    });
    expect(
      resolveJob?.steps.find((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"))
        ?.with,
    ).toMatchObject({ name: "sibling-baseline", path: "baseline/baseline.json" });

    const combinations = workflow.jobs.combinations;
    expect(combinations?.needs).toEqual(["resolve"]);
    // An empty matrix is an error on GitHub: skip the job, and let the summary report it.
    expect(combinations?.if).toBe("${{ needs.resolve.outputs.combinations != '[]' }}");
    expect(combinations?.strategy).toEqual({
      "fail-fast": false,
      matrix: { combination: "${{ fromJSON(needs.resolve.outputs.combinations) }}" },
    });
    // Check results are recorded, not gating: nothing masks a failure to run.
    expect(combinations?.["continue-on-error"]).toBeUndefined();
    const legScript = scriptsOf(combinations);
    expect(legScript).toContain('leg --kind registry --combination "$COMBINATION"');
    expect(legScript).toContain("--baseline baseline/baseline.json");
    expect(legScript).not.toMatch(/--tag\b/u);
    expect(
      combinations?.steps.find((candidate) =>
        candidate.uses?.startsWith("actions/download-artifact@"),
      )?.with,
    ).toMatchObject({ name: "sibling-baseline", path: "baseline" });

    expect(workflow.jobs["branch-tarballs"]?.strategy?.matrix).toEqual({
      os: ["ubuntu-latest", "windows-latest"],
      node: ["20", "22", "24"],
    });
  });

  it("summarizes whatever finished, into the artifact and the run page", () => {
    const summary = workflow.jobs.summary;
    expect(summary?.needs).toEqual(["resolve", "combinations", "branch-tarballs"]);
    expect(summary?.if).toBe("${{ !cancelled() }}");
    const script = scriptsOf(summary);
    expect(script).toContain("summarize --baseline baseline/baseline.json --legs legs");
    expect(script).toContain('--step-summary "$GITHUB_STEP_SUMMARY"');
    const upload = summary?.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    // The name and file the sibling promotion gates download.
    expect(upload?.with).toMatchObject({
      name: "core-sibling-compatibility",
      path: "compatibility/core-sibling-compatibility.json",
    });
    expect(raw).toContain("RUN_ID: ${{ github.run_id }}");
    expect(raw).toContain("RUN_ATTEMPT: ${{ github.run_attempt }}");
  });

  it("states the combinations, recorded results, owner bootstrap and reader-gated upgrades", () => {
    const header = raw.slice(0, raw.indexOf("\non:"));
    for (const id of COMBINATIONS) expect(header).toContain(id);
    expect(header).toContain("current Core");
    expect(header).toMatch(/recorded/u);
    expect(header).toMatch(/readers gate/u);
    expect(header).toContain("owner-approved bootstrap in the order Catalog, then Core, then Scan");
    expect(header).toContain(
      "After the bootstrap each sibling promotes on its own through its reader",
    );
    expect(header).not.toContain("version:1");
  });
});

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const integrity = (seed: number) => `sha512-${Buffer.alloc(64, seed).toString("base64")}`;
const allPassed = (): ContractCheckResult[] =>
  CONTRACT_CHECK_IDS.map((id) => ({ id, status: "passed" as const }));

type Pkg = "@aihq/core" | "@aihq/scan" | "@aihq/catalog";
const VERSIONS: Record<Pkg, { latest: string; next: string }> = {
  "@aihq/core": { latest: "0.6.2", next: "0.7.0" },
  "@aihq/scan": { latest: "0.4.0", next: "0.5.0" },
  "@aihq/catalog": { latest: "0.2.0", next: "0.3.0" },
};
const SEED: Record<Pkg, number> = { "@aihq/core": 1, "@aihq/scan": 2, "@aihq/catalog": 3 };
const bytesOf = (name: Pkg, tag: "latest" | "next") => ({
  version: VERSIONS[name][tag],
  tarballIntegrity: integrity(SEED[name] * 10 + (tag === "next" ? 1 : 0)),
  tarballSha256: sha(`${SEED[name]}${tag === "next" ? "b" : "a"}`),
});

/** A resolved baseline in which every package has `latest` and the named ones have `next`. */
function baselineWith(nextFor: readonly Pkg[]): CompatibilityBaseline {
  const packages = Object.fromEntries(
    (Object.keys(VERSIONS) as Pkg[]).map((name) => {
      const { version, tarballIntegrity } = bytesOf(name, "latest");
      const next = bytesOf(name, "next");
      return [
        name,
        {
          latest: { version, tarballIntegrity },
          next: nextFor.includes(name)
            ? { version: next.version, tarballIntegrity: next.tarballIntegrity }
            : null,
        },
      ];
    }),
  );
  return {
    format: "core-sibling-compatibility-baseline",
    version: 1,
    resolvedAt: "2026-09-23T05:17:41.000Z",
    packages,
    combinations: planCombinations(packages),
  } as CompatibilityBaseline;
}

/** A leg report for one registry combination, built from the trio `selectTrio` names. */
function registryReport(
  baseline: CompatibilityBaseline,
  combination: string,
  checks: ContractCheckResult[] = allPassed(),
) {
  return {
    leg: "registry",
    combination,
    status: "tested",
    os: "ubuntu-latest",
    node: "22",
    npm: "11.6.2",
    packages: selectTrio(baseline, combination).map((entry) => ({
      package: entry.package,
      version: entry.version,
      distTag: entry.distTag,
      role: entry.role,
      tarballSha256: bytesOf(entry.package as Pkg, entry.distTag).tarballSha256,
      tarballIntegrity: entry.tarballIntegrity,
      source: { kind: "registry", tag: entry.distTag },
    })),
    lockfileSha256: sha(combination.length.toString(16)),
    contractChecks: checks,
  };
}

function branchReport(os = "ubuntu-latest", node = "22") {
  return {
    leg: "branch",
    combination: "branch",
    status: "tested",
    os,
    node,
    packages: (Object.keys(VERSIONS) as Pkg[]).map((name, index) => ({
      package: name,
      version: VERSIONS[name].next,
      role: "branch",
      tarballSha256: sha(String(index + 5)),
      tarballIntegrity: integrity(index + 50),
      source: { kind: "git", commit: String(index).repeat(40) },
    })),
    lockfileSha256: sha("e"),
    contractChecks: allPassed(),
  };
}

const build = (baseline: CompatibilityBaseline, reports: unknown[]) =>
  buildCompatibilityArtifact({
    runId: "35733767496",
    runAttempt: 1,
    core: { repository: "samartomar/ai-harness", commit: "a".repeat(40) },
    baseline,
    reports,
  });

/** The Scan / Catalog reader's selection (WO §5 steps 1, 3, 5, 6), replayed over the artifact. */
function readerSelects(artifact: unknown, name: "scan" | "catalog") {
  const document = artifact as {
    format?: unknown;
    version?: unknown;
    candidates?: unknown;
  };
  if (document.format !== "core-sibling-compatibility" || document.version !== 2)
    return "unknown format or version";
  if (!Array.isArray(document.candidates)) return "unknown format or version";
  const matches = (
    document.candidates as Array<{
      combination?: string;
      candidate?: { package?: string };
      baseline?: Array<{ package?: string; distTag?: string }>;
      contractChecks?: Array<{ id?: string; status?: string }>;
    }>
  ).filter(
    (entry) =>
      entry.combination === `${name}-candidate` && entry.candidate?.package === `@aihq/${name}`,
  );
  if (matches.length !== 1) return "no single candidate";
  const [entry] = matches;
  const others = (entry?.baseline ?? []).map((item) => `${item.package}@${item.distTag}`).sort();
  const expected = ["@aihq/core", "@aihq/scan", "@aihq/catalog"]
    .filter((item) => item !== `@aihq/${name}`)
    .map((item) => `${item}@latest`)
    .sort();
  if (JSON.stringify(others) !== JSON.stringify(expected)) return "baseline mismatch";
  const bad = READER_REQUIRED_CHECKS[`@aihq/${name}`].filter(
    (id) =>
      (entry?.contractChecks ?? []).filter((check) => check.id === id && check.status === "passed")
        .length !== 1,
  );
  return bad.length === 0 ? "READY" : `not passed: ${bad.join(",")}`;
}

describe("the resolved baseline and the runnable combinations", () => {
  it("runs a candidate only for a package that has next, against the others at latest", () => {
    expect(baselineWith([]).combinations).toEqual(["baseline"]);
    expect(baselineWith(["@aihq/scan"]).combinations).toEqual(["baseline", "scan-candidate"]);
    expect(baselineWith(["@aihq/scan", "@aihq/catalog"]).combinations).toEqual([
      "baseline",
      "scan-candidate",
      "catalog-candidate",
      "all-next",
    ]);
    expect(baselineWith(["@aihq/core", "@aihq/scan", "@aihq/catalog"]).combinations).toEqual([
      "baseline",
      "scan-candidate",
      "catalog-candidate",
      "core-candidate",
      "all-next",
    ]);
    // No package on the registry at all: nothing is runnable, and the summary still runs.
    expect(
      planCombinations({
        "@aihq/core": { latest: null, next: null },
        "@aihq/scan": { latest: null, next: null },
        "@aihq/catalog": { latest: null, next: null },
      }),
    ).toEqual([]);
  });

  it("selects the current Core for every sibling candidate, never Core at next", () => {
    const baseline = baselineWith(["@aihq/core", "@aihq/scan", "@aihq/catalog"]);
    const scan = selectTrio(baseline, "scan-candidate");
    expect(scan.map((entry) => [entry.package, entry.distTag, entry.role])).toEqual([
      ["@aihq/core", "latest", "baseline"],
      ["@aihq/scan", "next", "candidate"],
      ["@aihq/catalog", "latest", "baseline"],
    ]);
    expect(scan[0]?.version).toBe("0.6.2");
    expect(selectTrio(baseline, "all-next").map((entry) => entry.distTag)).toEqual([
      "next",
      "next",
      "next",
    ]);
    expect(() => selectTrio(baselineWith([]), "scan-candidate")).toThrow(/not runnable/u);
    expect(() => selectTrio(baseline, "branch")).toThrow();
  });

  it("refuses a baseline whose combinations disagree with its own tags", () => {
    const good = baselineWith(["@aihq/scan"]);
    expect(validateBaseline(good)).toBe(good);
    for (const bad of [
      { ...good, version: 2 },
      { ...good, combinations: ["baseline", "scan-candidate", "all-next"] },
      { ...good, resolvedAt: "yesterday" },
      {
        ...good,
        packages: { ...good.packages, "@aihq/core": { latest: { version: "x" }, next: null } },
      },
    ])
      expect(() => validateBaseline(bad)).toThrow();
  });
});

describe("core-sibling-compatibility.json version 2", () => {
  const everyNext = baselineWith(["@aihq/core", "@aihq/scan", "@aihq/catalog"]);

  it("(a) makes no Scan candidate from a passing all-next run", () => {
    const artifact = build(everyNext, [registryReport(everyNext, "all-next")]);
    expect(artifact.candidates.filter((entry) => entry.candidate.package === "@aihq/scan")).toEqual(
      [],
    );
    expect(readerSelects(artifact, "scan")).toBe("no single candidate");
    expect(readerSelects(artifact, "catalog")).toBe("no single candidate");
  });

  it("(b) keeps a failed Scan-candidate check next to a passing all-next run", () => {
    const failed = allPassed().map((check) =>
      check.id === "scan-decision-schema-lock" ? { ...check, status: "failed" as const } : check,
    );
    const artifact = build(everyNext, [
      registryReport(everyNext, "all-next"),
      registryReport(everyNext, "scan-candidate", failed),
    ]);
    const [scan] = artifact.candidates.filter((entry) => entry.candidate.package === "@aihq/scan");
    expect(scan?.combination).toBe("scan-candidate");
    expect(
      scan?.contractChecks.find((check) => check.id === "scan-decision-schema-lock")?.status,
    ).toBe("failed");
    expect(readerSelects(artifact, "scan")).toBe("not passed: scan-decision-schema-lock");
  });

  it("(c) refuses a scan-candidate report whose Core or Catalog is at next", () => {
    const good = registryReport(everyNext, "scan-candidate");
    expect(validateLegReport(good)).toBe(good);
    for (const index of [0, 2]) {
      const moved = {
        ...good,
        packages: good.packages.map((entry, at) =>
          at === index ? { ...entry, distTag: "next" } : entry,
        ),
      };
      expect(() => validateLegReport(moved)).toThrow(/baseline/u);
    }
    // A candidate role that is not at next, or a second candidate, is refused too.
    expect(() =>
      validateLegReport({
        ...good,
        packages: good.packages.map((entry) => ({ ...entry, role: "candidate", distTag: "next" })),
      }),
    ).toThrow();
  });

  it("(d) names the candidate at next and the other two at latest, with the tested environment", () => {
    const baseline = baselineWith(["@aihq/scan", "@aihq/catalog"]);
    const artifact = build(baseline, [
      registryReport(baseline, "baseline"),
      registryReport(baseline, "catalog-candidate"),
      registryReport(baseline, "scan-candidate"),
    ]);
    expect(artifact.candidates.map((entry) => entry.combination)).toEqual([
      "scan-candidate",
      "catalog-candidate",
    ]);
    const [scan, catalog] = artifact.candidates;
    expect(scan?.candidate).toEqual({
      package: "@aihq/scan",
      distTag: "next",
      ...bytesOf("@aihq/scan", "next"),
    });
    expect(scan?.candidate.version).toBe("0.5.0");
    expect(scan?.baseline).toEqual([
      { package: "@aihq/core", distTag: "latest", ...bytesOf("@aihq/core", "latest") },
      { package: "@aihq/catalog", distTag: "latest", ...bytesOf("@aihq/catalog", "latest") },
    ]);
    expect(catalog?.baseline.map((entry) => `${entry.package}@${entry.version}`)).toEqual([
      "@aihq/core@0.6.2",
      "@aihq/scan@0.4.0",
    ]);
    expect(scan?.environment).toEqual({ os: "ubuntu-latest", node: "22", npm: "11.6.2" });
    // One lockfile per combination, never shared.
    expect(scan?.lockfileSha256).not.toBe(catalog?.lockfileSha256);
    expect(readerSelects(artifact, "scan")).toBe("READY");
    expect(readerSelects(artifact, "catalog")).toBe("READY");
  });

  it("(e) makes no candidate from a baseline, branch or all-next report alone", () => {
    for (const report of [
      registryReport(everyNext, "baseline"),
      registryReport(everyNext, "all-next"),
      branchReport(),
    ]) {
      const artifact = build(everyNext, [report]);
      expect(artifact.candidates).toEqual([]);
      expect(artifact.observations).toHaveLength(1);
    }
  });

  it("(f) refuses two reports for one combination, but keeps one branch report per OS and Node", () => {
    expect(() =>
      build(everyNext, [
        registryReport(everyNext, "scan-candidate"),
        registryReport(everyNext, "scan-candidate"),
      ]),
    ).toThrow(/more than one report for scan-candidate/u);
    expect(
      build(everyNext, [branchReport("ubuntu-latest", "22"), branchReport("windows-latest", "22")])
        .observations,
    ).toHaveLength(2);
    expect(() => build(everyNext, [branchReport(), branchReport()])).toThrow(/more than one/u);
  });

  it("(g) writes the v2 literals and the exact shape the readers select on", () => {
    const baseline = baselineWith(["@aihq/scan"]);
    const artifact = build(baseline, [
      registryReport(baseline, "baseline"),
      registryReport(baseline, "scan-candidate"),
      branchReport(),
    ]);
    expect(Object.keys(artifact)).toEqual([
      "format",
      "version",
      "runId",
      "runAttempt",
      "core",
      "resolvedAt",
      "baseline",
      "candidates",
      "observations",
      "limitation",
    ]);
    expect(artifact).toMatchObject({
      format: "core-sibling-compatibility",
      version: 2,
      runId: "35733767496",
      runAttempt: "1",
      core: { repository: "samartomar/ai-harness", commit: "a".repeat(40) },
      resolvedAt: "2026-09-23T05:17:41.000Z",
    });
    expect(artifact.baseline["@aihq/scan"]).toEqual({
      latest: bytesOf("@aihq/scan", "latest"),
      next: bytesOf("@aihq/scan", "next"),
    });
    expect(artifact.baseline["@aihq/core"]?.next).toBeNull();
    const [entry] = artifact.candidates;
    expect(Object.keys(entry ?? {})).toEqual([
      "combination",
      "candidate",
      "baseline",
      "environment",
      "lockfileSha256",
      "contractChecks",
    ]);
    // Every check in the producer's order, {id, status} only.
    expect(entry?.contractChecks).toEqual(allPassed());
    expect(artifact.observations.map((report) => [report.leg, report.combination])).toEqual([
      ["registry", "baseline"],
      ["registry", "scan-candidate"],
      ["branch", "branch"],
    ]);
    expect(
      artifact.observations[1]?.packages.map((item) => [item.package, item.role, item.distTag]),
    ).toEqual([
      ["@aihq/core", "baseline", "latest"],
      ["@aihq/scan", "candidate", "next"],
      ["@aihq/catalog", "baseline", "latest"],
    ]);
    // Version 1 is gone: no promotable `legs`.
    expect(artifact).not.toHaveProperty("legs");
    // Each reader requires only its own package's checks plus Core's, all producer ids.
    for (const ids of Object.values(READER_REQUIRED_CHECKS))
      for (const id of ids) expect(CONTRACT_CHECK_IDS).toContain(id);
  });

  it("refuses a registry report that did not test the bytes baseline.json names", () => {
    const baseline = baselineWith(["@aihq/scan"]);
    const report = registryReport(baseline, "scan-candidate");
    const otherVersion = {
      ...report,
      packages: report.packages.map((entry, index) =>
        index === 0 ? { ...entry, version: "0.6.3" } : entry,
      ),
    };
    const otherBytes = {
      ...report,
      packages: report.packages.map((entry, index) =>
        index === 1 ? { ...entry, tarballIntegrity: integrity(99) } : entry,
      ),
    };
    for (const bad of [otherVersion, otherBytes])
      expect(() => build(baseline, [bad])).toThrow(/baseline\.json/u);
    // A combination the resolve job did not name as runnable.
    expect(() => build(baseline, [registryReport(everyNext, "catalog-candidate")])).toThrow(
      /not runnable/u,
    );
  });

  it("refuses a malformed leg report rather than recording it", () => {
    const good = registryReport(everyNext, "baseline");
    for (const bad of [
      null,
      { ...good, leg: "registry-next" },
      { ...good, combination: "sideways" },
      { ...good, leg: "branch" },
      { ...good, status: "tag-absent" },
      { ...good, os: "" },
      { ...good, node: undefined },
      { ...good, lockfileSha256: "short" },
      { ...good, contractChecks: [] },
      { ...good, contractChecks: allPassed().slice(1) },
      { ...good, contractChecks: [...allPassed()].reverse() },
      { ...good, contractChecks: allPassed().map((check) => ({ ...check, status: "pass" })) },
      {
        ...good,
        packages: good.packages.map((entry) => ({ ...entry, tarballIntegrity: "sha1-x" })),
      },
      { ...good, packages: good.packages.slice(1) },
      { ...good, packages: [...good.packages.slice(1), good.packages[1]] },
      {
        ...good,
        packages: [{ ...good.packages[0], package: "@evil/pkg" }, ...good.packages.slice(1)],
      },
      {
        ...branchReport(),
        packages: branchReport().packages.map((entry) => ({ ...entry, distTag: "next" })),
      },
    ])
      expect(() => validateLegReport(bad)).toThrow();
    expect(() =>
      buildCompatibilityArtifact({
        runId: "x",
        runAttempt: 1,
        core: {},
        baseline: everyNext,
        reports: [],
      }),
    ).toThrow();
  });

  it("writes a run-page summary naming every combination and every check not passed", () => {
    const baseline = baselineWith(["@aihq/scan", "@aihq/catalog"]);
    const unavailable = allPassed().map((check) =>
      check.id === "scan-custody-negative" ? { ...check, status: "unavailable" as const } : check,
    );
    const artifact = build(baseline, [
      registryReport(baseline, "baseline", unavailable),
      registryReport(baseline, "scan-candidate"),
      branchReport(),
    ]);
    const markdown = renderStepSummary(artifact, baseline);
    expect(markdown).toContain("current Core: `@aihq/core@0.6.2`");
    expect(markdown).toMatch(
      /\| baseline \| tested \|[^\n]*`scan-custody-negative` \(unavailable\)/u,
    );
    expect(markdown).toMatch(/\| scan-candidate \| tested \|[^\n]*\| none \|/u);
    // Runnable but no report: its job could not obtain, install or run the trio.
    expect(markdown).toMatch(/\| catalog-candidate \| no report/u);
    expect(markdown).toMatch(/\| all-next \| no report/u);
    expect(markdown).toContain("branch (ubuntu-latest, node 22)");
    expect(markdown).toMatch(/readers gate/u);

    const absent = { latest: null, next: null };
    const empty = {
      ...baselineWith([]),
      packages: { "@aihq/core": absent, "@aihq/scan": absent, "@aihq/catalog": absent },
      combinations: [],
    } as unknown as CompatibilityBaseline;
    const nothing = renderStepSummary(build(empty, [branchReport()]), empty);
    expect(nothing).toMatch(/no registry combination was runnable/iu);
    expect(nothing).toContain("branch (ubuntu-latest, node 22)");
  });
});

describe("the contract checks, run against this Core and the installed Scan", () => {
  it("passes Core's own checks and reports every absent sibling surface as unavailable", async () => {
    const scan = (await import("@aihq/scan")) as unknown as Record<string, unknown>;
    const results = await runContractChecks({
      core: core as unknown as Record<string, unknown>,
      scan,
      catalog: {},
      readSubpath: (specifier) => {
        const schema = /^@aihq\/core\/schemas\/(.+)$/u.exec(specifier)?.[1];
        if (schema === undefined)
          throw Object.assign(new Error(`${specifier} is not installed`), { code: "ENOENT" });
        return readFileSync(resolve(root, "schemas", schema));
      },
    });
    // Every id, in the producer's order: the order the artifact records.
    expect(results.map((result) => result.id)).toEqual([...CONTRACT_CHECK_IDS]);
    const status = Object.fromEntries(results.map((result) => [result.id, result.status]));
    expect(status).toEqual({
      "catalog-readers": "unavailable",
      "catalog-subject-digests": "unavailable",
      "scan-organization-evidence-schema-lock": "passed",
      "scan-decision-schema-lock": "passed",
      "catalog-decision-schema-lock": "unavailable",
      "catalog-qualification-receipt-schema-lock": "unavailable",
      "supported-clis-shape": "passed",
      "refusal-input-unknown-version": "passed",
      "refusal-evidence-unknown-version": "passed",
      "refusal-scan-core-contract-unknown": "passed",
      "refusal-catalog-index-unknown-version": "unavailable",
      // @aihq/scan 0.4.0 predates that export; the 0.5 line has it and it must refuse.
      "scan-custody-negative":
        typeof scan.coreOrganizationEvidenceEnvelopeDigestV1 === "function"
          ? "passed"
          : "unavailable",
    });
  });

  it("fails a check whose refusal is not the named code, never passing it", async () => {
    const scan = (await import("@aihq/scan")) as unknown as Record<string, unknown>;
    const results = await runContractChecks({
      // A Core that folds every refusal into one code, as Core did before these checks existed.
      core: {
        ...core,
        consumeGovernanceInputV1: async () => ({ status: { reason: "malformed-bytes" } }),
      } as unknown as Record<string, unknown>,
      scan: { ...scan, AI_HARNESS_DECISION_V2_SCHEMA_SHA256: "f".repeat(64) },
      catalog: {
        readCatalogContentV1: () => undefined,
        readCatalogCollectionsV1: () => undefined,
        readCatalogPresentationV1: () => undefined,
      },
      readSubpath: (specifier) => {
        const schema = /^@aihq\/core\/schemas\/(.+)$/u.exec(specifier)?.[1];
        if (schema !== undefined) return readFileSync(resolve(root, "schemas", schema));
        return new TextEncoder().encode('{"format":"aih-catalog-index","version":1,"entries":[]}');
      },
    });
    const status = Object.fromEntries(results.map((result) => [result.id, result.status]));
    expect(status["scan-decision-schema-lock"]).toBe("failed");
    expect(status["catalog-readers"]).toBe("failed");
    expect(status["catalog-subject-digests"]).toBe("failed");
    expect(status["refusal-input-unknown-version"]).toBe("failed");
    expect(status["refusal-evidence-unknown-version"]).toBe("failed");
    expect(status["refusal-scan-core-contract-unknown"]).toBe("failed");
  });
});
