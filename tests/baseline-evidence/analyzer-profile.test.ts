import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  CISCO_SKILL_SCANNER_LOCK,
  CISCO_SKILL_SCANNER_VERSION,
  preflightRequiredBaselineAnalyzers,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { fakeRunner, missingToolRunner } from "../../src/internals/proc.js";
import { checkDetectorsAvailable } from "../../src/trust/detectors.js";

function component(id: string, paths: string[]) {
  const [first] = defineBaselineCatalog({
    id: "fixture",
    owner: "owner",
    repo: "repo",
    pinnedSha: "a".repeat(40),
    components: [{ id, paths }],
  }).components;
  if (first === undefined) throw new Error("fixture catalog did not contain a component");
  return first;
}

describe("required baseline analyzer applicability", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ["runtime:ecc-installer", ["package.json", "scripts/lib"], false],
    ["agent:reviewer", ["agents/reviewer.md"], false],
    ["module:docs", ["docs/en"], false],
    ["skill:tdd", ["skills/tdd-workflow"], true],
    ["module:quality", ["scripts/check.js", "skills/verification-loop"], true],
  ])("selects Cisco only for declared skill content in %s", (id, paths, includesCisco) => {
    const required = requiredBaselineAnalyzersForComponent(component(id, paths));
    expect(required).toEqual(
      includesCisco
        ? ["aih-native", "skillspector@docker", "cisco@uvx"]
        : ["aih-native", "skillspector@docker"],
    );
    expect(requiredBaselineDetectorsForComponent(component(id, paths))).toEqual(
      includesCisco ? ["skillspector", "cisco"] : ["skillspector"],
    );
  });

  it("requires Cisco when a declared harness root contains SKILL.md content", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-analyzer-profile-"));
    roots.push(root);
    mkdirSync(join(root, ".kiro", "skills", "reviewer"), { recursive: true });
    writeFileSync(join(root, ".kiro", "skills", "reviewer", "SKILL.md"), "# Reviewer\n");
    const nested = component("runtime:ecc-kiro", [".kiro"]);

    expect(requiredBaselineAnalyzersForComponent(nested, root)).toEqual([
      "aih-native",
      "skillspector@docker",
      "cisco@uvx",
    ]);
    expect(requiredBaselineDetectorsForComponent(nested, root)).toEqual(["skillspector", "cisco"]);
  });

  it("binds the Cisco analyzer receipt identity to the committed uv lock", () => {
    const digest = createHash("sha256")
      .update(readFileSync(CISCO_SKILL_SCANNER_LOCK))
      .digest("hex")
      .slice(0, 12);
    expect(baselineAnalyzerVersions()["cisco@uvx"]).toBe(
      `${CISCO_SKILL_SCANNER_VERSION}+uvlock.${digest}`,
    );
  });
});

describe("checkDetectorsAvailable", () => {
  it("reports Cisco unavailable with the underlying offline uv reason", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("--version")
        ? { code: 1, stderr: "cisco-ai-skill-scanner was not found in the cache" }
        : undefined,
    );
    const probes = await checkDetectorsAvailable(["cisco"], { run, platform: "linux", env: {} });
    expect(probes).toEqual([
      {
        name: "cisco",
        analyzerLabel: "cisco@uvx",
        reason: expect.stringContaining("not found in the cache"),
      },
    ]);
  });

  it("returns no probe when Cisco resolves offline", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("--version") ? { code: 0, stdout: "skill-scanner 2.0.12" } : undefined,
    );
    expect(await checkDetectorsAvailable(["cisco"], { run, platform: "linux", env: {} })).toEqual(
      [],
    );
  });
});

describe("preflightRequiredBaselineAnalyzers", () => {
  it("fails closed with an actionable provisioning hint when a required analyzer is unprovisioned", async () => {
    await expect(
      preflightRequiredBaselineAnalyzers({ run: missingToolRunner, platform: "linux", env: {} }),
    ).rejects.toThrow(
      /preflight: required analyzer\(s\) not provisioned.*cisco@uvx unavailable.*uv run --project tools\/cisco-skill-scanner --locked/is,
    );
  });
});
