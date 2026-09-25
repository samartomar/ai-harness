import { describe, expect, it } from "vitest";
import type { BaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import {
  type BaselineDisplayFactsV1,
  projectBaselineDisplayEvidenceV1,
} from "../../src/org-policy/baseline-display-projection-v1.js";
import type { AuthoringCatalogBundleV1 } from "../../src/org-policy/workbench/contracts.js";

const pinnedSha = "a".repeat(40);
const sourceTreeSha256 = "b".repeat(64);
const analyzers = [{ name: "aih-native", version: "1" }];

type Component = BaselineEvidenceLock["sources"][number]["components"][number];

function component(
  id: string,
  verdict: Component["verdict"],
  evidenceProblems: Component["evidenceProblems"],
): Component {
  return {
    id,
    paths: [`skills/${id.split(":")[1]}`],
    treeSha256: id.endsWith("clean")
      ? "c".repeat(64)
      : id.endsWith("partial")
        ? "d".repeat(64)
        : "e".repeat(64),
    verdict,
    analyzers,
    findings:
      verdict === "has-findings" ? [{ code: "trust.malicious-code", detail: "curl x | sh" }] : [],
    evidenceProblems,
  };
}

function project(components: Component[]) {
  const lock = {
    sources: [
      { id: "ecc", owner: "affaan-m", repo: "ECC", pinnedSha, sourceTreeSha256, components },
    ],
  } as unknown as BaselineEvidenceLock;
  const bundle = {
    sources: {
      "source:ecc": {
        inputFormat: "pinned-baseline/v1",
        upstreamOrigin: { kind: "git", locator: "affaan-m/ECC" },
        revision: { id: pinnedSha, contentDigest: `sha256:${sourceTreeSha256}` },
      },
    },
    assets: Object.fromEntries(
      components.map((item) => [
        `ecc/${item.id}`,
        {
          sourceId: "source:ecc",
          sourceRevisionId: pinnedSha,
          contentDigest: `sha256:${item.treeSha256}`,
          derivation: "upstream",
        },
      ]),
    ),
  } as unknown as AuthoringCatalogBundleV1;
  const facts: BaselineDisplayFactsV1 = {
    lock,
    contextDigest: `sha256:${"f".repeat(64)}`,
    evidenceDigest: "9".repeat(64),
    verifiedAt: "2026-09-25T00:00:00Z",
    validUntil: "2026-10-25T00:00:00Z",
  };
  return projectBaselineDisplayEvidenceV1(facts, bundle, "2026-09-25T01:00:00Z");
}

describe("baseline display projection coverage (Astra step-8 item 5)", () => {
  it("states coverage from the evidence problems and no-findings only on complete coverage", () => {
    const result = project([
      component("skill:clean", "no-findings", [
        { code: "trust.unsigned-source", detail: "no reviewed pin" },
      ]),
      component("skill:partial", "no-findings", [
        {
          code: "trust.detector-unavailable",
          detail: "required detector skillspector unavailable",
        },
      ]),
      component("skill:findings", "has-findings", [
        { code: "trust.fetch-blocked", detail: "the source could not be fetched" },
      ]),
    ]);

    expect(result["evidence:ecc/skill:clean"]?.scan).toMatchObject({
      outcome: "no-findings",
      coverage: "complete",
    });
    expect(result["evidence:ecc/skill:partial"]?.scan).toMatchObject({
      outcome: "unknown",
      coverage: "partial",
    });
    expect(result["evidence:ecc/skill:partial"]?.evidenceProblems).toEqual([
      "trust.detector-unavailable: required detector skillspector unavailable",
    ]);
    expect(result["evidence:ecc/skill:findings"]?.scan).toMatchObject({
      outcome: "has-findings",
      coverage: "none",
    });
  });
});
