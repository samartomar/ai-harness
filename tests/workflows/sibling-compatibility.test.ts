import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import * as core from "../../src/index.js";
import {
  buildCompatibilityArtifact,
  type ContractCheckResult,
  runContractChecks,
  validateLegReport,
} from "../../tools/sibling-compatibility-checks.mjs";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      needs?: readonly string[];
      if?: string;
      "continue-on-error"?: string;
      permissions?: Record<string, string>;
      steps: Step[];
    }
  >;
}

const root = resolve(import.meta.dirname, "../..");
const raw = readFileSync(resolve(root, ".github/workflows/sibling-compatibility.yml"), "utf8");

describe("sibling-compatibility workflow file", () => {
  const document = parseDocument(raw);
  const workflow = document.toJSON() as Workflow;

  it("is scheduled and dispatchable, read-only, and pins every action to a full commit", () => {
    expect(document.errors).toEqual([]);
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      for (const step of job.steps) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/u);
        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
    for (const line of raw.split("\n").filter((text) => text.includes("uses:")))
      expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u);
  });

  it("never runs aih, and reaches the siblings only through tarballs it packs", () => {
    const scripts = Object.values(workflow.jobs)
      .flatMap((job) => job.steps.map((step) => step.run ?? ""))
      .join("\n");
    expect(scripts).not.toMatch(/(?:^|[\s;&|(])(?:npx\s+)?aih(?:-scan|-supported)?\s/mu);
    expect(scripts).not.toMatch(/dist\/cli\.js|src\/cli\.ts|npm link/u);
    expect(scripts).toContain("--ignore-scripts");
    expect(scripts).toContain("tools/sibling-compatibility-checks.mjs");
  });

  it("reports next without failing the run and summarizes whatever legs finished", () => {
    expect(workflow.jobs["registry-tags"]?.["continue-on-error"]).toBe(
      "${{ matrix.tag == 'next' }}",
    );
    expect(workflow.jobs.summary?.needs).toEqual(["branch-tarballs", "registry-tags"]);
    expect(workflow.jobs.summary?.if).toBe("${{ !cancelled() }}");
    const upload = workflow.jobs.summary?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    // The name and file the sibling promotion gates download.
    expect(upload?.with).toMatchObject({
      name: "core-sibling-compatibility",
      path: "compatibility/core-sibling-compatibility.json",
    });
    expect(raw).toContain("RUN_ID: ${{ github.run_id }}");
    expect(raw).toContain("RUN_ATTEMPT: ${{ github.run_attempt }}");
  });
});

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const passing: ContractCheckResult[] = [
  { id: "supported-clis-shape", status: "passed" },
  { id: "refusal-input-unknown-version", status: "passed" },
];

type Tag = "next" | "latest";
const ALL_NEXT = { core: "next", scan: "next", catalog: "next" } as const;

function registryNext(tags: { core: Tag; scan: Tag; catalog: Tag }) {
  return {
    leg: "registry-next",
    status: "tested",
    os: "ubuntu-latest",
    node: "22",
    packages: [
      { package: "@aihq/core", version: "0.7.0", distTag: tags.core },
      { package: "@aihq/scan", version: "0.5.0", distTag: tags.scan },
      { package: "@aihq/catalog", version: "0.3.0", distTag: tags.catalog },
    ].map((entry, index) => ({
      ...entry,
      tarballSha256: sha(String(index + 1)),
      tarballIntegrity: integrity,
      source: { kind: "registry", tag: entry.distTag },
    })),
    lockfileSha256: sha("d"),
    contractChecks: passing,
  };
}

describe("core-sibling-compatibility.json", () => {
  it("emits exactly the shape Scan's promotion gate reads, with one leg per next package", () => {
    const artifact = buildCompatibilityArtifact({
      runId: "123456",
      runAttempt: 2,
      core: { repository: "samartomar/ai-harness", commit: "a".repeat(40) },
      reports: [
        { ...registryNext(ALL_NEXT), leg: "registry-latest" },
        registryNext(ALL_NEXT),
        { ...registryNext(ALL_NEXT), leg: "branch" },
      ].map((report, index) =>
        index === 1
          ? report
          : {
              ...report,
              packages: report.packages.map((entry) => ({ ...entry, distTag: "latest" })),
            },
      ),
    });
    expect(artifact).toMatchObject({
      format: "core-sibling-compatibility",
      version: 1,
      runId: "123456",
      runAttempt: "2",
    });
    // Replays the gate's own reading: a single @aihq/scan leg, every check literally "passed".
    const scanLegs = artifact.legs.filter((leg) => leg.package === "@aihq/scan");
    expect(scanLegs).toHaveLength(1);
    expect(scanLegs[0]).toMatchObject({
      version: "0.5.0",
      tarballSha256: sha("2"),
      tarballIntegrity: integrity,
    });
    expect(scanLegs[0]?.contractChecks.every((check) => check.status === "passed")).toBe(true);
    // Every package in the next leg came from next, so all three are promotable legs;
    // branch and latest reports are observations only.
    expect(artifact.legs.map((leg) => leg.package)).toEqual([
      "@aihq/core",
      "@aihq/scan",
      "@aihq/catalog",
    ]);
    expect(artifact.observations.map((report) => report.leg)).toEqual([
      "registry-latest",
      "registry-next",
      "branch",
    ]);
  });

  it("never makes a package tested at latest, or a tag-absent leg, promotable", () => {
    const filled = buildCompatibilityArtifact({
      runId: 1,
      runAttempt: 1,
      core: {},
      reports: [registryNext({ core: "latest", scan: "next", catalog: "latest" })],
    });
    expect(filled.legs.map((leg) => leg.package)).toEqual(["@aihq/scan"]);

    const absent = buildCompatibilityArtifact({
      runId: 1,
      runAttempt: 1,
      core: {},
      reports: [
        {
          leg: "registry-next",
          status: "tag-absent",
          packages: [
            { package: "@aihq/core", status: "tag-absent", distTag: "next" },
            { package: "@aihq/scan", status: "tag-absent", distTag: "next" },
            { package: "@aihq/catalog", status: "tag-absent", distTag: "next" },
          ],
        },
      ],
    });
    expect(absent.legs).toEqual([]);
    expect(absent.observations[0]?.status).toBe("tag-absent");
  });

  it("refuses a malformed leg report rather than recording it", () => {
    const good = registryNext(ALL_NEXT);
    for (const bad of [
      null,
      { ...good, leg: "registry-beta" },
      { ...good, lockfileSha256: "short" },
      { ...good, contractChecks: [] },
      { ...good, contractChecks: [{ id: "x", status: "pass" }] },
      {
        ...good,
        packages: good.packages.map((entry) => ({ ...entry, tarballIntegrity: "sha1-x" })),
      },
      { ...good, packages: [{ ...good.packages[0], package: "@evil/pkg" }] },
    ])
      expect(() => validateLegReport(bad)).toThrow();
    expect(() =>
      buildCompatibilityArtifact({ runId: "x", runAttempt: 1, core: {}, reports: [] }),
    ).toThrow();
    expect(() =>
      buildCompatibilityArtifact({
        runId: 1,
        runAttempt: 1,
        core: {},
        reports: [good, good],
      }),
    ).toThrow(/more than one registry-next/u);
  });
});

describe("the contract checks, run against this Core and the installed Scan", () => {
  it("passes Core's own checks and reports every absent sibling surface as unavailable", async () => {
    const scan = (await import("@aihq/scan")) as unknown as Record<string, unknown>;
    const results = await runContractChecks({
      core: core as unknown as Record<string, unknown>,
      scan,
      catalog: {},
      readSubpath: (specifier) => {
        const schema = /^@aihq\/core\/schemas\/(.+)$/u.exec(specifier)?.[1];
        if (schema === undefined)
          throw Object.assign(new Error(`${specifier} is not installed`), { code: "ENOENT" });
        return readFileSync(resolve(root, "schemas", schema));
      },
    });
    const status = Object.fromEntries(results.map((result) => [result.id, result.status]));
    expect(status).toEqual({
      "catalog-readers": "unavailable",
      "catalog-subject-digests": "unavailable",
      "scan-organization-evidence-schema-lock": "passed",
      "scan-decision-schema-lock": "passed",
      "catalog-decision-schema-lock": "unavailable",
      "catalog-qualification-receipt-schema-lock": "unavailable",
      "supported-clis-shape": "passed",
      "refusal-input-unknown-version": "passed",
      "refusal-evidence-unknown-version": "passed",
      "refusal-scan-core-contract-unknown": "passed",
      "refusal-catalog-index-unknown-version": "unavailable",
      // The published @aihq/scan 0.4.0 this checkout installs predates that export.
      "scan-custody-negative": "unavailable",
    });
  });

  it("fails a check whose refusal is not the named code, never passing it", async () => {
    const scan = (await import("@aihq/scan")) as unknown as Record<string, unknown>;
    const results = await runContractChecks({
      // A Core that folds every refusal into one code, as Core did before these checks existed.
      core: {
        ...core,
        consumeGovernanceInputV1: async () => ({ status: { reason: "malformed-bytes" } }),
      } as unknown as Record<string, unknown>,
      scan: { ...scan, AI_HARNESS_DECISION_V2_SCHEMA_SHA256: "f".repeat(64) },
      catalog: {
        readCatalogContentV1: () => undefined,
        readCatalogCollectionsV1: () => undefined,
        readCatalogPresentationV1: () => undefined,
      },
      readSubpath: (specifier) => {
        const schema = /^@aihq\/core\/schemas\/(.+)$/u.exec(specifier)?.[1];
        if (schema !== undefined) return readFileSync(resolve(root, "schemas", schema));
        return new TextEncoder().encode('{"format":"aih-catalog-index","version":1,"entries":[]}');
      },
    });
    const status = Object.fromEntries(results.map((result) => [result.id, result.status]));
    expect(status["scan-decision-schema-lock"]).toBe("failed");
    expect(status["catalog-readers"]).toBe("failed");
    expect(status["catalog-subject-digests"]).toBe("failed");
    expect(status["refusal-input-unknown-version"]).toBe("failed");
    expect(status["refusal-evidence-unknown-version"]).toBe("failed");
    expect(status["refusal-scan-core-contract-unknown"]).toBe("failed");
  });
});
