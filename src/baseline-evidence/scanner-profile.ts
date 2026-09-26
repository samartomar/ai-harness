/**
 * Exact analyzer identities a protected Scanner publication names for the
 * `aih-baseline-v1` profile: the U1 analyzer upgrade (aih-scan 391b04d). The
 * native identity is the one the protected publisher emitted before U1, and U1
 * did not move it: every publication of publisher 349fcadac4bd reports it.
 *
 * These values are a consumer-side allow-list, not facts copied from an
 * incoming receipt. A Scanner bundle with any other identity fails closed
 * before Core interprets its annexes or writes vendor evidence.
 */
export const SCANNER_BASELINE_ANALYZER_VERSIONS = Object.freeze({
  "aih-native": "native.014fbd614a5a",
  "skillspector@docker":
    "c7958a3268d9498644b22edb75d0f051bbc8cbfc@sha256:efe47bd7e073064426541381c8cb284162086950748424d1b4633788a2275bc6",
  "semgrep@uv:1.178.0": "1.178.0+uvlock.5fae6a8598f7",
  "cisco@uvx": "2.1.0+uvlock.1e98c5679994",
} as const);

export const SCANNER_TO_CORE_BASELINE_ANALYZER = Object.freeze({
  "aih-native": "aih-native",
  skillspector: "skillspector@docker",
  semgrep: "semgrep@uv:1.178.0",
  cisco: "cisco@uvx",
} as const);

export type ScannerBaselineAnalyzer = keyof typeof SCANNER_TO_CORE_BASELINE_ANALYZER;
