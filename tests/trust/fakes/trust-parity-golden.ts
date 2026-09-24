import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Check } from "../../../src/internals/verify.js";
import type { RawScannerOccurrence } from "../../../src/trust/evidence.js";
import { TRUST_LINT_FINGERPRINT_KEY } from "../../../src/trust/trust-lint-sarif.js";

/**
 * The parity corpus and the goldens Core's own engines produced at the base
 * commit (tools/capture-trust-golden.mjs). These helpers only READ goldens; they
 * derive the SARIF a Scan run would return from them for the test fake.
 */
export const PARITY_FIXTURES = resolve(import.meta.dirname, "..", "..", "fixtures", "trust-parity");

export interface ParityCase {
  readonly id: string;
  readonly tree: string | null;
  readonly internalScopes?: readonly string[];
  readonly materialize?: readonly {
    readonly path: string;
    readonly utf8?: string;
    readonly base64?: string;
  }[];
}

export interface GoldenCheck {
  readonly family?: string;
  readonly name: string;
  readonly verdict: string;
  readonly code: string | null;
  readonly uri: string | null;
  readonly startLine: number | null;
  readonly detail: string | null;
  readonly fingerprint: string | null;
  readonly hostDependentDetail?: boolean;
}

export interface GoldenOccurrence {
  readonly analyzer: string;
  readonly ruleId: string;
  readonly level: string | null;
  readonly message: string;
  readonly uri: string | null;
  readonly startLine: number | null;
  readonly sourceValue: string | null;
  readonly fingerprint: string;
  readonly hostDependentMessage?: boolean;
  readonly hostDependentRuleId?: boolean;
}

export interface GoldenDetectorRun {
  readonly scanDetectorId: string;
  readonly mode: "executed" | "recorded";
  readonly outcome: "completed" | "unavailable" | "not-applicable";
  readonly reason?: string;
  readonly fingerprintsHostDependent?: boolean;
  readonly analyzersRun: readonly string[];
  readonly checks: readonly GoldenCheck[];
  readonly rawOccurrences: readonly GoldenOccurrence[];
}

export interface GoldenCase {
  readonly case: string;
  readonly coreCommit: string;
  readonly posture: "vibe";
  readonly internalScopes: readonly string[];
  readonly native: {
    readonly byEnvironment: Readonly<Record<string, { readonly checks: readonly GoldenCheck[] }>>;
    readonly identicalAcrossEnvironments: boolean;
  };
  readonly detectors: Readonly<
    Record<
      string,
      {
        readonly scanDetectorId: string;
        readonly byEnvironment: Readonly<Record<string, GoldenDetectorRun>>;
        readonly executedOn: readonly string[];
      }
    >
  >;
}

export interface RecordedSnykCase {
  readonly id: string;
  readonly outcome: "completed" | "unavailable";
  readonly reason?: string;
  readonly files: Readonly<Record<string, string>>;
  readonly checks: readonly GoldenCheck[];
  readonly rawOccurrences: readonly GoldenOccurrence[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadParityCases(): ParityCase[] {
  return readJson<{ cases: ParityCase[] }>(join(PARITY_FIXTURES, "cases.json")).cases;
}

export function loadGolden(id: string): GoldenCase {
  return readJson<GoldenCase>(join(PARITY_FIXTURES, "golden", `${id}.json`));
}

export function loadRecordedSnykGoldens(): RecordedSnykCase[] {
  return readJson<{ cases: RecordedSnykCase[] }>(
    join(PARITY_FIXTURES, "golden", "recorded-snyk-agent-scan.json"),
  ).cases;
}

/**
 * A REAL `detector.aih-trust-lint` run recorded from Scan's own engine on one
 * corpus case: the request Scan received and the SARIF it returned.
 */
export interface RecordedScanTrustLint {
  readonly request: {
    readonly selectedClosurePaths: readonly string[];
    readonly detectorOptions: {
      readonly internalScopes: readonly string[];
      readonly mcpConfigPaths: readonly string[];
    };
  };
  readonly sarif: unknown;
}

export function loadRecordedScanTrustLint(id: string): RecordedScanTrustLint {
  return readJson<RecordedScanTrustLint>(join(PARITY_FIXTURES, "scan-trust-lint", `${id}.json`));
}

/** The recorded Scan trust-lint SARIF for a corpus case, as the text a fake Scan returns. */
export function recordedScanTrustLintSarif(id: string): string {
  return JSON.stringify(loadRecordedScanTrustLint(id).sarif);
}

function copyTreeContents(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyTreeContents(source, target);
    } else if (entry.isFile()) {
      writeFileSync(target, readFileSync(source));
    }
  }
}

/** The case's files in a fresh temporary root, exactly as the capture laid them out. */
export function materializeParityCase(entry: ParityCase): string {
  const root = mkdtempSync(join(tmpdir(), "aih-trust-parity-"));
  if (entry.tree !== null) copyTreeContents(join(PARITY_FIXTURES, ...entry.tree.split("/")), root);
  for (const item of entry.materialize ?? []) {
    const target = join(root, ...item.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (item.utf8 !== undefined) writeFileSync(target, item.utf8, "utf8");
    else if (item.base64 !== undefined) writeFileSync(target, Buffer.from(item.base64, "base64"));
  }
  return root;
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    const target = join(root, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
}

function rootForms(root: string): string[] {
  const forms = new Set<string>();
  for (const candidate of [root, realpathSync(root)]) {
    forms.add(candidate);
    forms.add(candidate.replace(/\\/g, "/"));
  }
  return [...forms].sort((left, right) => right.length - left.length);
}

/** A check in the golden's comparable shape, with this run's root written as `<root>`. */
export function comparableCheck(check: Check, root: string): GoldenCheck {
  let detail = check.detail ?? null;
  if (detail !== null)
    for (const form of rootForms(root)) detail = detail.split(form).join("<root>");
  return {
    name: check.name,
    verdict: check.verdict,
    code: check.code ?? null,
    uri: check.location?.uri ?? null,
    startLine: check.location?.startLine ?? null,
    detail,
    fingerprint: check.fingerprint ?? null,
  };
}

export function comparableOccurrence(
  occurrence: RawScannerOccurrence,
): Omit<GoldenOccurrence, "fingerprint" | "hostDependentMessage" | "hostDependentRuleId"> {
  return {
    analyzer: occurrence.analyzer,
    ruleId: occurrence.ruleId,
    level: occurrence.level ?? null,
    message: occurrence.message,
    uri: occurrence.location?.uri ?? null,
    startLine: occurrence.location?.startLine ?? null,
    sourceValue: occurrence.sourceValue ?? null,
  };
}

/** A golden check without the fields the golden marks as host-dependent. */
export function withoutHostDependentFields(
  check: GoldenCheck,
  fingerprintsHostDependent = false,
): GoldenCheck {
  const { family: _family, hostDependentDetail, ...rest } = check;
  return {
    ...rest,
    ...(hostDependentDetail === true ? { detail: null } : {}),
    ...(hostDependentDetail === true || fingerprintsHostDependent ? { fingerprint: null } : {}),
  };
}

const CODE_FOR_NAME: Readonly<Record<string, string>> = {
  "plaintext-secret": "secrets.plaintext-detected",
  "mcp-hardcoded-secret": "mcp.hardcoded-secret",
  "mcp-config-invalid": "mcp.config-invalid",
};

/**
 * The SARIF `detector.aih-trust-lint` returns for the golden's native findings:
 * one result per finding, in Core's order, carrying the ungraded detail, the
 * check code as rule id and Core's fingerprint. Grading is inverted here only
 * because the golden records graded checks; Scan itself never grades.
 *
 * The facts are the least the findings themselves imply: a file with a native
 * prompt-injection or external-egress finding on a line has that code in its
 * `lintLines` (the whole-file lint reported it there); every other fact is
 * neutral, and every other selected path gets neutral facts, as Scan states facts
 * for every file Core selected. For a corpus case, prefer Scan's recorded output
 * (`recordedScanTrustLintSarif`).
 */
export function trustLintSarifFromGolden(
  checks: readonly GoldenCheck[],
  selectedPaths: readonly string[] = [],
): string {
  const results = checks
    .filter((check) => check.family === "trust-lint")
    .map((check) => {
      const detail = check.detail ?? "";
      const ungraded =
        check.verdict === "pass"
          ? detail.replace(/^warning-only \([a-z-]+ posture\): /, "")
          : detail;
      return {
        ruleId: check.code ?? CODE_FOR_NAME[check.name] ?? check.name,
        level: "error",
        message: { text: ungraded },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: check.uri },
              region: { startLine: check.startLine },
            },
          },
        ],
        fingerprints: { [TRUST_LINT_FINGERPRINT_KEY]: check.fingerprint },
      };
    });
  const lintLines = new Map<string, Map<number, string[]>>();
  for (const check of checks) {
    if (
      check.family !== "trust-lint" ||
      check.uri === null ||
      (check.code !== "trust.prompt-injection" && check.code !== "trust.external-egress")
    )
      continue;
    const lines = lintLines.get(check.uri) ?? new Map<number, string[]>();
    const codes = lines.get(check.startLine ?? 1) ?? [];
    if (!codes.includes(check.code)) codes.push(check.code);
    lines.set(check.startLine ?? 1, codes);
    lintLines.set(check.uri, lines);
  }
  const artifacts = [...new Set([...lintLines.keys(), ...selectedPaths])].map((uri) => ({
    location: { uri },
    properties: {
      [TRUST_LINT_FINGERPRINT_KEY]: {
        strictUnicodeSurface: false,
        legalText: false,
        unicodeRisk: null,
        lintLines: [...(lintLines.get(uri) ?? [])].map(([line, codes]) => ({ line, codes })),
      },
    },
  }));
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "aih-trust-lint (test fake)" } },
        properties: {
          [TRUST_LINT_FINGERPRINT_KEY]: {
            format: "aih-trust-lint-facts",
            version: 1,
            trustDocumentCount: 0,
            repositoryLicenseFile: null,
          },
        },
        artifacts,
        results,
      },
    ],
  });
}

/**
 * The SARIF a Scan run of this detector returns, from the raw occurrences Core
 * recorded: rule id, level, message and the source-relative location, one result
 * per analyzer emission. A Semgrep rule id's config-directory prefix becomes
 * `semgrepConfigDir` (the form Scan's own runs produce), or is dropped for null.
 */
export function detectorSarifFromGolden(
  run: GoldenDetectorRun,
  root: string,
  semgrepConfigDir: string | null = "aih.work",
): string {
  const results = run.rawOccurrences.map((occurrence) => ({
    ruleId:
      semgrepConfigDir === null
        ? occurrence.ruleId.replace("<semgrep-config-dir>.", "")
        : occurrence.ruleId.replace("<semgrep-config-dir>", semgrepConfigDir),
    ...(occurrence.level === null ? {} : { level: occurrence.level }),
    message: { text: occurrence.message.split("<root>").join(root) },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: occurrence.uri },
          region: { startLine: occurrence.startLine },
        },
      },
    ],
  }));
  return JSON.stringify({
    version: "2.1.0",
    // A completed analyzer run carries its successful invocation (C2a §1.4).
    runs: [
      {
        tool: { driver: { name: `${run.scanDetectorId} (test fake)` } },
        invocations: [{ executionSuccessful: true }],
        results,
      },
    ],
  });
}

/** Scan's detector id for each Core detector name, as C2 names them. */
export const SCAN_IDS = {
  skillspector: "detector.skillspector",
  cisco: "detector.cisco",
  semgrep: "detector.semgrep",
  "snyk-agent-scan": "detector.snyk-agent-scan",
  "mcp-scanner": "detector.cisco-mcp-scanner",
} as const;
