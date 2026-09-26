import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planExplicitEccMcpAdd } from "../../packages/framework-ecc/src/ecc/mcp-explicit-add.js";
import { planGovernedCodexRoleRegistration } from "../../packages/framework-ecc/src/profile/governed-codex-roles.js";
import {
  buildNativeEccRegistration,
  planNativeEccRegistration,
} from "../../src/ecc-profile/native-registration.js";
import {
  executeEccCommand,
  executeEccMcpRemoveCommand,
} from "../../src/framework-plugin/ecc-command.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, fakeRunner, type Runner } from "../../src/internals/proc.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as prune } from "../../src/prune/index.js";
import { executeUninstallCommand } from "../../src/uninstall/index.js";

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

describe("legacy ECC cleanup through public lifecycle commands", () => {
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
