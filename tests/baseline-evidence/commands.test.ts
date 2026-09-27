import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredBaselineVetOptions } from "../../src/baseline-evidence/analyzer-profile.js";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import {
  baselineVetPlanForSource,
  vetBaselineCommand,
} from "../../src/baseline-evidence/commands.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { BaselineSourceEvidenceSchema } from "../../src/baseline-evidence/schema.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";
import { resolveTrustSource } from "../../src/trust/fetch.js";
import { createSelfCompletingFakeScanAdapterForTests } from "../trust/fakes/fake-scan-adapter.js";

// The vet runs through the installed @aihq/scan; this fake declares the uv
// detectors with their analyzer locks, which is all the plan reads before vetting.
const scan = createSelfCompletingFakeScanAdapterForTests({
  "detector.cisco": { kind: "refused", reason: "unused", detail: "unused" },
  "detector.semgrep": { kind: "refused", reason: "unused", detail: "unused" },
});
const scanPackageImporter = () => Promise.resolve(scan);

let root: string;
let sourceRoot: string;

beforeEach(() => {
  // realpathSync at creation so every derived expectation (sourceRoot, and the
  // vetCatalog call assertion below) agrees with the canonical path the
  // production code resolves internally (assertTrustTreeSafe / exactSourceRoot
  // both realpath their input). Without this, mkdtemp's raw path can differ
  // from its realpath on macOS (/var/folders/... vs /private/var/folders/...),
  // failing the toHaveBeenCalledWith(sourceRoot, ...) assertion below even
  // though the production code behaves correctly.
  root = realpathSync(mkdtempSync(join(tmpdir(), "aih-baseline-command-")));
  sourceRoot = join(root, "source");
  mkdirSync(join(sourceRoot, "skills", "clean"), { recursive: true });
  writeFileSync(join(sourceRoot, "skills", "clean", "SKILL.md"), "# Clean\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply: boolean, head = "a".repeat(40)): PlanContext {
  const run = fakeRunner((argv) =>
    argv[0] === "git" ? { stdout: argv.includes("status") ? "" : `${head}\n` } : undefined,
  );
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function catalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "samartomar",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [{ id: "skill:clean", paths: ["skills/clean"] }],
  });
}

function evidence() {
  return BaselineSourceEvidenceSchema.parse({
    id: "ecc",
    owner: "samartomar",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [
      {
        id: "skill:clean",
        paths: ["skills/clean"],
        treeSha256: hashComponentTree(sourceRoot, ["skills/clean"]).treeSha256,
        verdict: "no-findings",
        analyzers: [{ name: "aih-native", version: "2.7.0" }],
        findings: [],
        evidenceProblems: [],
      },
    ],
  });
}

describe("baseline vet command plan", () => {
  it("is registered under the real evidence command group", () => {
    const program = buildProgram();
    const evidence = program.commands.find((entry) => entry.name() === "evidence");
    const vet = evidence?.commands.find((entry) => entry.name() === "vet-baseline");
    expect(vet).toBeDefined();
    expect(vet?.registeredArguments[0]?.required).toBe(true);
    expect(vet?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--pin", "--catalog", "--components"]),
    );
  });

  it("writes one typed baseline report after an exact local checkout is vetted", async () => {
    const vetCatalog = vi.fn(async () => evidence());
    const source = resolveTrustSource(sourceRoot, { root });
    const result = await executePlan(
      await baselineVetPlanForSource(ctx(true), source, catalog(), {
        vetCatalog,
        scanPackageImporter,
      }),
      ctx(true),
    );
    const rel = `.aih/baseline-reports/ecc-${"a".repeat(12)}.json`;
    const required = await requiredBaselineVetOptions({
      platform: "linux",
      env: {},
      importer: scanPackageImporter,
    });

    expect(vetCatalog).toHaveBeenCalledOnce();
    expect(vetCatalog).toHaveBeenCalledWith(
      sourceRoot,
      catalog(),
      expect.objectContaining({
        analyzerVersions: required.analyzerVersions,
        requiredAnalyzers: required.requiredAnalyzers,
        requiredDetectorsForComponent: required.requiredDetectorsForComponent,
        sourceWideCisco: required.sourceWideCisco,
        sourceWideScan: required.sourceWideScan,
        scanOptions: expect.objectContaining({
          env: {},
          platform: "linux",
          progress: expect.any(Function),
          scanExecution: expect.objectContaining({ runDetectorV1: scan.runDetectorV1 }),
          uvExecutionProfileId: "host-process-uv-v1",
        }),
      }),
    );
    expect(existsSync(join(root, rel))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, rel), "utf8"))).toEqual({
      schemaVersion: 2,
      sources: [evidence()],
    });
    expect(result.execs).toHaveLength(0);
  });

  it("refuses a local checkout whose HEAD does not match the declared pin", async () => {
    const vetCatalog = vi.fn(async () => evidence());
    const source = resolveTrustSource(sourceRoot, { root });
    await expect(
      executePlan(
        await baselineVetPlanForSource(ctx(true, "b".repeat(40)), source, catalog(), {
          vetCatalog,
        }),
        ctx(true, "b".repeat(40)),
      ),
    ).rejects.toThrow(/expected pinned/i);
    expect(vetCatalog).not.toHaveBeenCalled();
  });

  it("rejects the retired fork even when its pin matches the canonical catalog", async () => {
    const c = ctx(false);
    c.options = {
      source: "samartomar/ECC",
      pin: baselineCatalogById("ecc").pinnedSha,
      catalog: "ecc",
      components: "runtime:ecc-installer",
    };

    await expect(vetBaselineCommand.plan(c)).rejects.toThrow(
      "--catalog ecc requires source affaan-m/ECC",
    );
  });
  it("previews a remote exact-pin fetch without network or report writes", async () => {
    const c = ctx(false);
    c.options = {
      source: "affaan-m/ECC",
      pin: baselineCatalogById("ecc").pinnedSha,
      catalog: "ecc",
      components: "runtime:ecc-installer",
    };
    const result = await executePlan(await vetBaselineCommand.plan(c), c);

    expect(result.execs).toEqual([expect.objectContaining({ ran: false })]);
    expect(existsSync(join(root, ".aih", "baseline-reports"))).toBe(false);
  });

  it("refuses a pin the installed Catalog does not carry before planning a fetch", async () => {
    const c = ctx(false);
    const carried = baselineCatalogById("ecc").pinnedSha;
    c.options = {
      source: "affaan-m/ECC",
      pin: "a".repeat(40),
      catalog: "ecc",
      components: "runtime:ecc-installer",
    };
    await expect(vetBaselineCommand.plan(c)).rejects.toMatchObject({
      code: "AIH_TRUST",
      message: `Catalog ecc carries pin ${carried}; it does not carry requested pin ${"a".repeat(40)}`,
    });
  });
});
