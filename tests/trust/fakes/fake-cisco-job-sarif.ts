/**
 * Each job's completion subject (subject-files-v1), computed BY HAND by the
 * calling test with plain node:crypto and written there as a literal, keyed by
 * job path. Every fixture job holds exactly one file, so its count is 1. The
 * fake never derives a digest: a bug in Core's hashing cannot cancel out here.
 */
export type HandJobSubjectsForTests = Readonly<Record<string, string>>;

/**
 * TEST FAKE. One Cisco shard job's SARIF as Scan returns it (C2a §1.6, §3.7):
 * the analyzer's driver, a successful invocation, and completion evidence v1
 * naming "detector.cisco", the job's hand-computed subject from `subjects`
 * and the analyzer the shard ran (`version` without its uv.lock suffix).
 */
export function fakeCiscoJobSarif(
  subjects: HandJobSubjectsForTests,
  jobPath: string,
  results: readonly unknown[],
  analyzer: { readonly version: string; readonly lockSha256: string },
): Record<string, unknown> {
  const subjectTreeSha256 = subjects[jobPath];
  if (subjectTreeSha256 === undefined)
    throw new Error(`the test states no hand-computed subject for job ${jobPath}`);
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
