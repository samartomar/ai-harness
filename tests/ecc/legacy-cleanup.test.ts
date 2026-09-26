import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explicitEccMcpReceiptRecord,
  explicitEccMcpRenderPlan,
} from "../../packages/framework-ecc/src/legacy-cleanup/explicit-mcp.js";
import { legacyCleanupActions } from "../../packages/framework-ecc/src/legacy-cleanup/index.js";
import { planGovernedCodexRoleRegistration } from "../../packages/framework-ecc/src/profile/governed-codex-roles.js";
import {
  ECC_MATERIALIZATION_RECEIPT_PATH,
  ownedFileSha256,
  serializeEccMaterializationReceipt,
} from "../../src/ecc/materialization-receipt.js";
import {
  buildNativeEccRegistration,
  planNativeEccRegistration,
} from "../../src/ecc-profile/native-registration.js";
import {
  executeEccCommand,
  executeEccMcpRemoveCommand,
} from "../../src/framework-plugin/ecc-command.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as prune } from "../../src/prune/index.js";
import { executeUninstallCommand } from "../../src/uninstall/index.js";
import { planLegacyEccMcpFixtureAdd as planExplicitEccMcpAdd } from "../fixtures/legacy-ecc-mcp-add.js";

vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/framework-plugin/load-framework-plugin.js")>();
  const { sourcePluginAccess } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkPluginV1: (id: Parameters<typeof actual.loadFrameworkPluginV1>[0]) =>
      actual.loadFrameworkPluginV1(id, { access: sourcePluginAccess(id) }),
  };
});
vi.mock("../../src/catalog-package/framework-descriptors.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/catalog-package/framework-descriptors.js")>();
  const { eccDescriptorLoad } = await import("../framework-plugin/source-plugin-mocks.js");
  return {
    ...actual,
    loadFrameworkDescriptorBytesV1: async (
      id: Parameters<typeof actual.loadFrameworkDescriptorBytesV1>[0],
    ) => (id === "ecc" ? eccDescriptorLoad() : actual.loadFrameworkDescriptorBytesV1(id)),
  };
});

let root: string;
let nativeStateRoot: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-legacy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (nativeStateRoot !== undefined) rmSync(nativeStateRoot, { recursive: true, force: true });
  nativeStateRoot = undefined;
});

function put(path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function snapshotFiles(dir: string = root): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshotFiles(path));
    else if (entry.isFile()) files[path] = readFileSync(path);
  }
  return files;
}

function optionalBytes(path: string): Buffer | undefined {
  return existsSync(join(root, path)) ? readFileSync(join(root, path)) : undefined;
}

function finalManifestBytes(source: Buffer): Buffer {
  const manifest = JSON.parse(source.toString("utf8"));
  return Buffer.from(
    `${JSON.stringify(
      {
        ...manifest,
        installs: manifest.installs.map((install: { files: Array<{ path: string }> }) => ({
          ...install,
          files: install.files.filter((file) => file.path !== "skills/owned.md"),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function context(apply: boolean, run: Runner = fakeRunner(() => undefined)): PlanContext {
  const env = { HOME: join(root, "home"), USERPROFILE: join(root, "home") };
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

function manifestFixture(): void {
  const owned = "aih created\n";
  put(
    ".aih-config.json",
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
  );
  put("ai-coding/adapters/kiro.md", "stale Kiro adapter\n");
  put(".kiro/skills/owned.md", owned);
  put(".kiro/skills/operator.md", "keep me\n");
  put(
    ".aih/ecc/install-manifest.json",
    JSON.stringify({
      schemaVersion: "aih.ecc.install-manifest.v1",
      installs: [
        {
          target: "kiro",
          mechanism: "native-script",
          root: join(root, ".kiro"),
          installedAt: "2026-01-01T00:00:00Z",
          source: {
            kind: "git-checkout",
            ref: null,
            commit: "a".repeat(40),
            package: null,
            version: null,
          },
          files: [
            { path: "skills/owned.md", sha256: createHash("sha256").update(owned).digest("hex") },
          ],
        },
      ],
    }),
  );
}

function materializationFixture(): void {
  const clean = "# aih agent\n";
  const modified = "# operator changed rule\n";
  put(".claude/agents/owned.md", clean);
  put(".claude/rules/modified.md", modified);
  const authorization = (componentId: string) => ({
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor" as const,
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  });
  put(
    ECC_MATERIALIZATION_RECEIPT_PATH,
    serializeEccMaterializationReceipt({
      format: "aih-ecc-materialization-receipt",
      schemaVersion: 1,
      components: [
        {
          id: "agent:owned",
          authorization: authorization("agent:owned"),
          provenance: {
            repository: "affaan-m/ECC",
            commit: "a".repeat(40),
            componentPath: "agents/owned.md",
          },
          files: [
            {
              path: ".claude/agents/owned.md",
              operation: "copy-file",
              contentSha256: ownedFileSha256(clean),
            },
          ],
        },
        {
          id: "rule:modified",
          authorization: authorization("rule:modified"),
          provenance: {
            repository: "affaan-m/ECC",
            commit: "a".repeat(40),
            componentPath: "rules/modified.md",
          },
          files: [
            {
              path: ".claude/rules/modified.md",
              operation: "copy-file",
              contentSha256: ownedFileSha256("# original rule\n"),
            },
          ],
        },
      ],
    }),
  );
}

async function multiFamilyFixture(): Promise<void> {
  manifestFixture();
  const manifestPath = join(root, ".aih/ecc/install-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  put(".kiro/skills/modified.md", "operator manifest edit\n");
  manifest.installs[0].files.push({
    path: "skills/modified.md",
    sha256: createHash("sha256").update("original manifest bytes\n").digest("hex"),
  });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  materializationFixture();
  nativeStateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-native-state-"));
  const runtimeRoot = join(nativeStateRoot, "runtime");
  mkdirSync(runtimeRoot);
  const executable = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  const cliScript = join(runtimeRoot, "cli.js");
  writeFileSync(executable, "fixture executable\n");
  writeFileSync(cliScript, "fixture script\n");
  const serenaRuntimeRoot = fileURLToPath(
    new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
  );
  await executePlan(
    planNativeEccRegistration(
      root,
      buildNativeEccRegistration({
        root,
        stateRoot: nativeStateRoot,
        executable,
        cliScript,
        serenaRuntimeRoot,
      }),
      "install",
    ),
    context(true),
  );
  const policy = {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026.08",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      supportedClis: ["claude"],
      eccMcpApprovals: [
        {
          id: "memxus",
          sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          state: "approved",
          approvedBy: "security-admin",
          authenticationMode: "api-key",
          allowedDataClasses: ["non-sensitive-context"],
        },
      ],
    },
  };
  const rendered = explicitEccMcpRenderPlan(policy, "memxus", "claude");
  const mcpPath = join(root, ".mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  mcp.mcpServers.memxus = rendered.rendered;
  writeFileSync(mcpPath, JSON.stringify(mcp));
  put(
    ".aih/ecc-mcp-explicit-add-v1.json",
    JSON.stringify({
      format: "aih-ecc-mcp-explicit-add",
      version: 1,
      records: [explicitEccMcpReceiptRecord(rendered)],
    }),
  );
}

function shortBasename(path: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("cmd.exe", ["/d", "/c", `for %I in (${path}) do @echo %~snxI`], {
    encoding: "utf8",
  });
  const name = result.status === 0 ? result.stdout.trim() : "";
  return name.includes("~") &&
    existsSync(join(dirname(path), name)) &&
    name.toLowerCase() !== path.split(/[\\/]/).at(-1)?.toLowerCase()
    ? name
    : undefined;
}

const supportsEightDotThree = (() => {
  if (process.platform !== "win32") return false;
  const probe = mkdtempSync(join(tmpdir(), "aih-short-name-probe-"));
  try {
    const file = join(probe, "long-filename-for-short-name-check.txt");
    writeFileSync(file, "probe");
    return shortBasename(file) !== undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("legacy ECC cleanup through public lifecycle commands", () => {
  it("preserves every duplicate and normalized-alias manifest claim with its bytes and receipt", async () => {
    manifestFixture();
    const receiptPath = join(root, ".aih/ecc/install-manifest.json");
    const manifest = JSON.parse(readFileSync(receiptPath, "utf8"));
    const claim = manifest.installs[0].files[0];
    manifest.installs[0].files.push({ ...claim });
    manifest.installs[0].files.push({ ...claim, path: "skills/./owned.md" });
    writeFileSync(receiptPath, JSON.stringify(manifest));
    const before = readFileSync(receiptPath);
    const result = await executeUninstallCommand(context(true));
    expect(readFileSync(join(root, ".kiro/skills/owned.md"), "utf8")).toBe("aih created\n");
    expect(readFileSync(receiptPath)).toEqual(before);
    expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
      "duplicate ownership claim",
    );
  });

  it("preserves an entire manifest when one claim cannot be canonicalized", async () => {
    manifestFixture();
    nativeStateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-unresolved-alias-"));
    writeFileSync(join(nativeStateRoot, "owned.md"), "aih created\n");
    symlinkSync(
      nativeStateRoot,
      join(root, ".kiro/alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const receiptPath = join(root, ".aih/ecc/install-manifest.json");
    const manifest = JSON.parse(readFileSync(receiptPath, "utf8"));
    manifest.installs[0].files.push({
      ...manifest.installs[0].files[0],
      path: "alias/owned.md",
    });
    writeFileSync(receiptPath, JSON.stringify(manifest));
    const before = snapshotFiles();
    const result = await executeUninstallCommand(context(true));
    expect(snapshotFiles()[join(root, ".kiro/skills/owned.md")]).toEqual(
      before[join(root, ".kiro/skills/owned.md")],
    );
    expect(readFileSync(receiptPath)).toEqual(before[receiptPath]);
    const report = result.digests.map((entry) => entry.text).join("\n");
    expect(report).toContain("alias/owned.md");
    expect(report).toContain("skills/owned.md:");
  });

  it.runIf(process.platform === "win32")(
    "preserves claims through a Windows directory junction to the same file",
    async () => {
      manifestFixture();
      const receiptPath = join(root, ".aih/ecc/install-manifest.json");
      const filePath = join(root, ".kiro/skills/owned.md");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      symlinkSync(join(root, ".kiro/skills"), join(root, ".kiro/alias"), "junction");
      receipt.installs[0].files.push({ ...receipt.installs[0].files[0], path: "alias/owned.md" });
      writeFileSync(receiptPath, JSON.stringify(receipt));
      const before = readFileSync(receiptPath);
      const result = await executeUninstallCommand(context(true));
      expect(readFileSync(filePath, "utf8")).toBe("aih created\n");
      expect(readFileSync(receiptPath)).toEqual(before);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
        "duplicate ownership claim",
      );
    },
  );

  it.runIf(supportsEightDotThree)(
    "preserves both 8.3 and long-name claims for one existing file when the volume supports 8.3 names",
    async () => {
      manifestFixture();
      const receiptPath = join(root, ".aih/ecc/install-manifest.json");
      const name = "very-long-owned-filename.md";
      const filePath = join(root, ".kiro/skills", name);
      writeFileSync(filePath, "aih created\n");
      const alias = shortBasename(filePath);
      expect(alias).toBeDefined();
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.installs[0].files = [
        { ...receipt.installs[0].files[0], path: `skills/${name}` },
        { ...receipt.installs[0].files[0], path: `skills/${alias}` },
      ];
      writeFileSync(receiptPath, JSON.stringify(receipt));
      const before = readFileSync(receiptPath);
      const result = await executeUninstallCommand(context(true));
      expect(readFileSync(filePath, "utf8")).toBe("aih created\n");
      expect(readFileSync(receiptPath)).toEqual(before);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
        "duplicate ownership claim",
      );
    },
  );

  it("preserves an identical global MCP entry when its receipt came from another home", async () => {
    const oldHome = join(root, "old-home");
    const newHome = join(root, "new-home");
    mkdirSync(oldHome, { recursive: true });
    mkdirSync(newHome, { recursive: true });
    const policy = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["codex"],
        eccMcpApprovals: [
          {
            id: "memxus",
            sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
            state: "approved",
            approvedBy: "security-admin",
            authenticationMode: "api-key",
            allowedDataClasses: ["non-sensitive-context"],
          },
        ],
      },
    };
    const rendered = explicitEccMcpRenderPlan(policy, "memxus", "codex");
    const oldConfig = join(oldHome, ".codex/config.toml");
    mkdirSync(dirname(oldConfig), { recursive: true });
    writeFileSync(oldConfig, `${String(rendered.rendered)}\n`);
    put(
      ".aih/ecc-mcp-explicit-add-v1.json",
      JSON.stringify({
        format: "aih-ecc-mcp-explicit-add",
        version: 1,
        records: [explicitEccMcpReceiptRecord(rendered)],
      }),
    );
    const newConfig = join(newHome, ".codex/config.toml");
    mkdirSync(dirname(newConfig), { recursive: true });
    writeFileSync(newConfig, readFileSync(oldConfig));
    const before = readFileSync(newConfig);
    const receiptPath = join(root, ".aih/ecc-mcp-explicit-add-v1.json");
    const receiptBefore = readFileSync(receiptPath);
    const ctx = { ...context(true), env: { HOME: newHome, USERPROFILE: newHome } };
    const result = await executeUninstallCommand(ctx);
    expect(readFileSync(newConfig)).toEqual(before);
    expect(readFileSync(receiptPath)).toEqual(receiptBefore);
    expect(result.digests.map((entry) => entry.text).join("\n")).toContain("global MCP");
  });

  it("continues past modified and absent MCP records to remove later owned entries", async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
    const ids = ["memxus", "cloudflare-docs", "vercel"];
    const policy = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["claude"],
        eccMcpApprovals: ids.map((id) => ({
          id,
          sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          state: "approved",
          approvedBy: "security-admin",
          authenticationMode: "api-key",
          allowedDataClasses: ["non-sensitive-context"],
        })),
      },
    };
    const rendered = ids.map((id) => explicitEccMcpRenderPlan(policy, id, "claude"));
    put(
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          operator: { url: "https://operator.invalid" },
          memxus: { url: "https://operator-edit.invalid" },
          vercel: rendered[2]?.rendered,
        },
      }),
    );
    put(
      ".aih/ecc-mcp-explicit-add-v1.json",
      JSON.stringify({
        format: "aih-ecc-mcp-explicit-add",
        version: 1,
        records: rendered.map(explicitEccMcpReceiptRecord),
      }),
    );
    const result = await executeUninstallCommand(context(true));
    const servers = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
    expect(servers.operator).toEqual({ url: "https://operator.invalid" });
    expect(servers.memxus).toEqual({ url: "https://operator-edit.invalid" });
    expect(servers.vercel).toBeUndefined();
    expect(servers["cloudflare-docs"]).toBeUndefined();
    const receipt = JSON.parse(
      readFileSync(join(root, ".aih/ecc-mcp-explicit-add-v1.json"), "utf8"),
    );
    expect(receipt.records.map((record: { id: string }) => record.id)).toEqual(["memxus"]);
    expect(result.digests.map((entry) => entry.text).join("\n")).toContain("memxus");
  });

  it("composes native hooks, hook controls, and explicit MCP subtraction on shared files", async () => {
    nativeStateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-native-state-"));
    const runtimeRoot = join(nativeStateRoot, "runtime");
    mkdirSync(runtimeRoot);
    const executable = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
    const cliScript = join(runtimeRoot, "cli.js");
    writeFileSync(executable, "fixture executable\n");
    writeFileSync(cliScript, "fixture script\n");
    const serenaRuntimeRoot = fileURLToPath(
      new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
    );
    const registration = buildNativeEccRegistration({
      root,
      stateRoot: nativeStateRoot,
      executable,
      cliScript,
      serenaRuntimeRoot,
    });
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
    put(".claude/settings.json", JSON.stringify({ env: { OPERATOR: "keep" } }));
    put(
      ".mcp.json",
      JSON.stringify({ mcpServers: { operator: { url: "https://operator.invalid" } } }),
    );
    const ctx = context(true);
    await executePlan(planNativeEccRegistration(root, registration, "install"), ctx);
    const settingsPath = join(root, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.env.ECC_HOOK_PROFILE = "minimal";
    settings.env.ECC_DISABLED_HOOKS = "hook:one";
    writeFileSync(settingsPath, JSON.stringify(settings));
    put(
      ".aih/org-policy-framework-hook-controls-receipt.json",
      JSON.stringify({
        format: "aih-org-policy-framework-hook-controls-receipt",
        version: 1,
        destination: ".claude/settings.json",
        frameworks: {
          ecc: {
            keys: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
            set: { ECC_HOOK_PROFILE: "minimal", ECC_DISABLED_HOOKS: "hook:one" },
          },
        },
      }),
    );
    const policy = {
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["claude"],
        eccMcpApprovals: [
          {
            id: "memxus",
            sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
            state: "approved",
            approvedBy: "security-admin",
            authenticationMode: "api-key",
            allowedDataClasses: ["non-sensitive-context"],
          },
        ],
      },
    };
    await executePlan(planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }), ctx);
    await executeUninstallCommand(ctx);
    expect(readFileSync(settingsPath)).toEqual(
      Buffer.from('{\n  "env": {\n    "OPERATOR": "keep"\n  }\n}\n'),
    );
    expect(readFileSync(join(root, ".mcp.json"))).toEqual(
      Buffer.from(
        '{\n  "mcpServers": {\n    "operator": {\n      "url": "https://operator.invalid"\n    }\n  }\n}\n',
      ),
    );
    const afterSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(afterSettings.env).toEqual({ OPERATOR: "keep" });
    expect(afterSettings.hooks).toBeUndefined();
    const servers = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
    expect(servers.operator).toEqual({ url: "https://operator.invalid" });
    expect(servers.serena).toBeUndefined();
    expect(servers.memxus).toBeUndefined();
    expect(existsSync(join(root, ".aih/ecc-profile/native-registration-v1.json"))).toBe(false);
    expect(existsSync(join(root, ".aih/org-policy-framework-hook-controls-receipt.json"))).toBe(
      false,
    );
    expect(
      JSON.parse(readFileSync(join(root, ".aih/ecc-mcp-explicit-add-v1.json"), "utf8")).records,
    ).toEqual([]);
  });

  it("subtracts native and governed role TOML blocks together and retires both receipts", async () => {
    nativeStateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-native-state-"));
    const runtimeRoot = join(nativeStateRoot, "runtime");
    mkdirSync(runtimeRoot);
    const executable = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
    const cliScript = join(runtimeRoot, "cli.js");
    writeFileSync(executable, "fixture executable\n");
    writeFileSync(cliScript, "fixture script\n");
    const serenaRuntimeRoot = fileURLToPath(
      new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
    );
    const registration = buildNativeEccRegistration({
      root,
      stateRoot: nativeStateRoot,
      executable,
      cliScript,
      serenaRuntimeRoot,
    });
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
    const operator = 'model = "operator-choice"\r\n';
    put(".codex/config.toml", operator);
    const ctx = context(true);
    await executePlan(planNativeEccRegistration(root, registration, "install"), ctx);
    await executePlan(
      planGovernedCodexRoleRegistration(root, [
        { id: "reviewer", description: "reviewer", configFile: ".codex/agents/reviewer.toml" },
      ]),
      ctx,
    );
    const before = snapshotFiles();
    const cleanupActions = legacyCleanupActions(context(false), "uninstall");
    let plannedFinal = readFileSync(join(root, ".codex/config.toml"), "utf8");
    for (const action of cleanupActions) {
      if (action.kind === "write" && action.path === ".codex/config.toml") {
        plannedFinal = resolveContents(action, join(root, action.path), plannedFinal);
      }
    }
    const preview = await executePlan(
      plan("ECC cleanup preview", ...cleanupActions),
      context(false),
    );
    expect(preview.applied).toBe(false);
    expect(preview.writes.length).toBeGreaterThan(0);
    expect(snapshotFiles()).toEqual(before);
    await executeUninstallCommand(ctx);
    expect(readFileSync(join(root, ".codex/config.toml"))).toEqual(Buffer.from(operator));
    expect(readFileSync(join(root, ".codex/config.toml"))).toEqual(
      Buffer.from(plannedFinal, "utf8"),
    );
    expect(existsSync(join(root, ".aih/ecc-profile/native-registration-v1.json"))).toBe(false);
    expect(existsSync(join(root, ".aih/ecc/codex-role-registration-v1.json"))).toBe(false);
  });

  it("recovers manifest cleanup after every temp, backup, write, and remove effect", async () => {
    const fixturePath = fileURLToPath(
      new URL("../fixtures/legacy-cleanup-interrupt.ts", import.meta.url),
    );
    const run = (boundary: number) =>
      spawnSync(process.execPath, ["--import", "tsx", fixturePath, root, String(boundary)], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30_000,
      });
    const prepare = () => {
      manifestFixture();
      const receiptPath = join(root, ".aih/ecc/install-manifest.json");
      const manifest = JSON.parse(readFileSync(receiptPath, "utf8"));
      const modified = "operator edit\n";
      put(".kiro/skills/modified.md", modified);
      manifest.installs[0].files.push({
        path: "skills/modified.md",
        sha256: createHash("sha256").update("original aih bytes\n").digest("hex"),
      });
      writeFileSync(receiptPath, JSON.stringify(manifest));
      writeFileSync(`${receiptPath}.aih.tmp`, "stale temp\n");
      writeFileSync(`${receiptPath}.aih.bak`, "stale backup\n");
    };
    prepare();
    const initialReceipt = readFileSync(join(root, ".aih/ecc/install-manifest.json"));
    const completed = run(0);
    expect(completed.status, completed.stderr).toBe(0);
    const observed = JSON.parse(completed.stdout);
    expect(observed.kinds).toEqual(["backup", "remove", "temp", "write"]);
    expect(observed.scratchRemovals).toBe(2);
    for (let boundary = 1; boundary <= observed.effects; boundary += 1) {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "aih-ecc-legacy-"));
      prepare();
      const expectedReceipt = finalManifestBytes(
        readFileSync(join(root, ".aih/ecc/install-manifest.json")),
      );
      const child = run(boundary);
      expect(child.status, `effect ${boundary}: ${child.stderr}`).toBe(77);
      const receiptPath = join(root, ".aih/ecc/install-manifest.json");
      if (existsSync(join(root, ".kiro/skills/owned.md"))) {
        expect(readFileSync(receiptPath)).toEqual(initialReceipt);
      }
      await executeUninstallCommand(context(true));
      expect(existsSync(join(root, ".kiro/skills/owned.md"))).toBe(false);
      expect(readFileSync(join(root, ".kiro/skills/modified.md"), "utf8")).toBe("operator edit\n");
      expect(readFileSync(receiptPath)).toEqual(expectedReceipt);
    }
  }, 90_000);

  it.each(["materialization", "multi"] as const)(
    "recovers %s cleanup after every temp, backup, write, and remove effect",
    async (family) => {
      const fixturePath = fileURLToPath(
        new URL("../fixtures/legacy-cleanup-interrupt.ts", import.meta.url),
      );
      const run = (boundary: number) =>
        spawnSync(
          process.execPath,
          ["--import", "tsx", fixturePath, root, String(boundary), family],
          { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
        );
      const prepare = async () => {
        if (family === "multi") await multiFamilyFixture();
        else materializationFixture();
        const receiptPath = join(root, ECC_MATERIALIZATION_RECEIPT_PATH);
        writeFileSync(`${receiptPath}.aih.tmp`, "stale temp\n");
        writeFileSync(`${receiptPath}.aih.bak`, "stale backup\n");
      };
      await prepare();
      const comparedPaths = [
        ECC_MATERIALIZATION_RECEIPT_PATH,
        ...(family === "multi"
          ? [
              ".aih/ecc/install-manifest.json",
              ".aih/ecc-profile/native-registration-v1.json",
              ".aih/ecc-mcp-explicit-add-v1.json",
              ".claude/settings.json",
              ".codex/hooks.json",
            ]
          : []),
      ];
      const completed = run(0);
      expect(completed.status, completed.stderr).toBe(0);
      const observed = JSON.parse(completed.stdout);
      const boundaries = observed.effects as number;
      expect(boundaries).toBeGreaterThan(3);
      expect(observed.kinds).toEqual(["backup", "remove", "temp", "write"]);
      expect(observed.scratchRemovals).toBeGreaterThanOrEqual(2);
      const expectedBytes = new Map(comparedPaths.map((path) => [path, optionalBytes(path)]));
      for (let boundary = 1; boundary <= boundaries; boundary += 1) {
        rmSync(root, { recursive: true, force: true });
        if (nativeStateRoot !== undefined)
          rmSync(nativeStateRoot, { recursive: true, force: true });
        nativeStateRoot = undefined;
        root = mkdtempSync(join(tmpdir(), "aih-ecc-legacy-"));
        await prepare();
        const originalBytes = new Map(comparedPaths.map((path) => [path, optionalBytes(path)]));
        if (family === "multi")
          expectedBytes.set(
            ".aih/ecc/install-manifest.json",
            finalManifestBytes(originalBytes.get(".aih/ecc/install-manifest.json") as Buffer),
          );
        const interrupted = run(boundary);
        expect(interrupted.status, `effect ${boundary}: ${interrupted.stderr}`).toBe(77);
        const materialized = join(root, ".claude/agents/owned.md");
        if (existsSync(materialized)) {
          expect(optionalBytes(ECC_MATERIALIZATION_RECEIPT_PATH), `effect ${boundary}`).toEqual(
            originalBytes.get(ECC_MATERIALIZATION_RECEIPT_PATH),
          );
        }
        if (family === "multi" && existsSync(join(root, ".kiro/skills/owned.md"))) {
          expect(optionalBytes(".aih/ecc/install-manifest.json"), `effect ${boundary}`).toEqual(
            originalBytes.get(".aih/ecc/install-manifest.json"),
          );
        }
        if (family === "multi") {
          const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
          const managedHooks = [".claude/settings.json", ".codex/hooks.json"].some((path) => {
            const data = JSON.parse(readFileSync(join(root, path), "utf8"));
            return Object.values(data.hooks ?? {}).some((entries) =>
              JSON.stringify(entries).includes("Running AIH ECC profile policies"),
            );
          });
          if (mcp.mcpServers?.memxus !== undefined) {
            expect(
              optionalBytes(".aih/ecc-mcp-explicit-add-v1.json"),
              `effect ${boundary}`,
            ).toEqual(originalBytes.get(".aih/ecc-mcp-explicit-add-v1.json"));
          }
          for (const path of [".claude/settings.json", ".codex/hooks.json"]) {
            const current = optionalBytes(path) as Buffer;
            const data = JSON.parse(current.toString("utf8"));
            const hasManagedHook = Object.values(data.hooks ?? {}).some((entries) =>
              JSON.stringify(entries).includes("Running AIH ECC profile policies"),
            );
            if (hasManagedHook)
              expect(current, `effect ${boundary}: ${path}`).toEqual(originalBytes.get(path));
          }
          if (
            managedHooks ||
            mcp.mcpServers?.serena !== undefined ||
            readFileSync(join(root, ".codex/config.toml"), "utf8").includes(
              "aih managed (ecc-native-registration)",
            )
          ) {
            expect(
              optionalBytes(".aih/ecc-profile/native-registration-v1.json"),
              `effect ${boundary}`,
            ).toEqual(originalBytes.get(".aih/ecc-profile/native-registration-v1.json"));
          }
          expect(readFileSync(join(root, ".kiro/skills/modified.md"), "utf8")).toBe(
            "operator manifest edit\n",
          );
        }
        expect(readFileSync(join(root, ".claude/rules/modified.md"), "utf8")).toBe(
          "# operator changed rule\n",
        );
        const rerun = run(0);
        expect(rerun.status, `rerun after effect ${boundary}: ${rerun.stderr}`).toBe(0);
        expect(existsSync(materialized), `effect ${boundary}`).toBe(false);
        expect(readFileSync(join(root, ".claude/rules/modified.md"), "utf8")).toBe(
          "# operator changed rule\n",
        );
        if (family === "multi") {
          expect(existsSync(join(root, ".kiro/skills/owned.md")), `effect ${boundary}`).toBe(false);
          expect(readFileSync(join(root, ".kiro/skills/modified.md"), "utf8")).toBe(
            "operator manifest edit\n",
          );
          expect(
            existsSync(join(root, ".aih/ecc-profile/native-registration-v1.json")),
            `effect ${boundary}`,
          ).toBe(false);
          expect(
            JSON.parse(readFileSync(join(root, ".aih/ecc-mcp-explicit-add-v1.json"), "utf8"))
              .records,
          ).toEqual([]);
          const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
          expect(mcp.mcpServers?.memxus).toBeUndefined();
          expect(mcp.mcpServers?.serena).toBeUndefined();
          expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).not.toContain(
            "aih managed (ecc-native-registration)",
          );
          for (const path of [".claude/settings.json", ".codex/hooks.json"]) {
            expect(optionalBytes(path), `effect ${boundary}: ${path}`).toEqual(
              expectedBytes.get(path),
            );
          }
        }
        for (const path of comparedPaths) {
          expect(optionalBytes(path), `effect ${boundary}: ${path}`).toEqual(
            expectedBytes.get(path),
          );
        }
      }
    },
    180_000,
  );
  it.each([".claude/settings.json", ".codex/hooks.json"])(
    "reports modified managed hooks in %s and preserves both hooks and receipt",
    async (modifiedPath) => {
      await multiFamilyFixture();
      const receiptPath = join(root, ".aih/ecc-profile/native-registration-v1.json");
      const data = JSON.parse(readFileSync(join(root, modifiedPath), "utf8"));
      for (const entries of Object.values(data.hooks) as Array<
        Array<{ hooks: Array<{ timeout: number }> }>
      >) {
        for (const entry of entries) for (const hook of entry.hooks) hook.timeout = 45;
      }
      writeFileSync(join(root, modifiedPath), `${JSON.stringify(data, null, 2)}\n`);
      const receiptBefore = readFileSync(receiptPath);
      const claudeBefore = readFileSync(join(root, ".claude/settings.json"));
      const codexBefore = readFileSync(join(root, ".codex/hooks.json"));
      const result = await executeUninstallCommand(context(true));
      expect(readFileSync(receiptPath)).toEqual(receiptBefore);
      expect(readFileSync(join(root, ".claude/settings.json"))).toEqual(claudeBefore);
      expect(readFileSync(join(root, ".codex/hooks.json"))).toEqual(codexBefore);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
        `modified native registration managed hook: ${modifiedPath}`,
      );
    },
  );
  it("reports Codex hooks whose POSIX commands changed but Windows dispatchers remain", async () => {
    await multiFamilyFixture();
    const path = ".codex/hooks.json";
    const data = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const entries of Object.values(data.hooks) as Array<
      Array<{ hooks: Array<{ command: string; commandWindows: string }> }>
    >) {
      for (const entry of entries)
        for (const hook of entry.hooks) {
          expect(hook.commandWindows).toBeTruthy();
          hook.command += " ";
        }
    }
    writeFileSync(join(root, path), `${JSON.stringify(data, null, 2)}\n`);
    const receiptPath = ".aih/ecc-profile/native-registration-v1.json";
    const receiptBefore = optionalBytes(receiptPath);
    const claudeBefore = optionalBytes(".claude/settings.json");
    const codexBefore = optionalBytes(path);
    const result = await executeUninstallCommand(context(true));
    expect(optionalBytes(receiptPath)).toEqual(receiptBefore);
    expect(optionalBytes(".claude/settings.json")).toEqual(claudeBefore);
    expect(optionalBytes(path)).toEqual(codexBefore);
    expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
      `modified native registration managed hook: ${path}`,
    );
  });
  it("aih ecc --lifecycle uninstall reaches the receipt cleanup bridge", async () => {
    manifestFixture();
    const ctx = { ...context(true), options: { lifecycle: "uninstall" } };
    await executeEccCommand(ctx);
    expect(existsSync(join(root, ".kiro/skills/owned.md"))).toBe(false);
    expect(readFileSync(join(root, ".kiro/skills/operator.md"), "utf8")).toBe("keep me\n");
  });

  it.each(["uninstall", "prune"] as const)(
    "%s unregisters unchanged native ECC profile settings while preserving operator MCPs",
    async (route) => {
      nativeStateRoot = mkdtempSync(join(tmpdir(), "aih-ecc-native-state-"));
      const runtimeRoot = join(nativeStateRoot, "runtime");
      mkdirSync(runtimeRoot);
      const executable = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
      const cliScript = join(runtimeRoot, "cli.js");
      writeFileSync(executable, "fixture executable\n");
      writeFileSync(cliScript, "fixture script\n");
      const serenaRuntimeRoot = fileURLToPath(
        new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
      );
      const registration = buildNativeEccRegistration({
        root,
        stateRoot: nativeStateRoot,
        executable,
        cliScript,
        serenaRuntimeRoot,
      });
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/claude.md", "stale Claude adapter\n");
      put("ai-coding/adapters/codex.md", "stale Codex adapter\n");
      put(
        ".mcp.json",
        JSON.stringify({ mcpServers: { operator: { url: "https://example.invalid" } } }),
      );
      const ctx = context(true);
      await executePlan(planNativeEccRegistration(root, registration, "install"), ctx);
      const receiptPath = join(root, ".aih/ecc-profile/native-registration-v1.json");
      expect(existsSync(receiptPath)).toBe(true);
      if (route === "uninstall") await executeUninstallCommand(ctx);
      else await executePlan(await prune.plan(ctx), ctx);
      expect(existsSync(receiptPath)).toBe(false);
      const servers = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
      expect(servers.operator).toEqual({ url: "https://example.invalid" });
      expect(servers.serena).toBeUndefined();
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s preserves an ECC profile receipt with an unanchored stale pin",
    async (route) => {
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/claude.md", "stale Claude adapter\n");
      put(".agents/skills/operator/SKILL.md", "operator content\n");
      put(
        ".aih/ecc-profile/ownership-v1.json",
        JSON.stringify({
          schemaVersion: 1,
          state: "active",
          canonicalRoot: root,
          source: {
            recoveryIdentityVersion: 2,
            repository: "affaan-m/ECC",
            commit: "f".repeat(40),
            sourceClosureId: "old-closure",
            sourceClosureSha256: "b".repeat(64),
            projectionSha256: createHash("sha256").update("").digest("hex"),
          },
          files: [],
        }),
      );
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(existsSync(join(root, ".aih/ecc-profile/ownership-v1.json"))).toBe(true);
      expect(readFileSync(join(root, ".agents/skills/operator/SKILL.md"), "utf8")).toBe(
        "operator content\n",
      );
      expect(result.digests.map((entry) => entry.text).join("\n")).toMatch(
        /unanchored|ownership receipt/,
      );
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s withdraws an unchanged governed Codex role block and keeps operator TOML",
    async (route) => {
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/codex.md", "stale Codex adapter\n");
      put(".codex/config.toml", 'model = "operator-choice"\n');
      const ctx = context(true);
      await executePlan(
        planGovernedCodexRoleRegistration(root, [
          { id: "reviewer", description: "reviewer", configFile: ".codex/agents/reviewer.toml" },
        ]),
        ctx,
      );
      const receipt = join(root, ".aih/ecc/codex-role-registration-v1.json");
      expect(existsSync(receipt)).toBe(true);
      if (route === "uninstall") await executeUninstallCommand(ctx);
      else await executePlan(await prune.plan(ctx), ctx);
      expect(existsSync(receipt)).toBe(false);
      expect(readFileSync(join(root, ".codex/config.toml"), "utf8")).toBe(
        'model = "operator-choice"\n',
      );
    },
  );

  it("keeps a pre-existing empty TOML file after governed Codex role cleanup", async () => {
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
    put(".codex/config.toml", "");
    const ctx = context(true);
    await executePlan(
      planGovernedCodexRoleRegistration(root, [
        { id: "reviewer", description: "reviewer", configFile: ".codex/agents/reviewer.toml" },
      ]),
      ctx,
    );
    await executeUninstallCommand(ctx);
    expect(existsSync(join(root, ".codex/config.toml"))).toBe(true);
    expect(readFileSync(join(root, ".codex/config.toml"), "utf8").trim()).toBe("");
    expect(existsSync(join(root, ".aih/ecc/codex-role-registration-v1.json"))).toBe(false);
  });

  it.each(["uninstall", "prune"] as const)(
    "%s removes manifest-owned bytes and preserves unowned files",
    async (route) => {
      manifestFixture();
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(result.report?.checks.filter((check) => check.verdict === "fail") ?? []).toEqual([]);
      expect(existsSync(join(root, ".kiro/skills/owned.md"))).toBe(false);
      expect(readFileSync(join(root, ".kiro/skills/operator.md"), "utf8")).toBe("keep me\n");
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s preserves and reports a modified manifest file",
    async (route) => {
      manifestFixture();
      put(".kiro/skills/owned.md", "operator edit\n");
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(readFileSync(join(root, ".kiro/skills/owned.md"), "utf8")).toBe("operator edit\n");
      expect(result.digests.map((entry) => entry.text).join("\n")).toMatch(
        /skills\/owned\.md.*modified|modified.*skills\/owned\.md/i,
      );
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s completes an interrupted manifest cleanup on rerun",
    async (route) => {
      manifestFixture();
      const receiptPath = join(root, ".aih/ecc/install-manifest.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      const second = "second aih file\n";
      put(".kiro/skills/second.md", second);
      receipt.installs[0].files.push({
        path: "skills/second.md",
        sha256: createHash("sha256").update(second).digest("hex"),
      });
      writeFileSync(receiptPath, JSON.stringify(receipt));
      put(".kiro/skills/second.md", "operator edit\n");
      const ctx = context(true);
      const run = async () =>
        route === "uninstall"
          ? executeUninstallCommand(ctx)
          : executePlan(await prune.plan(ctx), ctx);
      await run();
      expect(existsSync(join(root, ".kiro/skills/owned.md"))).toBe(false);
      expect(readFileSync(join(root, ".kiro/skills/second.md"), "utf8")).toBe("operator edit\n");
      expect(existsSync(receiptPath)).toBe(true);
      put(".kiro/skills/second.md", second);
      await run();
      expect(existsSync(join(root, ".kiro/skills/second.md"))).toBe(false);
      expect(existsSync(receiptPath)).toBe(false);
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s preserves a second live project's shared home ECC claim",
    async (route) => {
      const home = join(root, "home");
      const other = join(home, "projects", "other");
      mkdirSync(other, { recursive: true });
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
      );
      put("ai-coding/adapters/codex.md", "stale Codex adapter\n");
      const ledgerPath = join(home, ".aih/ecc/registration-ledger.json");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const authorization = {
        componentId: "baseline:rules",
        source: "affaan-m/ECC",
        pinnedSha: "a".repeat(40),
        treeSha256: "b".repeat(64),
        tier: "vendor",
        issuer: "@aihq/core release",
        evidenceSha256: "c".repeat(64),
      };
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          projects: [root, other].map((projectRoot) => ({
            root: projectRoot,
            scope: "scoped",
            components: ["baseline:rules"],
            mcps: [],
          })),
          targets: [
            {
              target: "codex",
              components: [{ id: "baseline:rules", authorization }],
              mcps: [],
            },
          ],
        }),
      );
      const ctx = context(
        true,
        route === "uninstall" ? defaultRunner : fakeRunner(() => undefined),
      );
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      expect(ledger.projects.some((project: { root: string }) => project.root === other)).toBe(
        true,
      );
      expect(ledger.targets[0].target).toBe("codex");
      if (route === "uninstall") {
        expect(ledger.projects.some((project: { root: string }) => project.root === root)).toBe(
          false,
        );
      } else {
        expect(result.digests.map((entry) => entry.text).join("\n")).toContain(other);
      }
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s retires a stale machine registration pin while keeping a live project",
    async (route) => {
      const home = join(root, "home");
      const live = join(home, "projects", "live");
      const stale = join(home, "projects", "deleted");
      mkdirSync(live, { recursive: true });
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
      );
      const ledgerPath = join(home, ".aih/ecc/registration-ledger.json");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          projects: [stale, live].map((projectRoot) => ({
            root: projectRoot,
            scope: "scoped",
            components: [],
            mcps: [],
          })),
          targets: [],
        }),
      );
      const ctx = context(true, defaultRunner);
      if (route === "uninstall") await executeUninstallCommand(ctx);
      else await executePlan(await prune.plan(ctx), ctx);
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      expect(ledger.projects.map((project: { root: string }) => project.root)).toEqual([live]);
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s reports driver-listed bytes without aih per-path ownership proof",
    async (route) => {
      const home = join(root, "home");
      const cursorRoot = join(root, ".cursor");
      const statePath = join(cursorRoot, "ecc-install-state.json");
      const managed = join(cursorRoot, "skills", "tdd-workflow", "SKILL.md");
      put(".cursor/skills/tdd-workflow/SKILL.md", "driver listed\n");
      put("ai-coding/adapters/cursor.md", "stale cursor adapter\n");
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
      );
      const ledgerPath = join(home, ".aih/ecc/registration-ledger.json");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { root, scope: "scoped", components: ["skill:tdd-workflow"], mcps: ["mcp:github"] },
          ],
          targets: [
            {
              target: "cursor",
              components: [
                {
                  id: "skill:tdd-workflow",
                  authorization: {
                    componentId: "skill:tdd-workflow",
                    source: "affaan-m/ECC",
                    pinnedSha: "a".repeat(40),
                    treeSha256: "b".repeat(64),
                    tier: "vendor",
                    issuer: "@aihq/core release",
                    evidenceSha256: "c".repeat(64),
                  },
                },
              ],
              mcps: ["mcp:github"],
            },
          ],
        }),
      );
      writeFileSync(
        statePath,
        JSON.stringify({
          schemaVersion: "ecc.install.v1",
          installedAt: "2026-09-15T00:00:00.000Z",
          target: {
            id: "cursor-project",
            target: "cursor",
            kind: "project",
            root: cursorRoot,
            installStatePath: statePath,
          },
          request: {
            profile: null,
            modules: ["workflow-quality"],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: ["workflow-quality"], skippedModules: [] },
          source: {
            repoVersion: "2.2.1",
            repoCommit: "a".repeat(40),
            manifestVersion: 1,
          },
          operations: [
            {
              kind: "copy-file",
              moduleId: "workflow-quality",
              sourceRelativePath: "skills/tdd-workflow/SKILL.md",
              destinationPath: managed,
              strategy: "preserve-relative-path",
              ownership: "managed",
              scaffoldOnly: false,
              contentSha256: createHash("sha256").update("driver listed\n").digest("hex"),
            },
          ],
        }),
      );
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(readFileSync(managed, "utf8")).toBe("driver listed\n");
      expect(existsSync(statePath)).toBe(true);
      expect(existsSync(ledgerPath)).toBe(true);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(managed);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
        "verified-driver scoped MCP entries have no per-entry aih receipt",
      );
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s preserves edited Codex blocks and scoped MCP entries without byte receipts",
    async (route) => {
      const home = join(root, "home");
      const codexRoot = join(home, ".codex");
      const ledgerPath = join(home, ".aih/ecc/registration-ledger.json");
      const driverStatePath = join(codexRoot, "ecc-install-state.json");
      const aihStatePath = join(codexRoot, "ecc-aih-install-state.json");
      const configPath = join(codexRoot, "config.toml");
      const agentsPath = join(codexRoot, "AGENTS.md");
      mkdirSync(dirname(ledgerPath), { recursive: true });
      mkdirSync(codexRoot, { recursive: true });
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
      );
      put("ai-coding/adapters/codex.md", "stale Codex adapter\n");
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { root, scope: "scoped", components: ["baseline:rules"], mcps: ["mcp:github"] },
          ],
          targets: [
            {
              target: "codex",
              components: [
                {
                  id: "baseline:rules",
                  authorization: {
                    componentId: "baseline:rules",
                    source: "affaan-m/ECC",
                    pinnedSha: "a".repeat(40),
                    treeSha256: "b".repeat(64),
                    tier: "vendor",
                    issuer: "@aihq/core release",
                    evidenceSha256: "c".repeat(64),
                  },
                },
              ],
              mcps: ["mcp:github"],
            },
          ],
        }),
      );
      writeFileSync(
        driverStatePath,
        JSON.stringify({
          schemaVersion: "ecc.install.v1",
          installedAt: "2026-09-15T00:00:00.000Z",
          target: {
            id: "codex-home",
            target: "codex",
            kind: "home",
            root: codexRoot,
            installStatePath: driverStatePath,
          },
          request: {
            profile: null,
            modules: [],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: [], skippedModules: [] },
          source: { repoVersion: "2.2.1", repoCommit: "a".repeat(40), manifestVersion: 1 },
          operations: [],
        }),
      );
      writeFileSync(
        aihStatePath,
        JSON.stringify({
          schemaVersion: 1,
          managedBy: "aih",
          codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: ["github"] },
          agentsBlock: true,
        }),
      );
      writeFileSync(
        configPath,
        '# >>> aih managed (mcp) >>>\n[mcp_servers."github"]\nurl = "edited"\n# <<< aih managed (mcp) <<<\n',
      );
      writeFileSync(
        agentsPath,
        "<!-- BEGIN ecc-codex:agents -->\noperator edit\n<!-- END ecc-codex:agents -->\n",
      );
      const before = [ledgerPath, driverStatePath, aihStatePath, configPath, agentsPath].map(
        (path) => readFileSync(path),
      );
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      const after = [ledgerPath, driverStatePath, aihStatePath, configPath, agentsPath].map(
        (path) => readFileSync(path),
      );
      expect(after).toEqual(before);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(agentsPath);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(configPath);
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s subtracts only receipt-owned hook controls",
    async (route) => {
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/claude.md", "stale adapter\n");
      put(
        ".claude/settings.json",
        JSON.stringify({
          env: {
            ECC_HOOK_PROFILE: "minimal",
            ECC_DISABLED_HOOKS: "hook:one",
            SUPERPOWERS_MODE: "safe",
            OPERATOR: "keep",
          },
        }),
      );
      put(
        ".aih/org-policy-framework-hook-controls-receipt.json",
        JSON.stringify({
          format: "aih-org-policy-framework-hook-controls-receipt",
          version: 1,
          destination: ".claude/settings.json",
          frameworks: {
            ecc: {
              keys: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
              set: { ECC_HOOK_PROFILE: "minimal", ECC_DISABLED_HOOKS: "hook:one" },
            },
            superpowers: { keys: ["SUPERPOWERS_MODE"], set: { SUPERPOWERS_MODE: "safe" } },
          },
        }),
      );
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(result.report?.checks.filter((check) => check.verdict === "fail") ?? []).toEqual([]);
      expect(result.digests.map((entry) => entry.text).join("\n")).not.toContain(
        "preserve ECC hook settings",
      );
      const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
      expect(settings.env).toEqual({ SUPERPOWERS_MODE: "safe", OPERATOR: "keep" });
      const receipt = JSON.parse(
        readFileSync(join(root, ".aih/org-policy-framework-hook-controls-receipt.json"), "utf8"),
      );
      expect(receipt.frameworks).toEqual({
        superpowers: { keys: ["SUPERPOWERS_MODE"], set: { SUPERPOWERS_MODE: "safe" } },
      });
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s preserves ambiguous older ECC hook-control settings with a manual route",
    async (route) => {
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/claude.md", "stale Claude adapter\n");
      put(
        ".claude/settings.json",
        JSON.stringify({ env: { ECC_HOOK_PROFILE: "minimal", OPERATOR: "keep" } }),
      );
      put(".aih/org-policy-ecc-hook-controls-receipt.json", "{}\n");
      const before = readFileSync(join(root, ".claude/settings.json"));
      const ctx = context(true);
      const result =
        route === "uninstall"
          ? await executeUninstallCommand(ctx)
          : await executePlan(await prune.plan(ctx), ctx);
      expect(readFileSync(join(root, ".claude/settings.json"))).toEqual(before);
      expect(existsSync(join(root, ".aih/org-policy-ecc-hook-controls-receipt.json"))).toBe(true);
      expect(result.digests.map((entry) => entry.text).join("\n")).toContain(
        "ECC_HOOK_PROFILE and ECC_DISABLED_HOOKS",
      );
    },
  );

  it.each(["uninstall", "prune"] as const)(
    "%s subtracts an unchanged explicit MCP entry",
    async (route) => {
      put(
        ".aih-config.json",
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
      );
      put("ai-coding/adapters/claude.md", "stale adapter\n");
      put(
        ".mcp.json",
        JSON.stringify({ mcpServers: { operator: { url: "https://example.invalid" } } }),
      );
      const policy = {
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026.08",
          catalog: { reviewed: [], custom: [] },
          activations: [],
          authority: { approvals: [] },
          supportedClis: ["claude"],
          eccMcpApprovals: [
            {
              id: "memxus",
              sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
              state: "approved",
              approvedBy: "security-admin",
              authenticationMode: "api-key",
              allowedDataClasses: ["non-sensitive-context"],
            },
          ],
        },
      };
      await executePlan(
        planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
        context(true),
      );
      await executeEccMcpRemoveCommand({
        ...context(true),
        options: { id: "memxus", cli: "claude" },
      });
      expect(
        JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.memxus,
      ).toBeUndefined();
      await executePlan(
        planExplicitEccMcpAdd({ root, policy, id: "memxus", target: "claude" }),
        context(true),
      );
      const ctx = context(true);
      if (route === "uninstall") await executeUninstallCommand(ctx);
      else await executePlan(await prune.plan(ctx), ctx);
      const servers = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
      expect(servers.operator).toEqual({ url: "https://example.invalid" });
      expect(servers.memxus).toBeUndefined();
    },
  );
});
