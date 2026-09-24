import { BINDING_GATE_DIMENSIONS } from "../../src/binding/scan-binding-gate.js";
import type { DimensionReport } from "../../src/binding/scan-gate.js";
import {
  createFakeScanAdapterForTests,
  type FakeScanAdapterForTests,
} from "../trust/fakes/fake-scan-adapter.js";

/**
 * TEST FAKE. The binding gate's FAST tier is Scan's `detector.aih-binding-gate`
 * (C2a decision 3); these helpers let a gate test state the inspection it wants
 * as Core `DimensionReport`s and receive it back through the real delegation
 * path: Scan-shaped SARIF (one result per finding, `aih-binding-gate/v1`
 * properties, every dimension's status), bound by the fake's annex digest.
 * Dimensions a test does not name are produced with no findings.
 */

function sarifLevel(severity: string): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "low") return "warning";
  return "note";
}

export function bindingGateSarifForTests(reports: readonly DimensionReport[]): string {
  const byDimension = new Map(reports.map((report) => [report.dimension, report]));
  for (const dimension of byDimension.keys()) {
    if (!BINDING_GATE_DIMENSIONS.includes(dimension))
      throw new Error(`fake binding gate has no dimension ${dimension}`);
  }
  const ordered = BINDING_GATE_DIMENSIONS.map(
    (dimension): DimensionReport =>
      byDimension.get(dimension) ?? { dimension, status: "produced", findings: [] },
  );
  const results = ordered.flatMap((report) =>
    report.findings.map((finding) => {
      const typography = finding.path === undefined ? undefined : report.typography?.[finding.path];
      const dottedIBlocking =
        finding.path === undefined ? undefined : report.dottedIBlocking?.[finding.path];
      return {
        ruleId: finding.code,
        level: sarifLevel(finding.severity),
        message: { text: finding.detail },
        properties: {
          "aih-binding-gate/v1": {
            dimension: report.dimension,
            severity: finding.severity,
            coverage: finding.coverage,
            ...(finding.path === undefined ? {} : { path: finding.path }),
            ...(finding.contentSha256 === undefined
              ? {}
              : { contentSha256: finding.contentSha256 }),
            ...(typography === undefined || finding.code !== "trust.hidden-unicode"
              ? {}
              : { typography: { ...typography, occurrences: 1 } }),
            ...(dottedIBlocking === undefined || finding.code !== "trust.visible-unicode"
              ? {}
              : { dottedIBlocking }),
          },
        },
        ...(finding.path === undefined
          ? {}
          : {
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: finding.path },
                    region: { startLine: 1 },
                  },
                },
              ],
            }),
      };
    }),
  );
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "aih-binding-gate", version: "1.0.0", rules: [] } },
        properties: {
          "aih-binding-gate/v1": {
            format: "aih-binding-gate-report",
            version: 1,
            dimensions: ordered.map((report) => ({
              name: report.dimension,
              status: report.status,
              ...(report.reason === undefined ? {} : { reason: report.reason }),
              findingCount: report.findings.length,
            })),
          },
        },
        results,
      },
    ],
  });
}

/** Core's selected paths from a recorded binding-gate request. */
export function selectedPathsOf(request: Record<string, unknown>): string[] {
  const subject = request.subject as { selectedClosurePaths?: unknown } | undefined;
  return Array.isArray(subject?.selectedClosurePaths)
    ? subject.selectedClosurePaths.map(String)
    : [];
}

/**
 * A fake Scan whose binding gate reports `reports` (or `reports(selectedPaths)`,
 * for findings that must pin a path Core actually sent).
 */
export function fakeBindingGateScan(
  reports:
    | readonly DimensionReport[]
    | ((selectedPaths: readonly string[]) => readonly DimensionReport[]) = [],
): FakeScanAdapterForTests {
  return createFakeScanAdapterForTests({
    "detector.aih-binding-gate": {
      kind: "sarif-for",
      sarif: (request) =>
        bindingGateSarifForTests(
          typeof reports === "function" ? reports(selectedPathsOf(request)) : reports,
        ),
    },
  });
}
