import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  type PrecomputedDetectorSarifV1,
  runTrustDetectors,
  type TrustDetectorName,
} from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";
import {
  BASELINE,
  SEMGREP_NAMESPACE,
  SKILLSPECTOR_HARDENED,
  VECTOR_FILES,
  vectorAnnex,
  vectorEvidence,
  WITH_GIT,
} from "./fakes/baseline-annex-vector.js";

// ---------------------------------------------------------------------------
// Scan's baseline rule (C2a §1.6 [Scan: S2j], decision D24: F leaves out the
// top-level `.git`) belongs only to annexes the verified Scanner consumer
// issued (tests/baseline-evidence/scanner-consumer.test.ts checks those). A
// live scan cannot claim it: a plain string, a caller-built wrapper, or the
// removed origin option all get the inline rule, so evidence for the baseline
// subject fails where inline Semgrep and SkillSpector cover the whole tree.
// Checked against the S2j hand vector's literals.
// ---------------------------------------------------------------------------

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-annex-vector-"));
  for (const [path, body] of Object.entries(VECTOR_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function scan(
  detector: TrustDetectorName,
  precomputed: PrecomputedDetectorSarifV1,
  extra: Record<string, unknown> = {},
) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: [detector],
    requiredDetectors: [detector],
    precomputedSarif: { [detector]: precomputed },
    ...extra,
  });
}

function detail(checks: readonly Check[], detector: string): string {
  return checks.find((check) => check.name === `trust detector ${detector}`)?.detail ?? "";
}

const WHOLE_TREE = [
  ["semgrep", "detector.semgrep", SEMGREP_NAMESPACE],
  ["skillspector", "detector.skillspector", SKILLSPECTOR_HARDENED],
] as const;

describe("a live scan cannot claim the Scanner-publication baseline rule", () => {
  it.each([
    ...WHOLE_TREE.map(
      ([name, id, analyzer]) => ["a plain string", name, id, analyzer, {}] as const,
    ),
    ...WHOLE_TREE.map(
      ([name, id, analyzer]) =>
        [
          "the removed precomputedSarifOrigin option",
          name,
          id,
          analyzer,
          { precomputedSarifOrigin: "scanner-baseline-vet" },
        ] as const,
    ),
  ])("gives %s for %s the inline rule", async (_how, name, id, analyzer, extra) => {
    const sarif = JSON.stringify(vectorAnnex(vectorEvidence(id, BASELINE, analyzer)));
    const result = await scan(name, sarif, extra);
    expect(result.executions).toEqual([
      { detector: name, executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detail(result.checks, name)).toContain(
      `precomputed SARIF for ${id} is refused: completion evidence for 2 files with subject tree ${BASELINE.subjectTreeSha256}; the subject Core submitted has 3 files with subject tree ${WITH_GIT.subjectTreeSha256}`,
    );
  });

  it.each(WHOLE_TREE)(
    "gives a caller-built baseline-vet annex wrapper for %s the inline rule",
    async (name, id, analyzer) => {
      const lookAlike = Object.freeze({
        kind: "scanner-baseline-vet-annex-v1",
        sarif: JSON.stringify(vectorAnnex(vectorEvidence(id, BASELINE, analyzer))),
      }) as unknown as PrecomputedDetectorSarifV1;
      const result = await scan(name, lookAlike);
      expect(result.executions).toEqual([
        { detector: name, executedBy: "precomputed-sarif", outcome: "failed" },
      ]);
      expect(detail(result.checks, name)).toContain(
        `precomputed SARIF for ${id} is refused: completion evidence for 2 files with subject tree ${BASELINE.subjectTreeSha256}; the subject Core submitted has 3 files with subject tree ${WITH_GIT.subjectTreeSha256}`,
      );
    },
  );

  it.each(WHOLE_TREE)(
    "completes inline %s evidence for the whole tree, top-level .git included",
    async (name, id, analyzer) => {
      const sarif = JSON.stringify(vectorAnnex(vectorEvidence(id, WITH_GIT, analyzer)));
      const result = await scan(name, sarif);
      expect(result.executions).toEqual([
        { detector: name, executedBy: "precomputed-sarif", outcome: "completed" },
      ]);
    },
  );
});
