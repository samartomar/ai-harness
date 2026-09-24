import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { TrustDetectorName } from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";
import { scanTrustTreeWithAnalyzers } from "../../src/trust/scan.js";
import { createFakeScanAdapterForTests, type FakeScanAnswerV1 } from "./fakes/fake-scan-adapter.js";
import {
  comparableCheck,
  comparableOccurrence,
  detectorSarifFromGolden,
  type GoldenCheck,
  type GoldenDetectorRun,
  loadGolden,
  loadParityCases,
  loadRecordedSnykGoldens,
  materializeParityCase,
  type ParityCase,
  SCAN_IDS,
  trustLintSarifFromGolden,
  withoutHostDependentFields,
  writeFiles,
} from "./fakes/trust-parity-golden.js";

// ---------------------------------------------------------------------------
// Parity oracle: the goldens Core's CURRENT engines produced at the base commit
// (tests/fixtures/trust-parity/golden, captured by tools/capture-trust-golden.mjs
// with real Semgrep, Cisco, Cisco MCP scanner and SkillSpector runs; Snyk from
// Core's recorded test output). Each detector is routed through the Scan
// execution seam to a TEST FAKE that returns the SARIF a Scan run returns under
// contract C2, and Core's SARIF -> check mapping must reproduce the golden: same
// codes, relative paths, lines, multiplicity and availability. Core itself runs
// no analyzer and computes no native finding on this path.
// ---------------------------------------------------------------------------

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function materialize(entry: ParityCase): string {
  const root = materializeParityCase(entry);
  roots.push(root);
  return root;
}

/** No process may run in Core on the delegated path; every attempt is recorded and fails. */
function forbiddenRunner() {
  const argvs: string[][] = [];
  const run = fakeRunner((argv) => {
    argvs.push([...argv]);
    return {
      code: 127,
      stdout: "",
      stderr: "no process may run in a delegated scan",
      spawnError: true,
    };
  });
  return { argvs, run };
}

/** Only the sandbox smoke check's Docker probe may be attempted; it fails, so nothing runs. */
function onlySmokeProbes(argvs: readonly string[][]): boolean {
  return argvs.every((argv) => argv.join(" ") === "docker --version");
}

function goldenComparable(check: GoldenCheck, fingerprintsHostDependent = false): GoldenCheck {
  const { family: _family, hostDependentDetail: _host, ...rest } = check;
  return fingerprintsHostDependent ? { ...rest, fingerprint: null } : rest;
}

/** The detector's own pass or unavailable check (advisories are findings). */
const isDetectorStatus = (check: { readonly name: string }) =>
  /^trust detector [a-z-]+$/.test(check.name);

const cases = loadParityCases();

function nativeGolden(entry: ParityCase): readonly GoldenCheck[] {
  const golden = loadGolden(entry.id);
  expect(golden.native.identicalAcrossEnvironments).toBe(true);
  const first = Object.values(golden.native.byEnvironment)[0];
  if (first === undefined) throw new Error(`no native golden for ${entry.id}`);
  return first.checks;
}

function nativeCount(checks: readonly GoldenCheck[]): number {
  return checks.filter((check) => check.family !== "sandbox-smoke" && check.family !== "summary")
    .length;
}

/** The detector's checks: what Core appended after the native checks and before the smoke check. */
function detectorSlice(checks: readonly Check[], native: number): Check[] {
  const nonSmoke = checks.slice(0, -1);
  return nonSmoke.length === 1 && nonSmoke[0]?.name === "trust scan" ? [] : nonSmoke.slice(native);
}

/** The environment whose run is the oracle: a real completed run first, else a real refusal. */
function oracle(runs: Readonly<Record<string, GoldenDetectorRun>>): [string, GoldenDetectorRun] {
  const entries = Object.entries(runs);
  const pick =
    entries.find(([env, run]) => env === "linux-x64" && run.outcome === "completed") ??
    entries.find(([, run]) => run.outcome === "completed") ??
    entries.find(([, run]) => run.outcome === "unavailable") ??
    entries[0];
  if (pick === undefined) throw new Error("golden detector has no environment");
  return pick;
}

function answerFor(run: GoldenDetectorRun, root: string): FakeScanAnswerV1 {
  return run.outcome === "completed"
    ? { kind: "sarif", sarif: detectorSarifFromGolden(run, root) }
    : {
        kind: "refused",
        reason: "prerequisite-missing",
        detail: `the golden run was unavailable: ${run.reason ?? "no reason recorded"}`,
      };
}

describe("golden parity: native findings through detector.aih-trust-lint", () => {
  it.each(cases.map((entry) => [entry.id, entry] as const))("%s", async (_id, entry) => {
    const golden = loadGolden(entry.id);
    const expected = nativeGolden(entry);
    const root = materialize(entry);
    const fake = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": { kind: "sarif", sarif: trustLintSarifFromGolden(expected) },
    });

    const result = await scanTrustTreeWithAnalyzers(root, {
      posture: "vibe",
      internalScopes: golden.internalScopes,
      scanExecution: fake,
    });

    // Every native check, the MCP policy checks Core keeps, the summary and the
    // smoke check: the same list, in the same order, with the same details.
    expect(result.checks.map((check) => comparableCheck(check, root))).toEqual(
      expected.map((check) => goldenComparable(check)),
    );
    // The request is Scan's RunDetectorV1Request for exactly what Core enumerated.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      detectorId: "detector.aih-trust-lint",
      executionProfileId: "in-process-native-v1",
      subject: {
        kind: "source-tree",
        sourceRoot: root,
        selectedClosurePaths: buildTrustFileInventory(root).files.map((file) => file.relativePath),
      },
      detectorOptions: { internalScopes: [...golden.internalScopes] },
    });
    expect(result.detectorExecutions).toEqual([
      {
        detector: "aih-trust-lint",
        executedBy: "scan",
        scanSource: "injected-adapter",
        executionProfileId: "in-process-native-v1",
        outcome: "completed",
      },
    ]);
    expect(result.analyzersRun).toEqual(["aih-native"]);
  });

  it("takes native findings only from Scan: an empty report leaves none", async () => {
    const entry = cases.find((candidate) => candidate.id === "auto-exec-permissions");
    if (entry === undefined) throw new Error("corpus lost auto-exec-permissions");
    const root = materialize(entry);
    const fake = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": {
        kind: "sarif",
        sarif: JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }),
      },
    });
    const result = await scanTrustTreeWithAnalyzers(root, { posture: "vibe", scanExecution: fake });
    expect(result.checks.map((check) => check.name)).toEqual([
      "trust scan",
      "skill sandbox smoke test",
    ]);
  });
});

const detectorRuns = cases.flatMap((entry) =>
  Object.entries(loadGolden(entry.id).detectors).map(
    ([detector, value]) => [`${entry.id} / ${detector}`, entry, detector, value] as const,
  ),
);

describe("golden parity: each detector through the Scan execution seam", () => {
  it.each(detectorRuns)("%s", async (_label, entry, detector, value) => {
    const golden = loadGolden(entry.id);
    const native = nativeGolden(entry);
    const [, run] = oracle(value.byEnvironment);
    const root = materialize(entry);
    const scanId = SCAN_IDS[detector as keyof typeof SCAN_IDS];
    const fake = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": { kind: "sarif", sarif: trustLintSarifFromGolden(native) },
      [scanId]: answerFor(run, root),
    });
    const { argvs, run: runner } = forbiddenRunner();

    const result = await scanTrustTreeWithAnalyzers(root, {
      posture: "vibe",
      internalScopes: golden.internalScopes,
      env: {},
      platform: "linux",
      run: runner,
      detectors: [detector as TrustDetectorName],
      scanExecution: fake,
    });

    const checks = detectorSlice(result.checks, nativeCount(native));
    const requested = fake.requests.map((request) => request.detectorId);
    expect(onlySmokeProbes(argvs)).toBe(true);
    if (run.outcome === "not-applicable") {
      // Core decides applicability (no incoming MCP config): Scan is not asked.
      expect(checks).toEqual([]);
      expect(requested).toEqual(["detector.aih-trust-lint"]);
      return;
    }
    expect(requested).toEqual(["detector.aih-trust-lint", scanId]);
    expect(fake.requests[1]).toMatchObject({
      executionProfileId:
        detector === "skillspector" ? "docker-hardened-skillspector-v1" : "host-process-uv-v1",
    });
    const status = checks.filter(isDetectorStatus);
    if (run.outcome === "unavailable") {
      expect(status).toEqual([
        expect.objectContaining({ verdict: "skip", code: "trust.detector-unavailable" }),
      ]);
      expect(checks.filter((check) => !isDetectorStatus(check))).toEqual([]);
      expect(result.analyzersRun).toEqual(["aih-native"]);
      return;
    }
    expect(status).toEqual([expect.objectContaining({ verdict: "pass" })]);
    expect(result.analyzersRun).toEqual(run.analyzersRun);
    const findings = checks.filter((check) => !isDetectorStatus(check));
    const expectedFindings = run.checks.filter((check) => !isDetectorStatus(check));
    const rows = (result.rawOccurrences ?? []).slice(
      (result.rawOccurrences ?? []).length - run.rawOccurrences.length,
    );
    expect(rows.map(comparableOccurrence)).toEqual(
      run.rawOccurrences.map((row) => ({
        analyzer: row.analyzer,
        ruleId: row.ruleId.replace("<semgrep-config-dir>", "aih.work"),
        level: row.level,
        message: row.message,
        uri: row.uri,
        startLine: row.startLine,
        sourceValue: row.sourceValue,
      })),
    );
    if (detector === "semgrep") {
      // Semgrep reports its rule ids under the config file's directory, which is
      // why Core's exact-id map never matched a real run (see the golden's rule
      // ids). Scan's Semgrep ids are matched by suffix, so the delegated result
      // must equal Core's mapping of the same SARIF with Core's exact rule ids,
      // and it lands on the golden's paths, lines and multiplicity.
      const reference = await scanTrustTreeWithAnalyzers(root, {
        posture: "vibe",
        internalScopes: golden.internalScopes,
        env: {},
        platform: "linux",
        run: runner,
        detectors: ["semgrep"],
        precomputedDetectorSarif: { semgrep: detectorSarifFromGolden(run, root, null) },
        scanExecution: createFakeScanAdapterForTests({
          "detector.aih-trust-lint": { kind: "sarif", sarif: trustLintSarifFromGolden(native) },
        }),
      });
      const referenceFindings = detectorSlice(reference.checks, nativeCount(native)).filter(
        (check) => !isDetectorStatus(check),
      );
      expect(findings.map((check) => comparableCheck(check, root))).toEqual(
        referenceFindings.map((check) => comparableCheck(check, root)),
      );
      const place = (check: { uri: string | null; startLine: number | null }) =>
        `${check.uri}:${check.startLine}`;
      expect(findings.map((check) => place(comparableCheck(check, root)))).toEqual(
        expectedFindings.map(place),
      );
      expect(semgrepCorrections(expectedFindings, findings, root)).toEqual(
        SEMGREP_CODE_CORRECTIONS[entry.id] ?? [],
      );
      return;
    }
    expect(findings.map((check) => comparableCheck(check, root))).toEqual(
      expectedFindings.map((check) => goldenComparable(check, run.fingerprintsHostDependent)),
    );
    expect(result.detectorExecutions).toContainEqual({
      detector,
      executedBy: "scan",
      scanSource: "injected-adapter",
      executionProfileId:
        detector === "skillspector" ? "docker-hardened-skillspector-v1" : "host-process-uv-v1",
      outcome: "completed",
    });
  });
});

/**
 * Where suffix matching changes a Semgrep code relative to the base commit's
 * goldens, pinned so the change is reviewed rather than silent: `[place, golden
 * name, delegated name]`. The base commit could not match any real Semgrep rule
 * id, so every real Semgrep finding was a warn-only generic finding. Matched by
 * suffix, `semgrep.prompt-injection` is corroborated by the native lint on the
 * same line and becomes a blocking `trust.prompt-injection`, including in a
 * LICENSE file and in skipped directories Semgrep still scans; an uncorroborated
 * `semgrep.malicious-code` stays a generic finding either way.
 */
const SEMGREP_CODE_CORRECTIONS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  "prompt-injection": [["SKILL.md:7", "trust.detector-finding", "trust.prompt-injection"]],
  "multi-skill-nested": [
    ["dist/bundle.js:1", "trust.detector-finding", "trust.prompt-injection"],
    ["node_modules/ignored-pkg/SKILL.md:4", "trust.detector-finding", "trust.prompt-injection"],
    ["skills/beta/SKILL.md:7", "trust.detector-finding", "trust.prompt-injection"],
  ],
  "mcp-configs": [[".mcp.json:16", "trust.detector-finding", "trust.prompt-injection"]],
  "semgrep-positive": [["notes.txt:1", "trust.detector-finding", "trust.prompt-injection"]],
  "legal-text": [["LICENSE:4", "trust.legal-text-detector-finding", "trust.prompt-injection"]],
};

function semgrepCorrections(
  golden: readonly GoldenCheck[],
  delegated: readonly Check[],
  root: string,
): string[][] {
  return delegated.flatMap((check, index) => {
    const now = comparableCheck(check, root);
    const before = golden[index];
    return before === undefined || before.name === now.name
      ? []
      : [[`${now.uri}:${now.startLine}`, before.name, now.name]];
  });
}

describe("golden parity: Snyk Agent Scan (recorded output, never executed here)", () => {
  it.each(loadRecordedSnykGoldens().map((entry) => [entry.id, entry] as const))(
    "%s",
    async (_id, recorded) => {
      const root = materializeParityCase({ id: recorded.id, tree: null });
      roots.push(root);
      writeFiles(root, recorded.files);
      const run: GoldenDetectorRun = {
        scanDetectorId: "detector.snyk-agent-scan",
        mode: "recorded",
        outcome: recorded.outcome,
        ...(recorded.reason === undefined ? {} : { reason: recorded.reason }),
        analyzersRun: [],
        checks: recorded.checks,
        rawOccurrences: recorded.rawOccurrences,
      };
      const fake = createFakeScanAdapterForTests({
        "detector.aih-trust-lint": {
          kind: "sarif",
          sarif: trustLintSarifFromGolden(
            (recorded as unknown as { nativeChecks: GoldenCheck[] }).nativeChecks,
          ),
        },
        "detector.snyk-agent-scan": answerFor(run, root),
      });
      const { argvs, run: runner } = forbiddenRunner();
      const result = await scanTrustTreeWithAnalyzers(root, {
        posture: "vibe",
        env: {},
        platform: "linux",
        run: runner,
        detectors: ["snyk-agent-scan"],
        scanExecution: fake,
      });
      const native = (recorded as unknown as { nativeChecks: GoldenCheck[] }).nativeChecks;
      const checks = detectorSlice(result.checks, nativeCount(native));
      expect(onlySmokeProbes(argvs)).toBe(true);
      if (recorded.outcome === "unavailable") {
        expect(checks).toEqual([
          expect.objectContaining({ verdict: "skip", code: "trust.detector-unavailable" }),
        ]);
        return;
      }
      expect(
        checks
          .filter((check) => !isDetectorStatus(check))
          .map((check) => comparableCheck(check, root)),
      ).toEqual(
        recorded.checks
          .filter((check) => !isDetectorStatus(check))
          .map((check) => withoutHostDependentFields(check)),
      );
    },
  );
});
