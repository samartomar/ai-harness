import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/internals/proc.js";
import {
  adminCatalogBootstrapPathV1,
  vibeAdminCatalogRootV1,
} from "../../src/org-policy/admin-catalog-bootstrap-v1.js";
import type { AdminCatalogHttpsResponseV1 } from "../../src/org-policy/admin-catalog-operations-v1.js";
import { runPolicyGenerate } from "../../src/org-policy/generate.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";
import { buildProgram } from "../../src/program.js";
import {
  artifactBytes,
  attestationBytes,
  bootstrapBytes,
  catalogArtifactUrl,
  catalogAttestationUrl,
  distributionAttestationBytes,
  presignedDistributionBytes,
  signedDistributionAttestationUrl,
  signedDistributionUrl,
} from "./admin-catalog-fixtures.js";

let workspace: string;
let cwd: string;
let adminRoot: string;
let toolchain: string;

const WALL_CLOCK = "2026-08-17T12:00:10Z";

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-policy-generate-catalog-"));
  cwd = join(workspace, "cwd");
  adminRoot = join(workspace, "admin");
  toolchain = join(workspace, "toolchain");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(adminRoot, { recursive: true });
  mkdirSync(toolchain, { recursive: true });
  const gh = join(toolchain, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "test gh");
  if (process.platform !== "win32") chmodSync(gh, 0o700);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function commandStub(options: Record<string, unknown> = {}): Command {
  return {
    optsWithGlobals: () => ({ apply: true, posture: "vibe", ...options }),
  } as unknown as Command;
}

function seedBootstrap(): void {
  const root = vibeAdminCatalogRootV1(adminRoot);
  mkdirSync(root, { recursive: true });
  writeFileSync(adminCatalogBootstrapPathV1(root), bootstrapBytes());
}

function seams() {
  const calls = { argv: [] as string[][], urls: [] as string[] };
  const responses: Record<string, AdminCatalogHttpsResponseV1> = {
    [catalogArtifactUrl]: { kind: "available", bytes: artifactBytes() },
    [catalogAttestationUrl]: { kind: "available", bytes: attestationBytes },
    [signedDistributionUrl]: { kind: "available", bytes: presignedDistributionBytes() },
    [signedDistributionAttestationUrl]: { kind: "available", bytes: distributionAttestationBytes },
  };
  return {
    calls,
    baseline: async () => ({
      ageSeconds: 0,
      digest: "a".repeat(64),
      resolvedAt: WALL_CLOCK,
      schemaVersion: 1,
      sourceIds: ["ecc", "superpowers"],
      tier: "fresh" as const,
    }),
    catalog: {
      fetchHttps: async (request: { url: string }) => {
        calls.urls.push(request.url);
        return responses[request.url] ?? { kind: "unavailable" as const };
      },
      now: WALL_CLOCK,
      platformAdminRoot: join(workspace, "platform"),
      tempRoot: workspace,
    },
    run: async (argv: string[]): Promise<RunResult> => {
      calls.argv.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

describe("policy generate admin catalog route", () => {
  it("registers an optional admin-root positional and keeps the rootless portable route", () => {
    const generate = buildProgram()
      .commands.find((command) => command.name() === "policy")
      ?.commands.find((command) => command.name() === "generate");
    expect(generate?.registeredArguments.map((argument) => argument.name())).toEqual([
      "admin-root",
    ]);
    expect(generate?.registeredArguments[0]?.required).toBe(false);
  });

  it("stays a portable authoring artifact with no fetch, process, or cache authority without an admin root", async () => {
    const injected = seams();
    const output: string[] = [];
    const code = await runPolicyGenerate(commandStub(), {
      catalog: injected.catalog,
      cwd,
      env: { AIH_POSTURE: "enterprise" },
      run: injected.run,
      write: (text) => output.push(text),
    });
    expect(code).toBe(0);
    expect(injected.calls.urls).toHaveLength(0);
    expect(injected.calls.argv).toHaveLength(0);
    const html = readFileSync(join(cwd, "aih-policy-workbench.html"), "utf8");
    expect(html).not.toContain("catalog-provenance");
    expect(Object.hasOwn(policyStudioModel(), "catalogProvenance")).toBe(false);
  });

  it("resolves the catalog before rendering and shows verified tier, source, and age safely", async () => {
    seedBootstrap();
    const injected = seams();
    const code = await runPolicyGenerate(commandStub(), {
      adminRoot,
      baseline: injected.baseline,
      catalog: injected.catalog,
      cwd,
      env: { PATH: toolchain },
      run: injected.run,
      write: () => undefined,
    });
    expect(code).toBe(0);
    expect(injected.calls.argv).toHaveLength(2);
    const html = readFileSync(join(cwd, "aih-policy-workbench.html"), "utf8");
    expect(html).toContain('id="catalog-provenance"');
    expect(html).toContain("fresh");
    expect(html).toContain("supported-catalog");
    expect(html).toContain("stable");
    expect(html).toContain("local-admin-file");
    expect(html).toContain("2026-08-17T12:00:00Z");
    for (const secret of [
      catalogArtifactUrl,
      catalogAttestationUrl,
      signedDistributionUrl,
      adminRoot,
      workspace,
      attestationBytes.toString("base64"),
    ]) {
      expect(html.includes(secret), secret).toBe(false);
    }
  });

  it("keeps an admin-root dry run plan-only, with no HTTPS, gh, cache, or workbench effects", async () => {
    seedBootstrap();
    const injected = seams();
    const output: string[] = [];
    const code = await runPolicyGenerate(commandStub({ apply: false }), {
      adminRoot,
      baseline: injected.baseline,
      catalog: injected.catalog,
      cwd,
      env: { PATH: toolchain },
      run: injected.run,
      write: (text) => output.push(text),
    });
    expect(code).toBe(1);
    expect(output.join(" ")).toContain("--apply");
    expect(injected.calls.urls).toHaveLength(0);
    expect(injected.calls.argv).toHaveLength(0);
    expect(existsSync(join(cwd, "aih-policy-workbench.html"))).toBe(false);
    expect(existsSync(join(vibeAdminCatalogRootV1(adminRoot), "cache"))).toBe(false);
  });

  it("rejects whitespace-padded admin-root authority text before any effect", async () => {
    seedBootstrap();
    const injected = seams();
    const output: string[] = [];
    const code = await runPolicyGenerate(commandStub(), {
      adminRoot: ` ${adminRoot} `,
      baseline: injected.baseline,
      catalog: injected.catalog,
      cwd,
      env: { PATH: toolchain },
      run: injected.run,
      write: (text) => output.push(text),
    });
    expect(code).toBe(1);
    expect(output.join(" ")).toContain("leading or trailing whitespace");
    expect(injected.calls.urls).toHaveLength(0);
    expect(injected.calls.argv).toHaveLength(0);
  });

  it("fails the command and writes no workbench when catalog resolution is fatal", async () => {
    const injected = seams();
    const output: string[] = [];
    const code = await runPolicyGenerate(commandStub({ json: true }), {
      adminRoot,
      baseline: injected.baseline,
      catalog: injected.catalog,
      cwd,
      env: {},
      run: injected.run,
      write: (text) => output.push(text),
    });
    expect(code).toBe(1);
    expect(existsSync(join(cwd, "aih-policy-workbench.html"))).toBe(false);
    const reported = JSON.parse(output.join("")) as { error: { code: string; message: string } };
    expect(reported.error.code).toBe("AIH_ADMIN_CATALOG");
    expect(reported.error.message).not.toContain(workspace);
  });

  it("takes the enterprise decision only from the explicit posture flag, never from the environment", async () => {
    seedBootstrap();
    const injected = seams();
    const code = await runPolicyGenerate(commandStub({ posture: "enterprise" }), {
      adminRoot,
      baseline: injected.baseline,
      catalog: injected.catalog,
      cwd,
      env: { AIH_POSTURE: "vibe" },
      run: injected.run,
      write: () => undefined,
    });
    // Enterprise never accepts the admin-root copy, so the run fails closed.
    expect(code).toBe(1);
    expect(existsSync(join(cwd, "aih-policy-workbench.html"))).toBe(false);
  });

  it("carries only the safe provenance fields into the rendered workbench model", () => {
    const provenance = {
      ageSeconds: 30,
      bootstrapProvenance: "os-admin-managed" as const,
      catalogSha256: "a".repeat(64),
      channel: "stable",
      headDigestSha256: "b".repeat(64),
      memberCount: 3,
      posture: "enterprise" as const,
      resolvedAt: "2026-08-17T12:00:00Z",
      sequence: 42,
      sourceId: "supported-catalog",
      tier: "cached-verified" as const,
      verifiedAt: "2026-08-17T11:59:30Z",
    };
    const model = policyStudioModel(provenance);
    expect(model.catalogProvenance).toEqual(provenance);
    const html = policyStudioHtml(model);
    expect(html).toContain("cached-verified");
    expect(html).toContain("os-admin-managed");
    expect(html).toContain("30");
  });
});
