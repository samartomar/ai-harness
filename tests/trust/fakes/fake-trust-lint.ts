import {
  createFakeScanAdapterForTests,
  type FakeScanAdapterForTests,
  type FakeScanAnswerV1,
} from "./fake-scan-adapter.js";

/**
 * TEST FAKE. Scan's `detector.aih-trust-lint` produces every trust scan's native
 * findings plus the per-file facts Core's classification reads (C2a §2.6). These
 * helpers let a test state them and receive them back through the real
 * delegation path. Every path Core selected gets an artifact with neutral facts
 * unless the test overrides it, exactly as Scan seals every selected file.
 */

export interface FakeTrustLintResultV1 {
  readonly ruleId: string;
  readonly message: string;
  readonly uri: string;
  readonly line?: number;
  readonly fingerprint?: string;
  readonly level?: "error" | "warning" | "note";
  /** For a finding in an incoming MCP server description. */
  readonly mcpDescription?: {
    readonly configPath: string;
    readonly mapKey: "mcpServers" | "servers" | "mcp";
    readonly server: string;
  };
}

export interface FakeTrustLintArtifactV1 {
  readonly unreadable?: true;
  readonly strictUnicodeSurface?: boolean;
  readonly legalText?: boolean;
  readonly unicodeRisk?: {
    readonly category: string;
    readonly code: "trust.hidden-unicode" | "trust.visible-unicode";
    readonly reason: string;
  } | null;
  readonly lintLines?: readonly { readonly line: number; readonly codes: readonly string[] }[];
  readonly yr4CorepackIntegrityOnly?: true;
}

export interface FakeTrustLintOptionsV1 {
  readonly results?: readonly FakeTrustLintResultV1[];
  /** Facts per selected path; unnamed selected paths get neutral facts. */
  readonly artifacts?: Readonly<Record<string, FakeTrustLintArtifactV1>>;
  readonly trustDocumentCount?: number;
  readonly repositoryLicenseFile?: string | null;
}

function artifactProperties(facts: FakeTrustLintArtifactV1 | undefined) {
  if (facts?.unreadable === true) return { unreadable: true };
  return {
    strictUnicodeSurface: facts?.strictUnicodeSurface ?? false,
    legalText: facts?.legalText ?? false,
    unicodeRisk: facts?.unicodeRisk ?? null,
    lintLines: facts?.lintLines ?? [],
    ...(facts?.yr4CorepackIntegrityOnly === true ? { yr4CorepackIntegrityOnly: true } : {}),
  };
}

/** Scan-shaped trust-lint SARIF for `selectedPaths` (Core's request order). */
export function trustLintSarifForTests(
  selectedPaths: readonly string[],
  options: FakeTrustLintOptionsV1 = {},
): string {
  const artifacts = [...new Set([...selectedPaths, ...Object.keys(options.artifacts ?? {})])];
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "aih-trust-lint", version: "1.0.0", rules: [] } },
        properties: {
          "aih-trust/v1": {
            format: "aih-trust-lint-facts",
            version: 1,
            trustDocumentCount: options.trustDocumentCount ?? 0,
            repositoryLicenseFile: options.repositoryLicenseFile ?? null,
          },
        },
        artifacts: artifacts.map((uri) => ({
          location: { uri },
          properties: { "aih-trust/v1": artifactProperties(options.artifacts?.[uri]) },
        })),
        results: (options.results ?? []).map((result, index) => ({
          ruleId: result.ruleId,
          level: result.level ?? "error",
          message: { text: result.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: result.uri },
                region: { startLine: result.line ?? 1 },
              },
            },
          ],
          fingerprints: {
            "aih-trust/v1": result.fingerprint ?? `${result.ruleId}:${result.uri}:${index}`,
          },
          ...(result.mcpDescription === undefined
            ? {}
            : { properties: { "aih-trust/v1": { mcpDescription: result.mcpDescription } } }),
        })),
      },
    ],
  });
}

/** Core's selected paths from a recorded request. */
export function requestedPathsOf(request: Record<string, unknown>): string[] {
  const subject = request.subject as { selectedClosurePaths?: unknown } | undefined;
  return Array.isArray(subject?.selectedClosurePaths)
    ? subject.selectedClosurePaths.map(String)
    : [];
}

/**
 * A fake Scan whose trust lint reports `options` (or `options(selectedPaths,
 * request)`), plus any other detector answers the test needs.
 */
export function fakeTrustLintScan(
  options:
    | FakeTrustLintOptionsV1
    | ((
        selectedPaths: readonly string[],
        request: Record<string, unknown>,
      ) => FakeTrustLintOptionsV1) = {},
  others: Readonly<Record<string, FakeScanAnswerV1>> = {},
): FakeScanAdapterForTests {
  return createFakeScanAdapterForTests({
    "detector.aih-trust-lint": {
      kind: "sarif-for",
      sarif: (request) => {
        const paths = requestedPathsOf(request);
        return trustLintSarifForTests(
          paths,
          typeof options === "function" ? options(paths, request) : options,
        );
      },
    },
    ...others,
  });
}
