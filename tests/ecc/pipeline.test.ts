import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { buildEccRegistrationRequest, executeEccEvidencePipeline } from "../../src/ecc/pipeline.js";
import {
  emptyRegistrationLedger,
  mergeRegistrationLedger,
  writeRegistrationLedgerAtomic,
} from "../../src/ecc/registration.js";
import type { VerifiedEccRequest } from "../../src/ecc/verified.js";
import { doc, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { resolveTrustSource } from "../../src/trust/fetch.js";

let root: string;
let sourceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-pipeline-"));
  sourceRoot = join(root, "ecc-source");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "install.sh"), "echo verified\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply = true): PlanContext {
  const run = fakeRunner(() => undefined);
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
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [{ id: "runtime:ecc-kiro", paths: ["install.sh"] }],
  });
}

function vendorLock(verdict: "pass" | "blocked" = "pass") {
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "a".repeat(40),
        components: [
          {
            id: "runtime:ecc-kiro",
            paths: ["install.sh"],
            treeSha256: hashComponentTree(sourceRoot, ["install.sh"]).treeSha256,
            verdict,
            analyzers: [{ name: "aih-native", version: "2.7.0" }],
            findings:
              verdict === "blocked" ? [{ code: "prompt-injection", detail: "blocked" }] : [],
          },
        ],
      },
    ],
  });
}

const request = { clis: ["kiro" as const], profile: "core", packs: [] };

function mixedCatalog() {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: "a".repeat(40),
    components: [
      { id: "runtime:ecc-installer", paths: ["install.sh"] },
      { id: "module:rules-core", paths: ["rules-core"] },
      { id: "module:hooks-runtime", paths: ["hooks-runtime"] },
    ],
  });
}

function mixedVendorLock() {
  mkdirSync(join(sourceRoot, "rules-core"), { recursive: true });
  mkdirSync(join(sourceRoot, "hooks-runtime"), { recursive: true });
  writeFileSync(join(sourceRoot, "rules-core", "rule.md"), "# Rule\n");
  writeFileSync(join(sourceRoot, "hooks-runtime", "hook.js"), "export {};\n");
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [
      {
        id: "ecc",
        owner: "affaan-m",
        repo: "ECC",
        pinnedSha: "a".repeat(40),
        components: [
          {
            id: "runtime:ecc-installer",
            paths: ["install.sh"],
            treeSha256: hashComponentTree(sourceRoot, ["install.sh"]).treeSha256,
            verdict: "pass",
            analyzers: [{ name: "aih-native", version: "2.8.0" }],
            findings: [],
          },
          {
            id: "module:rules-core",
            paths: ["rules-core"],
            treeSha256: hashComponentTree(sourceRoot, ["rules-core"]).treeSha256,
            verdict: "pass",
            analyzers: [{ name: "aih-native", version: "2.8.0" }],
            findings: [],
          },
          {
            id: "module:hooks-runtime",
            paths: ["hooks-runtime"],
            treeSha256: hashComponentTree(sourceRoot, ["hooks-runtime"]).treeSha256,
            verdict: "blocked",
            analyzers: [{ name: "aih-native", version: "2.8.0" }],
            findings: [
              {
                code: "trust.auto-exec-hook",
                detail: "hook runtime auto-executes",
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("ECC baseline evidence pipeline", () => {
  it("builds the additive machine union from scan, declarations, MCP defaults, and prior projects", () => {
    const home = join(root, "home");
    const cpp = join(root, "cpp-project");
    mkdirSync(home, { recursive: true });
    mkdirSync(cpp, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: { react: "19.0.0" },
        devDependencies: { typescript: "5.0.0" },
      }),
    );
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "code-review-graph": { type: "stdio", command: "uvx", args: [] },
          context7: { type: "stdio", command: "npx", args: [] },
        },
      }),
    );
    const prior = mergeRegistrationLedger(
      emptyRegistrationLedger(),
      {
        root: cpp,
        scope: "scoped",
        components: ["lang:cpp", "agent:cpp-reviewer", "agent:cpp-build-resolver"],
        mcps: ["mcp:sequential-thinking"],
      },
      [],
    );
    writeRegistrationLedgerAtomic(home, prior);
    const context = ctx(false);
    context.posture = "team";
    context.env = { HOME: home };
    context.host = makeHostAdapter({ platform: "linux", run: context.run, env: context.env });
    context.options = { profile: "core", with: ["security-review"] };

    const request = buildEccRegistrationRequest(context, ["claude"]);

    expect(request.project.components).toEqual(
      expect.arrayContaining(["lang:typescript", "framework:react", "skill:security-review"]),
    );
    expect(request.project.components).not.toContain("lang:cpp");
    expect(request.selection.components).toEqual(
      expect.arrayContaining([
        "lang:typescript",
        "framework:react",
        "skill:security-review",
        "lang:cpp",
        "agent:cpp-reviewer",
        "agent:cpp-build-resolver",
      ]),
    );
    expect(request.selection.mcps).toEqual([
      "mcp:code-review-graph",
      "mcp:github",
      "mcp:sequential-thinking",
    ]);
    expect(request.selection.mcps).not.toContain("mcp:context7");
    expect(request.ledger.projects).toHaveLength(1);
  });

  it("constructs install actions only after exact evidence clears", async () => {
    const buildInstallPlan = vi.fn(() => plan("verified install", doc("install", "verified")));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).toHaveBeenCalledOnce();
    expect(result.docs).toEqual([expect.objectContaining({ describe: "install" })]);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("installs an authorized subset and reports held components without failing", async () => {
    const partialRequest: VerifiedEccRequest = {
      clis: ["claude" as const],
      profile: "core",
      packs: [],
      selection: {
        scope: "scoped" as const,
        components: ["baseline:rules", "baseline:hooks"],
        mcps: [],
        recommendations: [],
      },
    };
    const buildInstallPlan = vi.fn(() =>
      plan("verified partial install", doc("install", "partial")),
    );

    const result = await executeEccEvidencePipeline(ctx(), partialRequest, {
      catalog: mixedCatalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: mixedVendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).toHaveBeenCalledWith(
      expect.anything(),
      realpathSync(sourceRoot),
      partialRequest,
      [
        expect.objectContaining({ componentId: "runtime:ecc-installer" }),
        expect.objectContaining({ componentId: "module:rules-core" }),
      ],
    );
    expect(result.docs).toEqual([expect.objectContaining({ describe: "install" })]);
    expect(result.report?.exitCode()).toBe(0);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "skip",
          code: "baseline.evidence-blocked",
          detail: expect.stringContaining("module:hooks-runtime"),
        }),
      ]),
    );
    expect(result.digests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          describe: "held baseline components",
          data: {
            held: [
              expect.objectContaining({
                componentId: "module:hooks-runtime",
                routeCode: "baseline.evidence-blocked",
                codes: ["trust.auto-exec-hook"],
              }),
            ],
          },
        }),
      ]),
    );
  });

  it("never constructs install actions when signed evidence blocks", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock("blocked"),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(result.report?.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-blocked" }),
    ]);
  });

  it("fails closed on invalid configured org evidence before install construction", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const result = await executeEccEvidencePipeline(ctx(), request, {
      catalog: catalog(),
      source: resolveTrustSource(sourceRoot, { root }),
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
      resolveOrgEvidence: async () => ({
        checks: [
          {
            name: "org baseline evidence",
            verdict: "fail",
            code: "baseline.evidence-mismatch",
            detail: "signature invalid",
          },
        ],
      }),
    });

    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(result.report?.exitCode()).toBe(1);
  });

  it("previews an exact remote pin without fetching or constructing installs", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const source = resolveTrustSource("affaan-m/ECC", {
      root,
      pin: "a".repeat(40),
    });
    if (source.kind !== "github") throw new Error("expected GitHub source");

    const result = await executeEccEvidencePipeline(ctx(false), request, {
      catalog: catalog(),
      source,
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(result.execs).toEqual([
      expect.objectContaining({ ran: false, argv: expect.arrayContaining(["-e"]) }),
    ]);
    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(existsSync(source.quarantineRoot)).toBe(false);
  });

  it("rejects fetched metadata that does not bind the catalog pin", async () => {
    const buildInstallPlan = vi.fn(() => plan("must not build"));
    const source = resolveTrustSource("affaan-m/ECC", {
      root,
      pin: "a".repeat(40),
    });
    if (source.kind !== "github") throw new Error("expected GitHub source");
    const run = fakeRunner((argv) => {
      if (argv[0] !== process.execPath || argv[1] !== "-e") return undefined;
      const input = JSON.parse(argv[3] ?? "{}") as {
        metadataPath: string;
        owner: string;
        ref: string;
        repo: string;
        treePath: string;
      };
      mkdirSync(input.treePath, { recursive: true });
      writeFileSync(join(input.treePath, "install.sh"), "echo fetched\n");
      writeFileSync(
        input.metadataPath,
        JSON.stringify({
          kind: "github",
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
          pinnedSha: "b".repeat(40),
          source: `${input.owner}/${input.repo}`,
          treePath: input.treePath,
        }),
      );
      return { code: 0 };
    });
    const context = ctx();
    context.run = run;
    context.host = makeHostAdapter({ platform: "linux", run, env: {} });

    const result = await executeEccEvidencePipeline(context, request, {
      catalog: catalog(),
      source,
      vendorLock: vendorLock(),
      vendorLockSha256: "f".repeat(64),
      buildInstallPlan,
    });

    expect(buildInstallPlan).not.toHaveBeenCalled();
    expect(result.report?.checks).toEqual([
      expect.objectContaining({ verdict: "fail", code: "baseline.evidence-mismatch" }),
    ]);
    expect(existsSync(source.quarantineRoot)).toBe(false);
  });
});
