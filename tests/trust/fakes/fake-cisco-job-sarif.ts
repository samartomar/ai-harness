import { hashComponentTree } from "../../../src/baseline-evidence/hash.js";
import { SCAN_COMPLETION_PROPERTY_V1 } from "../../../src/trust/scan-sarif.js";
import { scanSubjectDigestV1 } from "../../../src/trust/scan-subject-files.js";

/**
 * TEST FAKE. One Cisco shard job's SARIF as Scan returns it (C2a §1.6, §3.7):
 * the analyzer's driver, a successful invocation, and completion evidence v1
 * naming "detector.cisco", every regular file under `<sourceRoot>/<jobPath>`
 * and the analyzer the shard ran (`version` without its uv.lock suffix).
 */
export function fakeCiscoJobSarif(
  sourceRoot: string,
  jobPath: string,
  results: readonly unknown[],
  analyzer: { readonly version: string; readonly lockSha256: string },
): Record<string, unknown> {
  const digest = scanSubjectDigestV1(hashComponentTree(sourceRoot, [jobPath]).files);
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "cisco-ai-skill-scanner" } },
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              [SCAN_COMPLETION_PROPERTY_V1]: {
                detectorId: "detector.cisco",
                ...digest,
                analyzer: {
                  version: analyzer.version.split("+", 1)[0] ?? analyzer.version,
                  lockSha256: analyzer.lockSha256,
                },
              },
            },
          },
        ],
        results: [...results],
      },
    ],
  };
}
