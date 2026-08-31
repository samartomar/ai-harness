/**
 * Exact analyzer identities emitted by the public @aihq/scan 0.2.1
 * `aih-baseline-v1` execution profile.
 *
 * These values are a consumer-side allow-list, not facts copied from an
 * incoming receipt. A Scanner bundle with any other identity fails closed
 * before Core interprets its annexes or writes vendor evidence.
 */
export const SCANNER_BASELINE_ANALYZER_VERSIONS = Object.freeze({
  "aih-native": "native.014fbd614a5a",
  "skillspector@docker":
    "2d198ab910add401cad658d1087e7c7ba24fd640@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800",
  "semgrep@uv:1.173.0": "1.173.0+uvlock.77f2bf3e7525",
  "cisco@uvx": "2.0.13+uvlock.3ba245280507",
} as const);

export const SCANNER_TO_CORE_BASELINE_ANALYZER = Object.freeze({
  "aih-native": "aih-native",
  skillspector: "skillspector@docker",
  semgrep: "semgrep@uv:1.173.0",
  cisco: "cisco@uvx",
} as const);

export type ScannerBaselineAnalyzer = keyof typeof SCANNER_TO_CORE_BASELINE_ANALYZER;
