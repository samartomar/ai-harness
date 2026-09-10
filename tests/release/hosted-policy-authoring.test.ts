import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const { prepareDecisionFields, assertAuthoredDecisionBounds } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/policy-authoring.mjs")).href
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fields() {
  const root = mkdtempSync(join(tmpdir(), "aih-hosted-authoring-"));
  roots.push(root);
  return prepareDecisionFields({
    adminRoot: root,
    targetRoot: join(root, "disposable-target"),
    operator: { actor: "owner@example.invalid", attestor: "test-owner" },
    issuedAt: "2026-09-10T00:00:00Z",
    expiresAt: "2026-09-11T00:00:00Z",
    qualification: {
      gaps: [
        {
          value: { id: "gap-static", summary: "Static coverage gap" },
          sha256: "sha256:" + "a".repeat(64),
        },
      ],
    },
    records: Array.from({ length: 5 }, (_, sequence) => ({
      sequence,
      sourceSha: "b".repeat(40),
      sha256: "sha256:" + "c".repeat(64),
      receipt: {
        subject: {
          kind: sequence === 4 ? "package" : "profile",
          id: `fixture-${sequence}`,
          source: { type: "aih", release: "0.6.1", revision: "d".repeat(40) },
        },
        qualificationBasis: {},
      },
    })),
  }).fields;
}

it("authors approved continuity decisions without addressing disabled conditional controls", () => {
  for (const decision of fields().slice(0, 4)) {
    expect(decision["protected-disposition"]).toBe("approved");
    for (const control of [
      "protected-accepted-findings",
      "protected-accepted-gaps",
      "protected-conditions",
      "protected-review-by",
    ])
      expect(Object.hasOwn(decision, control)).toBe(false);
  }
});

it("keeps explicit accepted gaps and review conditions on the supported npm decision", () => {
  const decision = fields()[4];
  expect(decision["protected-disposition"]).toBe("accepted-with-conditions");
  expect(decision["protected-accepted-findings"]).toBe("");
  expect(decision["protected-accepted-gaps"]).toBe("gap-static");
  expect(decision["protected-conditions"]).toContain("Keep npm install scripts disabled");
  expect(decision["protected-review-by"]).toBe("2026-09-11T00:00:00Z");
});

it("uses unique decision IDs accepted by the protected Workbench grammar", () => {
  const ids = fields().map((decision: Record<string, string>) => decision["protected-decision-id"]);
  expect(new Set(ids).size).toBe(5);
  for (const id of ids) expect(id).toMatch(/^decision-[a-z0-9-]{1,55}$/u);
});

it("accepts native canonical time/list output while rejecting changed authority constraints", () => {
  const expected = {
    issuedAt: "2026-09-10T00:00:00Z",
    expiresAt: "2026-09-11T00:00:00Z",
    acceptedGaps: ["gap-z", "gap-a"],
    conditions: ["Keep scripts disabled.", "Accept static gaps."],
    conditional: true,
  };
  const actual = {
    issuedAt: "2026-09-10T00:00:00.000Z",
    notBefore: "2026-09-10T00:00:00.000Z",
    expiresAt: "2026-09-11T00:00:00.000Z",
    reviewBy: "2026-09-11T00:00:00.000Z",
    acceptedGaps: ["gap-a", "gap-z"],
    conditions: ["Accept static gaps.", "Keep scripts disabled."],
  };
  expect(() => assertAuthoredDecisionBounds(actual, expected)).not.toThrow();
  for (const change of [
    { issuedAt: "2026-09-10T00:00:01.000Z" },
    { notBefore: "2026-09-10T00:00:01.000Z" },
    { expiresAt: "2026-09-12T00:00:00.000Z" },
    { reviewBy: "2026-09-12T00:00:00.000Z" },
    { acceptedGaps: ["gap-a"] },
    { acceptedGaps: ["gap-a", "gap-a", "gap-z"] },
    { conditions: ["Accept static gaps."] },
    { conditions: ["Accept static gaps.", "Accept static gaps.", "Keep scripts disabled."] },
  ])
    expect(() => assertAuthoredDecisionBounds({ ...actual, ...change }, expected)).toThrow();
});
