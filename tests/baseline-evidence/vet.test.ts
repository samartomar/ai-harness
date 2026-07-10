import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { vetBaselineCatalog } from "../../src/baseline-evidence/vet.js";
import type { Check } from "../../src/internals/verify.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-vet-"));
  mkdirSync(join(root, "skills", "clean"), { recursive: true });
  mkdirSync(join(root, "skills", "blocked"), { recursive: true });
  writeFileSync(join(root, "skills", "clean", "SKILL.md"), "# Clean\n");
  writeFileSync(join(root, "skills", "blocked", "SKILL.md"), "# Blocked\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "d".repeat(40),
    components: [
      { id: "skill:clean", paths: ["skills/clean"] },
      { id: "skill:blocked", paths: ["skills/blocked"] },
    ],
  });
}

function pass(name: string): Check {
  return { name, verdict: "pass", detail: `${name} passed` };
}

describe("vetBaselineCatalog", () => {
  it("binds each scanner verdict to the component's exact deterministic tree hash", async () => {
    const scanComponent = vi.fn(async ({ component }: { component: { id: string } }) => ({
      analyzersRun: ["aih-native"],
      checks: [pass(component.id)],
    }));

    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent,
      analyzerVersions: { "aih-native": "2.7.0" },
    });

    expect(scanComponent).toHaveBeenCalledTimes(2);
    expect(evidence).toMatchObject({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: "d".repeat(40),
      components: [
        { id: "skill:clean", verdict: "pass", findings: [] },
        { id: "skill:blocked", verdict: "pass", findings: [] },
      ],
    });
    expect(evidence.components[0]?.treeSha256).toBe(
      hashComponentTree(root, ["skills/clean"]).treeSha256,
    );
    expect(evidence.components[0]?.analyzers).toEqual([{ name: "aih-native", version: "2.7.0" }]);
  });

  it("preserves failing danger checks as a blocked verdict instead of acknowledging them", async () => {
    const danger: Check = {
      name: "trust.hidden-unicode",
      verdict: "fail",
      code: "trust.hidden-unicode",
      detail: "instruction surface contains non-ASCII typography",
      fingerprint: "trust-hidden-unicode:SKILL.md:1:abc123",
    };
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async ({ component }) => ({
        analyzersRun: ["aih-native"],
        checks: component.id === "skill:blocked" ? [danger] : [pass(component.id)],
      }),
      analyzerVersions: { "aih-native": "2.7.0" },
    });

    expect(evidence.components[1]).toMatchObject({
      id: "skill:blocked",
      verdict: "blocked",
      findings: [
        {
          code: "trust.hidden-unicode",
          detail: danger.detail,
          fingerprint: danger.fingerprint,
        },
      ],
    });
  });

  it("treats a required unavailable detector failure as blocked evidence", async () => {
    const unavailable: Check = {
      name: "trust detector skillspector",
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: "required detector skillspector unavailable",
    };
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async () => ({ analyzersRun: ["aih-native"], checks: [unavailable] }),
      analyzerVersions: { "aih-native": "2.7.0" },
    });
    expect(evidence.components.every((component) => component.verdict === "blocked")).toBe(true);
  });

  it("summarizes repeated findings by code for a bounded shipped lock", async () => {
    const repeated: Check[] = [
      {
        name: "unicode one",
        verdict: "fail",
        code: "trust.hidden-unicode",
        detail: "first hidden Unicode finding",
      },
      {
        name: "unicode two",
        verdict: "fail",
        code: "trust.hidden-unicode",
        detail: "second hidden Unicode finding",
      },
    ];
    const evidence = await vetBaselineCatalog(root, catalog(), {
      scanComponent: async () => ({ analyzersRun: ["aih-native"], checks: repeated }),
      analyzerVersions: { "aih-native": "2.7.0" },
    });
    expect(evidence.components[0]?.findings).toEqual([
      {
        code: "trust.hidden-unicode",
        count: 2,
        detail: "2 findings; first: first hidden Unicode finding",
      },
    ]);
  });

  it("fails closed when an analyzer ran without an attributable version receipt", async () => {
    await expect(
      vetBaselineCatalog(root, catalog(), {
        scanComponent: async () => ({
          analyzersRun: ["aih-native", "skillspector@docker"],
          checks: [pass("scan")],
        }),
        analyzerVersions: { "aih-native": "2.7.0" },
      }),
    ).rejects.toThrow(/skillspector.*version/i);
  });
});
