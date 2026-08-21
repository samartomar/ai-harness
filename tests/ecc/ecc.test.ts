import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexInstallStateCleanupAction,
  coreOwnedEccCodexMcpServers,
  stripCodexTomlFootprint,
} from "../../src/ecc/codex.js";
import { codexEccActions, command } from "../../src/ecc/index.js";
import {
  AIH_DIRECT_ECC_INSTALL_TARGETS,
  ECC_INSTALL_MECHANISM_LABELS,
  ECC_INSTALL_TARGETS,
  ECC_NPM_BINS,
  eccInstallerArgv,
  eccInstallMechanism,
  isAihDirectEccInstallTarget,
  isEccInstallTarget,
  normalizeEccInstallVersion,
} from "../../src/ecc/install.js";
import {
  ECC_INSTALL_MANIFEST_SCHEMA_VERSION,
  hashManagedFile,
  readEccInstallManifest,
  writeEccInstallManifestAtomic,
} from "../../src/ecc/install-manifest.js";
import { eccLanguages } from "../../src/ecc/select.js";
import { REGISTRY_IDS } from "../../src/internals/cli-registry.js";
import type { Cli } from "../../src/internals/clis.js";
import type {
  Action,
  DocAction,
  ExecAction,
  PlanContext,
  ProbeAction,
  WriteAction,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { RepoStack } from "../../src/profile/scan.js";

function supportsSymlinks(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-symlink-"));
  try {
    const target = join(probe, "target");
    const link = join(probe, "link");
    writeFileSync(target, "probe\n", "utf8");
    symlinkSync(target, link);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const symlinksAvailable = supportsSymlinks();

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-ecc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(relPath: string, contents: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function stack(over: Partial<RepoStack> = {}): RepoStack {
  return {
    languages: [],
    frameworks: [],
    cloud: [],
    databases: [],
    deployment: [],
    hasTypeScript: false,
    scripts: {},
    entryPoints: [],
    browserTest: false,
    isMonorepo: false,
    ...over,
  };
}

function makeCtx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    // HOME → temp so the Kiro cache dir (~/.claude/ecc) is absent → clone path (hermetic).
    env: { HOME: tmp, USERPROFILE: tmp },
    options,
  };
}

/**
 * A Windows-host plan context — exercises the Kiro Git Bash resolution and the npx
 * `.cmd`-shim routing. `USERPROFILE → tmp` keeps the Kiro cache dir absent (clone
 * path, hermetic); callers pass `env` to point the Git-install probe dirs at
 * controlled tmp locations so bash.exe presence is deterministic across OSes.
 */
function makeWinCtx(
  over: { env?: NodeJS.ProcessEnv; options?: Record<string, unknown> } = {},
): PlanContext {
  const run = fakeRunner(() => undefined);
  const env: NodeJS.ProcessEnv = { USERPROFILE: tmp, ...over.env };
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "windows", run, env }),
    env,
    options: over.options ?? { cli: "kiro" },
  };
}

const docs = (actions: Action[]): DocAction[] =>
  actions.filter((a): a is DocAction => a.kind === "doc");
const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((a): a is ExecAction => a.kind === "exec");
const execBlob = (actions: Action[]): string =>
  execs(actions)
    .map((action) => {
      const program = action.argv[2];
      const packed =
        typeof program === "string"
          ? /inflateRawSync\(Buffer\.from\("([^"\\]+)", "base64"\)\)/.exec(program)
          : undefined;
      const source = packed?.[1]
        ? inflateRawSync(Buffer.from(packed[1], "base64")).toString("utf8")
        : "";
      return `${action.argv.join(" ")}\n${source}`;
    })
    .join("\n")
    .replace(/\\/g, "/");
const installTargets = (actions: Action[]): (string | undefined)[] =>
  execs(actions)
    .filter((e) => e.argv.includes("ecc-install") && e.argv.includes("--target"))
    .map((e) => e.argv[e.argv.indexOf("--target") + 1]);

function codexInstallState(actions: Action[]): {
  codexToml: { tables: string[]; tableKeys: Record<string, string[]>; mcpServers: string[] };
} {
  const install = execs(actions).find((e) => e.describe.includes("record prune state"));
  const stateB64 = install?.argv.at(-1);
  if (!stateB64) throw new Error("missing encoded Codex install state");
  return JSON.parse(Buffer.from(stateB64, "base64").toString("utf8")) as {
    codexToml: { tables: string[]; tableKeys: Record<string, string[]>; mcpServers: string[] };
  };
}

describe("eccLanguages — map detected stack to ECC language packs", () => {
  it("maps a TypeScript repo to the typescript pack", () => {
    const sel = eccLanguages(stack({ languages: ["TypeScript/Node.js"], hasTypeScript: true }));
    expect(sel.packs).toEqual(["typescript"]);
    expect(sel.installEverything).toBe(false);
  });

  it("maps a plain JavaScript repo to the typescript pack (it covers JS)", () => {
    const sel = eccLanguages(stack({ languages: ["JavaScript/Node.js"] }));
    expect(sel.packs).toEqual(["typescript"]);
  });

  it("adds the web pack for a frontend framework, deduped and ordered", () => {
    const sel = eccLanguages(stack({ languages: ["TypeScript/Node.js"], frameworks: ["Next.js"] }));
    expect(sel.packs).toEqual(["typescript", "web"]);
  });

  it("maps Python and Go to their packs", () => {
    expect(eccLanguages(stack({ languages: ["Python"] })).packs).toEqual(["python"]);
    expect(eccLanguages(stack({ languages: ["Go"] })).packs).toEqual(["golang"]);
  });

  it("keeps an empty repo scoped so declarations can supply its intended stack", () => {
    const sel = eccLanguages(stack());
    expect(sel.installEverything).toBe(false);
    expect(sel.packs).toEqual([]);
  });

  it("does not invent a pack for a language ECC lacks (Rust → baseline only)", () => {
    const sel = eccLanguages(stack({ languages: ["Rust"], deployment: ["Docker"] }));
    expect(sel.packs).toEqual([]);
    expect(sel.installEverything).toBe(false); // deployment detected → not 'everything'
  });
});

describe("ecc install targets / argv (latest from npm)", () => {
  it("knows which CLIs ECC installs directly from npm (v2 adapters)", () => {
    for (const cli of [
      "claude",
      "codex",
      "cursor",
      "antigravity",
      "gemini",
      "opencode",
      "zed",
    ] as const) {
      expect(isEccInstallTarget(cli)).toBe(true);
    }
    // kiro ships only in the repo; copilot/windsurf/kimi aren't ECC targets → not direct.
    expect(isEccInstallTarget("kiro")).toBe(false);
    expect(isEccInstallTarget("copilot")).toBe(false);
    expect(isEccInstallTarget("windsurf")).toBe(false);
    expect(isEccInstallTarget("kimi")).toBe(false);
    expect(ECC_INSTALL_TARGETS).toContain("zed");
    expect(ECC_INSTALL_TARGETS).toContain("codex");
    expect(isAihDirectEccInstallTarget("codex")).toBe(false);
    expect(AIH_DIRECT_ECC_INSTALL_TARGETS).not.toContain("codex");
    expect(isAihDirectEccInstallTarget("claude")).toBe(true);
  });

  it("builds explicit npx --package ecc-universal argv scoped by profile and packs", () => {
    expect(eccInstallerArgv("cursor", "core")).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "core",
    ]);
    expect(eccInstallerArgv("gemini", "full")).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "gemini",
      "--profile",
      "full",
    ]);
    expect(eccInstallerArgv("cursor", "core", undefined, ["typescript", "web"])).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "core",
      "typescript",
      "web",
    ]);
  });

  it("tracks both ecc-universal bins used by install and prune drift checks", () => {
    expect(ECC_NPM_BINS).toEqual(expect.arrayContaining(["ecc-install", "ecc"]));
  });
});

describe("ecc.plan — runs ECC's own installer (latest)", () => {
  it("default (claude) runs npx --package ecc-universal ecc-install --target claude under --apply", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx())).actions;
    expect(execs(actions)[0]?.argv).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "claude",
      "--profile",
      "minimal",
      "typescript",
    ]);
    // the marketplace plugin is still offered as a doc alternative
    expect(
      docs(actions)
        .map((d) => d.text)
        .join("\n"),
    ).toContain("/plugin install ecc@ecc");
  });

  it("does not promise a rerun re-scopes, since no mechanism replaces installed content (#555)", async () => {
    const text = docs((await command.plan(makeCtx({ allTools: true }))).actions)
      .map((d) => d.text)
      .join("\n");
    // Kiro's native installer is absence-guarded and Codex's helpers are add-only,
    // so a blanket "re-run to re-scope" is false for them and meaningless for the
    // consult-only targets, which install nothing at all.
    expect(text).not.toMatch(/Re-run after the stack changes to re-scope/);
  });

  it("states that reruns do not update already-installed Kiro content (#555)", async () => {
    const text = docs((await command.plan(makeCtx({ cli: "kiro" }))).actions)
      .map((d) => d.text)
      .join("\n");
    // "(idempotent)" reads to operators as "safe to re-run for updates". ECC's
    // .kiro/install.sh copies only absent destinations, so say so plainly.
    expect(text).toMatch(/does not update|will not update|untouched/i);
    expect(text).not.toMatch(/\(idempotent\)/);
  });

  it("derives the mechanism claims from the registry, not a hand-written literal (#555)", async () => {
    // windsurf is consult-only: it installs nothing, so it must not be handed the
    // npm / Codex / Kiro mechanism claims a hardcoded literal emitted on every run.
    const text = docs((await command.plan(makeCtx({ cli: "windsurf" }))).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).not.toMatch(/ecc-install --target <cli>/);
    expect(text).not.toMatch(/Kiro → cached git checkout/);
    expect(text).not.toMatch(/Codex → cached git checkout/);
    expect(text).toMatch(/install nothing/i);
  });

  it("emits only the selected target's mechanism claim (#555)", async () => {
    const text = docs((await command.plan(makeCtx({ cli: "kiro" }))).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toMatch(/Kiro → cached git checkout/);
    expect(text).not.toMatch(/ecc-install --target <cli>/);
    expect(text).not.toMatch(/Codex → cached git checkout/);
  });

  it("always documents the ECC ecosystem tools (consult + agentshield)", async () => {
    const text = docs((await command.plan(makeCtx())).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("npx ecc consult");
    expect(text).toContain("npx ecc-agentshield scan");
  });

  it("--cli codex uses ECC's add-only Codex merge helpers, not the destructive copy target", async () => {
    const actions = (await command.plan(makeCtx({ cli: "codex" }))).actions;
    const blob = execBlob(actions);
    expect(installTargets(actions)).not.toContain("codex");
    expect(blob).not.toContain("ecc-install --target codex");
    expect(blob).toContain("scripts/codex/merge-codex-config.js");
    expect(blob).not.toContain("scripts/codex/merge-mcp-config.js");
    expect(blob).toContain("npm ci --omit=dev --ignore-scripts");
    expect(blob).not.toContain("--package-lock=false");
    expect(blob).toContain("createManifestInstallPlan");
    expect(blob).toContain("writeInstallState");
    expect(blob.indexOf("fs.copyFileSync")).toBeLessThan(
      blob.indexOf("writeInstallState(plan.installStatePath"),
    );
    expect(blob).toContain("Invoke them on demand as `$<skill-name>`");
    expect(blob).toContain("On-demand `$<skill-name>` invocation");
    expect(blob).toContain(".codex/config.toml");
  });

  it("projects the Chrome DevTools default from Core's exact pin, never ECC's floating merge", async () => {
    const actions = (await command.plan(makeCtx({ cli: "codex" }))).actions;
    const install = execs(actions).find((action) => action.describe.includes("record prune state"));
    const mcpB64 = install?.argv.at(-2);
    if (mcpB64 === undefined) throw new Error("missing Core-owned Codex MCP payload");
    const scoped = JSON.parse(Buffer.from(mcpB64, "base64").toString("utf8")) as {
      servers: Record<string, { command: string; args: string[] }>;
    };
    const chrome = scoped.servers["chrome-devtools"];
    if (chrome === undefined) throw new Error("missing Core-owned Chrome DevTools MCP server");

    expect(chrome.command).toBe("npx");
    expect(chrome.args).toEqual(["-y", "chrome-devtools-mcp@1.7.0"]);
    expect(chrome.args.join(" ")).not.toContain("@latest");
    expect(codexInstallState(actions).codexToml.mcpServers).toContain("chrome-devtools");
  });

  it("defaults a direct non-governed Codex action to Core's exact Chrome DevTools pin", () => {
    const action = codexEccActions(
      makeCtx({ cli: "codex" }),
      { dir: tmp, posix: tmp.replace(/\\/g, "/"), explicit: true, hasCache: false },
      "minimal",
    ).find(
      (candidate): candidate is ExecAction =>
        candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
    );
    if (action === undefined) throw new Error("missing direct Codex action");
    const mcpB64 = action.argv.at(-2);
    if (mcpB64 === undefined) throw new Error("missing default Codex MCP payload");
    const rendered = Buffer.from(mcpB64, "base64").toString("utf8");

    expect(rendered).toContain("chrome-devtools-mcp@1.7.0");
    expect(rendered).not.toContain("@latest");
  });

  it.each([
    ["bare", "[mcp_servers.chrome-devtools]"],
    ["encoded basic", '[mcp_servers."chrome\\u002ddevtools"]'],
  ])(
    "does not claim an operator-owned %s Chrome DevTools server while retaining the Core projection",
    async (_spelling, header) => {
      const home = join(tmp, "operator-home");
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "config.toml"),
        `${header}\ncommand = "operator-devtools"\nargs = ["--local"]\n`,
      );
      const base = makeCtx({ cli: "codex" });
      const actions = (
        await command.plan({ ...base, env: { ...base.env, HOME: home, USERPROFILE: home } })
      ).actions;
      const state = codexInstallState(actions);
      const install = execs(actions).find((action) =>
        action.describe.includes("record prune state"),
      );
      const mcpB64 = install?.argv.at(-2);
      if (mcpB64 === undefined) throw new Error("missing Core-owned Codex MCP payload");

      expect(state.codexToml.mcpServers).not.toContain("chrome-devtools");
      expect(Buffer.from(mcpB64, "base64").toString("utf8")).toContain("chrome-devtools-mcp@1.7.0");
    },
  );

  it("--cli codex passes the requested profile into the managed Codex file install", async () => {
    const install = execs(
      (await command.plan(makeCtx({ cli: "codex", profile: "minimal" }))).actions,
    ).find((e) => e.describe.includes("record prune state"));
    expect(install?.argv).toContain("minimal");
    expect(execBlob(install ? [install] : [])).toContain("createManifestInstallPlan");
  });

  it("--cli gemini installs via ecc-universal's ecc-install bin, not consult", async () => {
    const actions = (await command.plan(makeCtx({ cli: "gemini" }))).actions;
    expect(execs(actions)[0]?.argv).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "gemini",
      "--profile",
      "minimal",
    ]);
  });

  it("passes detected stack packs through to ECC's installer", async () => {
    put("package.json", JSON.stringify({ name: "web", dependencies: { next: "^15.0.0" } }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx({ cli: "cursor" }))).actions;
    expect(execs(actions)[0]?.argv).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "minimal",
      "typescript",
      "web",
    ]);
  });

  it("honors --profile", async () => {
    const actions = (await command.plan(makeCtx({ cli: "cursor", profile: "full" }))).actions;
    expect(execs(actions)[0]?.argv).toContain("full");
  });

  it("--cli windsurf (no ECC target) routes through the consult advisor doc", async () => {
    const text = docs((await command.plan(makeCtx({ cli: "windsurf" }))).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("npx ecc consult");
    expect(text).toContain("--target windsurf");
    // never fabricate an installer target ECC doesn't have.
    expect(execBlob((await command.plan(makeCtx({ cli: "windsurf" }))).actions)).not.toContain(
      "ecc-install --target windsurf",
    );
  });

  it("--cli kiro clones ECC (latest, shallow) to a cache, then runs .kiro/install.sh", async () => {
    const blob = execBlob((await command.plan(makeCtx({ cli: "kiro" }))).actions);
    expect(blob).toContain("git clone --depth 1 https://github.com/affaan-m/ECC.git");
    expect(blob).toContain(".kiro/install.sh");
    // kiro isn't on npm — never fabricate an ecc-install kiro target.
    expect(blob).not.toContain("ecc-install --target kiro");
  });

  it("--cli kiro --ecc-path uses the given checkout (no clone)", async () => {
    const blob = execBlob(
      (await command.plan(makeCtx({ cli: "kiro", eccPath: "/opt/ECC" }))).actions,
    );
    expect(blob).toContain("/opt/ECC/.kiro/install.sh");
    expect(blob).not.toContain("git clone");
  });

  it("--all-tools: npm targets via ecc-universal, codex/kiro via safe git checkout paths", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    expect(installTargets(actions)).toEqual(
      expect.arrayContaining(["claude", "cursor", "antigravity", "gemini", "opencode", "zed"]),
    );
    expect(installTargets(actions)).not.toContain("codex");
    expect(installTargets(actions)).not.toContain("kiro");
    expect(installTargets(actions)).not.toContain("copilot"); // not an ECC target → consult
    expect(installTargets(actions)).not.toContain("kimi"); // not an ECC target → consult
    const blob = execBlob(actions);
    expect(blob).toContain("scripts/codex/merge-codex-config.js"); // codex add-only merge path
    expect(blob).toContain(".kiro/install.sh"); // kiro native installer
    expect(blob).not.toContain("ecc-install --target codex");
    expect(blob).not.toContain("ecc-install --target kiro");
  });

  it("BOUNDARY: only doc/exec actions plus the external once-only Codex config seed", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    for (const a of actions) {
      // probe is read-only verification (this command is alwaysVerify); the boundary
      // this test guards is WRITES, constrained below.
      expect(["doc", "exec", "write", "probe"]).toContain(a.kind);
      if (a.kind === "write") {
        const write = a as WriteAction;
        expect(write.external).toBe(true);
        const path = write.path.replace(/\\/g, "/");
        expect(path).toMatch(/\/\.codex\/config\.toml$/);
        expect(write.once).toBe(true);
        expect(write.contents).toBe("");
      }
    }
    expect(execBlob(actions)).toContain("ecc-aih-install-state.json");
  });

  it("records inline Codex profile tables as existing config and tracks only added keys", async () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[profiles]\n"strict" = { "approval_policy" = "on-request" }\n',
    );
    const base = makeCtx({ cli: "codex" });
    const actions = (
      await command.plan({ ...base, env: { ...base.env, HOME: home, USERPROFILE: home } })
    ).actions;
    const state = codexInstallState(actions);
    expect(state.codexToml.tables).not.toContain("profiles.strict");
    expect(state.codexToml.tableKeys["profiles.strict"]).toEqual(["sandbox_mode", "web_search"]);
  });
});

describe("ecc.plan — Windows Git Bash resolution + npx cmd shim", () => {
  it("--cli kiro on Windows resolves bash.exe from the Git install dir (absolute argv[0], not bare 'bash')", async () => {
    // A default Git for Windows install leaves bash.exe on disk (Git\bin) but off PATH.
    const pf = join(tmp, "pf");
    const bashExe = join(pf, "Git", "bin", "bash.exe");
    mkdirSync(join(pf, "Git", "bin"), { recursive: true });
    writeFileSync(bashExe, "", "utf8");
    const actions = (await command.plan(makeWinCtx({ env: { ProgramFiles: pf } }))).actions;
    const install = execs(actions).find((e) =>
      e.argv[1]?.replace(/\\/g, "/").endsWith(".kiro/install.sh"),
    );
    expect(install).toBeDefined();
    expect(install?.argv[0]).toBe(bashExe); // absolute bash.exe, resolved off-PATH
    expect(install?.argv[0]).not.toBe("bash"); // the exit-127 bug: bare "bash"
  });

  it("--cli kiro on Windows with no Git Bash emits guidance + a git-bash-missing check (no bash exec)", async () => {
    // Point every Git-install probe dir at an empty tmp location so resolveBash finds
    // none — deterministic on any host OS (overrides a real machine's C:\Program Files\Git).
    const env: NodeJS.ProcessEnv = {
      ProgramFiles: join(tmp, "pf"),
      "ProgramFiles(x86)": join(tmp, "pf86"),
      LocalAppData: join(tmp, "lad"),
    };
    const actions = (await command.plan(makeWinCtx({ env }))).actions;
    // no exec spawns bash on install.sh — a bare `bash` would just ENOENT to exit 127
    expect(
      execs(actions).some((e) => e.argv[1]?.replace(/\\/g, "/").endsWith(".kiro/install.sh")),
    ).toBe(false);
    // the fix is named in a printed doc headline, not buried in a body summarizeResult drops
    expect(
      docs(actions)
        .map((d) => d.describe)
        .join("\n"),
    ).toContain("Git Bash");
    // a coded probe escalates the gap under --verify (routable support ticket, not a bare 127)
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(makeWinCtx({ env }))));
    const gitBash = checks.find((c) => c.code === "env.git-bash-missing");
    expect(gitBash?.verdict).toBe("fail");
  });

  it("routes the npx ECC installer through `cmd /c` on Windows (execFile can't spawn a .cmd shim)", async () => {
    const actions = (await command.plan(makeWinCtx({ options: { cli: "claude" } }))).actions;
    const installer = execs(actions)[0];
    expect(installer?.argv.slice(0, 3)).toEqual(["cmd", "/c", "npx"]);
    // the real installer argv is preserved after the shim prefix
    expect(installer?.argv).toContain("ecc-universal");
    expect(installer?.argv).toContain("ecc-install");
    expect(installer?.argv).toContain("--target");
  });

  it("rejects unsafe Windows ECC profile arguments before the npx cmd shim", async () => {
    await expect(
      command.plan(makeWinCtx({ options: { cli: "claude", profile: "core & calc" } })),
    ).rejects.toThrow(/unsafe for a Windows cmd launcher/);
  });

  it("rejects unsafe Windows ECC installer version pins before the npx cmd shim", async () => {
    await expect(
      command.plan(
        makeWinCtx({
          env: { AIH_ECC_INSTALL_VERSION: "1.2.3 & calc" },
          options: { cli: "claude" },
        }),
      ),
    ).rejects.toThrow(/exact semver/);
  });

  it("codes the Kiro install failure as git-bash-missing only on a spawn error, not a generic exit", async () => {
    const pf = join(tmp, "pf");
    mkdirSync(join(pf, "Git", "bin"), { recursive: true });
    writeFileSync(join(pf, "Git", "bin", "bash.exe"), "", "utf8");
    const actions = (await command.plan(makeWinCtx({ env: { ProgramFiles: pf } }))).actions;
    const install = execs(actions).find((e) =>
      e.argv[1]?.replace(/\\/g, "/").endsWith(".kiro/install.sh"),
    );
    const fc = install?.failureCheck;
    if (typeof fc !== "function") throw new Error("expected a failureCheck function");
    // bash could not spawn (ENOENT → 127) → the missing-Git-Bash ticket
    expect(fc({ code: 127, stdout: "", stderr: "", spawnError: true }).code).toBe(
      "env.git-bash-missing",
    );
    // install.sh ran but exited non-zero for its own reason → surfaced but NOT coded,
    // so the "install Git for Windows" self-fix guidance is never misrouted
    const generic = fc({ code: 1, stdout: "", stderr: "boom" });
    expect(generic.verdict).toBe("fail");
    expect(generic.code).toBeUndefined();
  });
});

describe("ECC supply-chain pinning (AIH-SUPPLY-001 round 2)", () => {
  it("eccInstallerArgv pins the version when given one, bare otherwise", () => {
    expect(eccInstallerArgv("claude", "core", "1.2.3")).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal@1.2.3",
      "ecc-install",
      "--target",
      "claude",
      "--profile",
      "core",
    ]);
    expect(eccInstallerArgv("claude", "core")).toContain("ecc-universal");
  });

  it("rejects mutable tags and ranges as installer pins", () => {
    expect(normalizeEccInstallVersion("1.2.3")).toBe("1.2.3");
    expect(normalizeEccInstallVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(() => normalizeEccInstallVersion("latest")).toThrow(/exact semver/);
    expect(() => normalizeEccInstallVersion("^1.2.3")).toThrow(/exact semver/);
  });

  it("emits a supply-chain advisory by default (unpinned latest)", async () => {
    const p = await command.plan(makeCtx({ cli: "claude" }));
    expect(p.actions.some((a) => a.kind === "doc" && a.describe.includes("supply chain"))).toBe(
      true,
    );
  });

  it("AIH_ECC_INSTALL_VERSION pins the installer argv and drops the advisory", async () => {
    const base = makeCtx({ cli: "claude" });
    const ctx = { ...base, env: { ...base.env, AIH_ECC_INSTALL_VERSION: "1.2.3" } };
    const p = await command.plan(ctx);
    const installer = p.actions.find((a): a is ExecAction => a.kind === "exec");
    expect(installer?.argv).toContain("ecc-universal@1.2.3");
    expect(p.actions.some((a) => a.kind === "doc" && a.describe.includes("supply chain"))).toBe(
      false,
    );
  });

  it("AIH_ECC_REF pins the Kiro git checkout (clone --branch <ref>)", async () => {
    const base = makeCtx({ cli: "kiro" });
    const ctx = { ...base, env: { ...base.env, AIH_ECC_REF: "v2.1.0" } };
    const p = await command.plan(ctx);
    const clone = p.actions.find(
      (a): a is ExecAction => a.kind === "exec" && a.argv.includes("clone"),
    );
    expect(clone?.argv).toEqual(expect.arrayContaining(["--branch", "v2.1.0"]));
  });

  it("AIH_ECC_REF pins the Codex merge-helper checkout (clone --branch <ref>)", async () => {
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, env: { ...base.env, AIH_ECC_REF: "v2.1.0" } };
    const p = await command.plan(ctx);
    const clone = p.actions.find(
      (a): a is ExecAction => a.kind === "exec" && a.argv.includes("clone"),
    );
    expect(clone?.argv).toEqual(expect.arrayContaining(["--branch", "v2.1.0"]));
    expect(execBlob(p.actions)).toContain("scripts/codex/merge-codex-config.js");
    expect(p.actions.some((a) => a.kind === "doc" && a.describe.includes("supply chain"))).toBe(
      true,
    );
  });
});

describe("ecc.plan — Codex MCP collision preflight", () => {
  async function chromeDevtoolsCollisionChecks(
    projectConfig: string | undefined,
    globalConfig: string | undefined,
  ): Promise<Action[]> {
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    if (projectConfig !== undefined) {
      writeFileSync(join(root, ".codex", "config.toml"), projectConfig);
    }
    if (globalConfig !== undefined) {
      writeFileSync(join(home, ".codex", "config.toml"), globalConfig);
    }
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, root, env: { ...base.env, HOME: home, USERPROFILE: home } };
    return (await command.plan(ctx)).actions;
  }

  async function expectChromeDevtoolsPreflightRefusal(
    projectConfig: string | undefined,
    globalConfig: string | undefined,
    transport: "unknown" | "mixed",
  ): Promise<void> {
    const actions = await chromeDevtoolsCollisionChecks(projectConfig, globalConfig);
    expect(
      execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
    ).toBe(false);
    const checks = await Promise.all(
      actions
        .filter((action): action is ProbeAction => action.kind === "probe")
        .map((action) => action.run(makeCtx())),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.config-invalid",
          detail: expect.stringMatching(new RegExp(`chrome-devtools.*${transport}`, "i")),
        }),
      ]),
    );
  }

  it("allows an existing global Context7 HTTP server that ECC no longer plans to add", async () => {
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n',
    );
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, root, env: { ...base.env, HOME: home, USERPROFILE: home } };
    const actions = (await command.plan(ctx)).actions;
    expect(execBlob(actions)).not.toContain("merge-mcp-config.js");
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mcp.config-invalid" })]),
    );
  });

  it("allows a project Context7 HTTP server while ECC adds only chrome-devtools globally", async () => {
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n',
    );
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, root, env: { ...base.env, HOME: home, USERPROFILE: home } };
    const actions = (await command.plan(ctx)).actions;
    expect(execBlob(actions)).not.toContain("merge-mcp-config.js");
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mcp.config-invalid" })]),
    );
  });

  it("refuses the Codex installer when global and project config collide on transport", async () => {
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n',
    );
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.context7]\ncommand = "npx"\nargs = ["@upstash/context7-mcp"]\n',
    );
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, root, env: { ...base.env, HOME: home, USERPROFILE: home } };
    const actions = (await command.plan(ctx)).actions;
    expect(execBlob(actions)).not.toContain("ecc-install --target codex");
    expect(
      actions.some(
        (a) =>
          a.kind === "doc" &&
          a.describe.includes("Codex MCP server name collision") &&
          a.text.includes("context7"),
      ),
    ).toBe(true);
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.config-invalid",
        }),
      ]),
    );
  });

  it("refuses Codex when the current upstream chrome-devtools default conflicts globally", async () => {
    const home = join(tmp, "home");
    const root = join(tmp, "repo");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.chrome-devtools]\nurl = "https://example.invalid/mcp"\n',
    );
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, root, env: { ...base.env, HOME: home, USERPROFILE: home } };
    const actions = (await command.plan(ctx)).actions;
    expect(execBlob(actions)).not.toContain("merge-mcp-config.js");
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.config-invalid",
        }),
      ]),
    );
  });

  it.each(["project", "global"] as const)(
    "detects an encoded Chrome DevTools root collision in %s config",
    async (scope) => {
      const encoded =
        '[mcp_servers."chrome\\u002ddevtools"]\nurl = "https://example.invalid/mcp"\n';
      const actions = await chromeDevtoolsCollisionChecks(
        scope === "project" ? encoded : undefined,
        scope === "global" ? encoded : undefined,
      );

      expect(
        execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
      ).toBe(false);
      const checks = await Promise.all(
        actions
          .filter((action): action is ProbeAction => action.kind === "probe")
          .map((action) => action.run(makeCtx())),
      );
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            verdict: "fail",
            code: "mcp.config-invalid",
            detail: expect.stringMatching(/chrome-devtools.*http/i),
          }),
        ]),
      );
    },
  );

  it("fails closed for duplicate semantic Chrome DevTools roots with mixed transports", async () => {
    await expectChromeDevtoolsPreflightRefusal(
      [
        "[mcp_servers.chrome-devtools]",
        'command = "npx"',
        '[mcp_servers."chrome\\u002ddevtools"]',
        'url = "https://example.invalid/mcp"',
        "",
      ].join("\n"),
      undefined,
      "mixed",
    );
  });

  it("fails closed for duplicate semantic Chrome DevTools roots with equal transports", async () => {
    const duplicate = [
      "[mcp_servers.chrome-devtools]",
      'command = "npx"',
      '[mcp_servers."chrome\\u002ddevtools"]',
      'command = "npx"',
      "",
    ].join("\n");
    const actions = await chromeDevtoolsCollisionChecks(duplicate, undefined);

    expect(
      execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
    ).toBe(false);
    const checks = await Promise.all(
      actions
        .filter((action): action is ProbeAction => action.kind === "probe")
        .map((action) => action.run(makeCtx())),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.config-invalid",
          detail: expect.stringMatching(/chrome-devtools.*duplicate/i),
        }),
      ]),
    );
  });

  it("fails closed for an array-of-tables Chrome DevTools root", async () => {
    const actions = await chromeDevtoolsCollisionChecks(
      '[[mcp_servers."chrome-devtools"]]\ncommand = "npx"\n',
      undefined,
    );

    expect(
      execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
    ).toBe(false);
    const checks = await Promise.all(
      actions
        .filter((action): action is ProbeAction => action.kind === "probe")
        .map((action) => action.run(makeCtx())),
    );
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.config-invalid",
          detail: expect.stringMatching(/chrome-devtools.*array/i),
        }),
      ]),
    );
  });

  it.each([
    ["descendant table", '[mcp_servers."chrome-devtools".env]\ntoken = "operator"\n'],
    ["encoded descendant table", '[mcp_servers."chrome\\u002ddevtools".env]\ntoken = "operator"\n'],
    ["top-level dotted assignment", 'mcp_servers.chrome-devtools.command = "operator-devtools"\n'],
    [
      "top-level inline table",
      'mcp_servers = { chrome-devtools = { command = "operator-devtools" } }\n',
    ],
    [
      "mcp_servers table dotted assignment",
      '[mcp_servers]\nchrome-devtools.command = "operator-devtools"\n',
    ],
  ])(
    "fails closed for an operator-owned non-root Chrome representation: %s",
    async (_kind, config) => {
      const actions = await chromeDevtoolsCollisionChecks(config, undefined);

      expect(
        execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
      ).toBe(false);
      const checks = await Promise.all(
        actions
          .filter((action): action is ProbeAction => action.kind === "probe")
          .map((action) => action.run(makeCtx())),
      );
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            verdict: "fail",
            code: "mcp.config-invalid",
            detail: expect.stringMatching(/chrome-devtools.*non-root/i),
          }),
        ]),
      );
    },
  );

  it.each([
    ["project", "[mcp_servers.chrome-devtools]\nenabled = true\n", undefined],
    ["global", undefined, "[mcp_servers.chrome-devtools]\nenabled = true\n"],
  ])(
    "fails closed for an %s Chrome DevTools transport it cannot classify",
    async (_scope, project, global) => {
      await expectChromeDevtoolsPreflightRefusal(project, global, "unknown");
    },
  );

  it("fails closed when project and global Chrome DevTools definitions are both mixed", async () => {
    const mixed =
      '[mcp_servers.chrome-devtools]\ncommand = "npx"\nurl = "https://example.invalid/mcp"\n';
    await expectChromeDevtoolsPreflightRefusal(mixed, mixed, "mixed");
  });

  it("allows unrelated unknown project/global definitions while preserving known collision checks", async () => {
    const actions = await chromeDevtoolsCollisionChecks(
      "[mcp_servers.foo]\nenabled = false\n",
      '[mcp_servers.foo]\ncommand = "operator-foo"\n',
    );
    expect(
      execs(actions).some((action) => action.describe.startsWith("Install ECC for Codex")),
    ).toBe(true);
  });
});

describe("Codex MCP removal custody", () => {
  const chromeFootprint = {
    rootKeys: [],
    tables: [],
    tableKeys: {},
    mcpServers: ["chrome-devtools"],
  };

  it.each([
    [
      "absent managed fence",
      '[mcp_servers."chrome-devtools"]\ncommand = "operator-devtools"\nargs = ["--adopted"]\n',
    ],
    [
      "malformed managed fence",
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."chrome-devtools"]',
        'command = "operator-devtools"',
        "",
      ].join("\n"),
    ],
    [
      "managed fence with an unrecognized table",
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."chrome-devtools"]',
        'command = "operator-devtools"',
        "[unexpected]",
        "value = true",
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
    ],
  ])("preserves an operator-adopted Chrome DevTools table after an %s", (_case, config) => {
    expect(stripCodexTomlFootprint(config, chromeFootprint)).toBe(config);
  });

  it("removes only a state-claimed Chrome DevTools table from a valid managed fence", () => {
    const config = [
      '[mcp_servers."operator"]',
      'command = "operator-devtools"',
      "",
      "# >>> aih managed (mcp) >>>",
      '[mcp_servers."chrome-devtools"]',
      'command = "npx"',
      'args = ["-y", "chrome-devtools-mcp@1.7.0"]',
      "# <<< aih managed (mcp) <<<",
      "",
    ].join("\n");

    expect(stripCodexTomlFootprint(config, chromeFootprint)).toBe(
      '[mcp_servers."operator"]\ncommand = "operator-devtools"\n',
    );
  });
});

describe("Codex managed destination safety", () => {
  function prepareCodexRepo(home: string): void {
    const repo = join(tmp, "ecc");
    const putRepo = (relative: string, contents: string) => {
      const target = join(repo, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents);
    };
    putRepo("scripts/codex/merge-codex-config.js", "");
    putRepo("scripts/codex/merge-mcp-config.js", "");
    putRepo(
      "scripts/lib/install-executor.js",
      `exports.createManifestInstallPlan = () => ({ operations: [], statePreview: { operations: [] }, installStatePath: ${JSON.stringify(
        join(home, ".codex", "ecc-install-state.json"),
      )} });`,
    );
    putRepo(
      "scripts/lib/install-state.js",
      'exports.writeInstallState = () => { throw new Error("unsafe writeInstallState reached"); };',
    );
    putRepo(
      ".codex/AGENTS.md",
      [
        "## Skills Discovery",
        "",
        "Available skills:",
        "- tdd-workflow",
        "",
        "## MCP Servers",
        "",
        "none",
        "",
        "## External Action Boundaries",
      ].join("\n"),
    );
  }

  function guardedMerge(configPath: string): ReturnType<typeof spawnSync> {
    const home = join(tmp, "home");
    const repo = join(tmp, "ecc");
    // The home-alias case makes `home` a directory symlink, and on Windows a
    // recursive mkdir whose path traverses one fails ENOENT. Resolve the link
    // first and create under the real target — still visible through the alias,
    // so the alias semantics under test are unchanged.
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
    mkdirSync(join(realpathSync(home), ".codex"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    const base = makeCtx({ cli: "codex" });
    const ctx = {
      ...base,
      env: { ...base.env, HOME: home, USERPROFILE: home },
    };
    const action = codexEccActions(
      ctx,
      { dir: repo, posix: repo.replace(/\\/g, "/"), explicit: true, hasCache: false },
      "minimal",
    ).find(
      (candidate): candidate is ExecAction =>
        candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
    );
    if (action === undefined) throw new Error("missing Codex merge action");
    expect(action.argv).toContain(configPath);
    return spawnSync(process.execPath, action.argv.slice(1), {
      cwd: repo,
      encoding: "utf8",
    });
  }

  it.each([
    ["before", "npx", '["chrome-devtools-mcp@latest"]'],
    ["after", "npx", '["chrome-devtools-mcp@latest"]'],
    ["inside", "npx", '["chrome-devtools-mcp@latest"]'],
    ["vanished", "npx", '["chrome-devtools-mcp@latest"]'],
    ["before", "bunx", '["chrome-devtools-mcp@latest"]'],
    ["before", "pnpm", '["dlx", "chrome-devtools-mcp@latest"]'],
    ["before", "yarn", '["dlx", "chrome-devtools-mcp@latest"]'],
    ["descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["single-quoted-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["single-quoted-child-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["double-quoted-child-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["escaped-basic-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["escaped-basic-prefix-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["spaced-quoted-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["array-descendant", "npx", '["chrome-devtools-mcp@latest"]'],
    ["duplicate-semantic-root", "npx", '["chrome-devtools-mcp@latest"]'],
    ["array-root", "npx", '["chrome-devtools-mcp@latest"]'],
    ["encoded-operator-root", "npx", '["chrome-devtools-mcp@latest"]'],
    ["managed-failure", "npx", '["chrome-devtools-mcp@latest"]'],
    ["live-relinquished", "npx", '["chrome-devtools-mcp@latest"]'],
    ["agents-failure", "npx", '["chrome-devtools-mcp@latest"]'],
    ["live-config-takeover", "npx", '["chrome-devtools-mcp@latest"]'],
    ["live-config-race", "npx", '["chrome-devtools-mcp@latest"]'],
    ["live-state-race", "npx", '["chrome-devtools-mcp@latest"]'],
    ["temp-cleanup", "npx", '["chrome-devtools-mcp@latest"]'],
  ] as const)(
    "writes Core's exact Chrome DevTools pin for a claimed mutable table %s the managed fence",
    (legacyPosition, command, args) => {
      const home = join(tmp, "home");
      const repo = join(tmp, "ecc");
      const aihStatePath = join(home, ".codex", "ecc-aih-install-state.json");
      const managedStateSentinel = join(repo, "managed-state-sentinel.txt");
      mkdirSync(join(home, ".codex"), { recursive: true });
      const putRepo = (relative: string, contents: string) => {
        const target = join(repo, relative);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, contents, "utf8");
      };
      const baselineFailure =
        legacyPosition === "managed-failure" || legacyPosition === "agents-failure";
      const mergeBaseline = [
        'var fs = require("node:fs");',
        "const config = process.argv[2];",
        'const raw = fs.readFileSync(config, "utf8");',
        "const additions = [];",
        "if (!/^[ \\t]*approval_policy\\s*=/m.test(raw)) additions.push('approval_policy = \"on-request\"\\n');",
        "if (!/^[ \\t]*sandbox_mode\\s*=/m.test(raw)) additions.push('sandbox_mode = \"workspace-write\"\\n');",
        'if (additions.length > 0) fs.writeFileSync(config, additions.join("") + raw);',
      ].join(" ");
      const racedState = `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "aih",
          codexToml: {
            rootKeys: ["notify"],
            tables: [],
            tableKeys: {},
            mcpServers: ["chrome-devtools"],
          },
          agentsBlock: true,
        },
        null,
        2,
      )}\n`;
      putRepo(
        "scripts/codex/merge-codex-config.js",
        legacyPosition === "live-config-race"
          ? `var fs = require("node:fs"); const live = ${JSON.stringify(join(home, ".codex", "config.toml"))}; fs.writeFileSync(live, 'sandbox_mode = "operator"\\n' + fs.readFileSync(live, "utf8")); ${mergeBaseline}`
          : legacyPosition === "live-state-race"
            ? `require("node:fs").writeFileSync(${JSON.stringify(aihStatePath)}, ${JSON.stringify(racedState)}); ${mergeBaseline}`
            : legacyPosition === "temp-cleanup"
              ? `require("node:fs").writeFileSync(${JSON.stringify(join(repo, "merge-path.txt"))}, process.argv[2]); ${mergeBaseline}`
              : baselineFailure
                ? `const fs = require("node:fs"); const config = process.argv[2]; fs.writeFileSync(config, ${JSON.stringify('approval_policy = "on-request"\n')} + fs.readFileSync(config, "utf8"));`
                : mergeBaseline,
      );
      putRepo("scripts/codex/merge-mcp-config.js", 'throw new Error("vendor MCP merge ran");\n');
      putRepo(
        "scripts/lib/install-executor.js",
        `exports.createManifestInstallPlan = () => ({ operations: [], statePreview: { operations: [] }, installStatePath: ${JSON.stringify(
          join(home, ".codex", "ecc-install-state.json"),
        )} });`,
      );
      putRepo(
        "scripts/lib/install-state.js",
        legacyPosition === "managed-failure"
          ? `exports.writeInstallState = () => { require("node:fs").writeFileSync(${JSON.stringify(managedStateSentinel)}, "reached", "utf8"); throw new Error("intentional managed state failure"); };\n`
          : legacyPosition === "agents-failure"
            ? `exports.writeInstallState = (path, state) => { const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(managedStateSentinel)}, "reached", "utf8"); fs.writeFileSync(path, JSON.stringify(state), "utf8"); };\n`
            : 'exports.writeInstallState = (path, state) => require("node:fs").writeFileSync(path, JSON.stringify(state), "utf8");\n',
      );
      putRepo(
        ".codex/AGENTS.md",
        [
          "## Skills Discovery",
          "",
          "Available skills:",
          "",
          "## MCP Servers",
          "",
          "## External Action Boundaries",
        ].join("\n"),
      );
      const base = makeCtx({ cli: "codex" });
      const ctx = { ...base, env: { ...base.env, HOME: home, USERPROFILE: home } };
      const legacy = [
        '[mcp_servers."chrome-devtools"]',
        `command = "${command}"`,
        `args = ${args}`,
        "startup_timeout_sec = 30",
      ];
      const descendantHeader =
        legacyPosition === "descendant"
          ? '  [mcp_servers."chrome-devtools".env]'
          : legacyPosition === "single-quoted-descendant"
            ? "[mcp_servers.'chrome-devtools'.env]"
            : legacyPosition === "single-quoted-child-descendant"
              ? "[mcp_servers.'chrome-devtools'.'env']"
              : legacyPosition === "double-quoted-child-descendant"
                ? '[mcp_servers."chrome-devtools"."env"]'
                : legacyPosition === "escaped-basic-descendant"
                  ? '[mcp_servers."chrome\\u002ddevtools".env]'
                  : legacyPosition === "escaped-basic-prefix-descendant"
                    ? '["mcp\\u005fservers"."chrome\\u002ddevtools".env]'
                    : legacyPosition === "spaced-quoted-descendant"
                      ? "['mcp_servers' . \"chrome-devtools\" . env]"
                      : legacyPosition === "array-descendant"
                        ? '[[mcp_servers."chrome-devtools".env]]'
                        : undefined;
      const duplicateSemanticRootHeader =
        legacyPosition === "duplicate-semantic-root"
          ? '[mcp_servers."chrome\\u002ddevtools"]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest"]\nstartup_timeout_sec = 30'
          : undefined;
      const arrayRootHeader =
        legacyPosition === "array-root"
          ? '[[mcp_servers."chrome-devtools"]]\ncommand = "npx"\nargs = ["chrome-devtools-mcp@latest"]\nstartup_timeout_sec = 30'
          : undefined;
      const encodedOperatorRootHeader =
        legacyPosition === "encoded-operator-root"
          ? '[mcp_servers."chrome\\u002ddevtools"]\ncommand = "operator-devtools"\nargs = ["--local"]'
          : undefined;
      const fence = [
        "# >>> aih managed (mcp) >>>",
        ...(legacyPosition === "inside" ? legacy : []),
        ...(legacyPosition === "inside" ? [""] : []),
        '[mcp_servers."sequential-thinking"]',
        'command = "npx"',
        "# <<< aih managed (mcp) <<<",
      ];
      writeFileSync(
        join(home, ".codex", "config.toml"),
        (arrayRootHeader !== undefined
          ? [arrayRootHeader, 'token = "operator"', ""]
          : encodedOperatorRootHeader !== undefined
            ? [encodedOperatorRootHeader, 'token = "operator"', ""]
            : descendantHeader !== undefined || duplicateSemanticRootHeader !== undefined
              ? [
                  ...legacy,
                  ...(descendantHeader !== undefined ? [descendantHeader] : []),
                  ...(duplicateSemanticRootHeader !== undefined
                    ? [duplicateSemanticRootHeader]
                    : []),
                  'token = "operator"',
                  "",
                ]
              : legacyPosition === "managed-failure" ||
                  legacyPosition === "live-relinquished" ||
                  legacyPosition === "agents-failure" ||
                  legacyPosition === "live-config-takeover" ||
                  legacyPosition === "live-config-race" ||
                  legacyPosition === "live-state-race" ||
                  legacyPosition === "temp-cleanup"
                ? [
                    ...(legacyPosition === "live-relinquished"
                      ? ['approval_policy = "operator"', ""]
                      : []),
                    ...legacy,
                    "",
                  ]
                : legacyPosition === "inside" || legacyPosition === "vanished"
                  ? [...fence, ""]
                  : [
                      ...(legacyPosition === "before" ? legacy : fence),
                      "",
                      ...(legacyPosition === "before" ? fence : legacy),
                      "",
                    ]
        ).join("\n"),
        "utf8",
      );
      writeFileSync(
        join(home, ".codex", "ecc-aih-install-state.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            managedBy: "aih",
            codexToml: {
              rootKeys: legacyPosition === "live-relinquished" ? ["approval_policy"] : [],
              tables: [],
              tableKeys: {},
              mcpServers:
                legacyPosition === "vanished"
                  ? ["sequential-thinking"]
                  : arrayRootHeader !== undefined
                    ? []
                    : encodedOperatorRootHeader !== undefined
                      ? []
                      : descendantHeader !== undefined ||
                          duplicateSemanticRootHeader !== undefined ||
                          legacyPosition === "managed-failure" ||
                          legacyPosition === "live-relinquished" ||
                          legacyPosition === "agents-failure" ||
                          legacyPosition === "live-config-takeover" ||
                          legacyPosition === "live-config-race" ||
                          legacyPosition === "live-state-race" ||
                          legacyPosition === "temp-cleanup"
                        ? ["chrome-devtools"]
                        : ["chrome-devtools", "sequential-thinking"],
            },
            agentsBlock: true,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const action = codexEccActions(
        ctx,
        { dir: repo, posix: repo.replace(/\\/g, "/"), explicit: true, hasCache: false },
        "minimal",
        undefined,
        legacyPosition === "encoded-operator-root"
          ? {
              ...coreOwnedEccCodexMcpServers(),
              "sequential-thinking": {
                type: "stdio",
                command: "npx",
                args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.7.1"],
              },
            }
          : coreOwnedEccCodexMcpServers(),
      ).find(
        (candidate): candidate is ExecAction =>
          candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
      );
      if (action === undefined) throw new Error("missing Codex merge action");
      const plannedStateB64 = action.argv.at(-1);
      if (plannedStateB64 === undefined) throw new Error("missing Codex AIH state");
      expect(
        (
          JSON.parse(Buffer.from(plannedStateB64, "base64").toString("utf8")) as {
            codexToml: { mcpServers: string[] };
          }
        ).codexToml.mcpServers,
      ).toEqual(
        expect.arrayContaining(
          legacyPosition === "vanished"
            ? ["sequential-thinking"]
            : legacyPosition === "array-root"
              ? []
              : legacyPosition === "encoded-operator-root"
                ? ["sequential-thinking"]
                : descendantHeader !== undefined ||
                    duplicateSemanticRootHeader !== undefined ||
                    arrayRootHeader !== undefined ||
                    legacyPosition === "managed-failure" ||
                    legacyPosition === "live-relinquished" ||
                    legacyPosition === "agents-failure" ||
                    legacyPosition === "live-config-takeover" ||
                    legacyPosition === "live-config-race" ||
                    legacyPosition === "live-state-race" ||
                    legacyPosition === "temp-cleanup"
                  ? ["chrome-devtools"]
                  : ["chrome-devtools", "sequential-thinking"],
        ),
      );

      if (legacyPosition === "vanished") {
        rmSync(join(home, ".codex", "config.toml"));
        rmSync(join(home, ".codex", "ecc-aih-install-state.json"));
      }

      if (legacyPosition === "live-relinquished") {
        writeFileSync(
          join(home, ".codex", "ecc-aih-install-state.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            managedBy: "aih",
            codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: ["chrome-devtools"] },
            agentsBlock: true,
          })}\n`,
          "utf8",
        );
      }

      if (legacyPosition === "agents-failure")
        mkdirSync(join(home, ".codex", "AGENTS.md"), { recursive: true });

      if (legacyPosition === "live-config-takeover") {
        const configPath = join(home, ".codex", "config.toml");
        writeFileSync(configPath, `sandbox_mode = "operator"\n${readFileSync(configPath, "utf8")}`);
      }

      const configBeforeApply =
        descendantHeader !== undefined ||
        duplicateSemanticRootHeader !== undefined ||
        arrayRootHeader !== undefined ||
        legacyPosition === "managed-failure" ||
        legacyPosition === "agents-failure" ||
        legacyPosition === "live-state-race"
          ? readFileSync(join(home, ".codex", "config.toml"), "utf8")
          : undefined;
      const stateBeforeApply =
        descendantHeader !== undefined ||
        duplicateSemanticRootHeader !== undefined ||
        arrayRootHeader !== undefined ||
        legacyPosition === "managed-failure" ||
        legacyPosition === "agents-failure" ||
        legacyPosition === "live-config-race"
          ? readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")
          : undefined;

      const result = spawnSync(process.execPath, action.argv.slice(1), {
        cwd: repo,
        encoding: "utf8",
      });

      if (
        descendantHeader !== undefined ||
        duplicateSemanticRootHeader !== undefined ||
        arrayRootHeader !== undefined
      ) {
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(configBeforeApply);
        expect(readFileSync(aihStatePath, "utf8")).toBe(stateBeforeApply);
        if (descendantHeader !== undefined)
          expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
            descendantHeader,
          );
        if (duplicateSemanticRootHeader !== undefined)
          expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
            duplicateSemanticRootHeader,
          );
        if (arrayRootHeader !== undefined)
          expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
            arrayRootHeader,
          );
        expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
        return;
      }

      if (legacyPosition === "managed-failure") {
        expect(result.status).not.toBe(0);
        expect(readFileSync(managedStateSentinel, "utf8")).toBe("reached");
        expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(configBeforeApply);
        expect(readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")).toBe(
          stateBeforeApply,
        );
        expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
        return;
      }

      if (legacyPosition === "agents-failure") {
        expect(result.status).not.toBe(0);
        expect(readFileSync(managedStateSentinel, "utf8")).toBe("reached");
        expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(configBeforeApply);
        expect(readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")).toBe(
          stateBeforeApply,
        );
        return;
      }

      if (legacyPosition === "live-config-race") {
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
          'sandbox_mode = "operator"',
        );
        expect(readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")).toBe(
          stateBeforeApply,
        );
        return;
      }

      if (legacyPosition === "live-state-race") {
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(configBeforeApply);
        expect(readFileSync(aihStatePath, "utf8")).toBe(racedState);
        expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
        return;
      }

      expect(result.status, result.stderr).toBe(0);
      const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
      if (encodedOperatorRootHeader !== undefined) {
        expect(config).toContain(encodedOperatorRootHeader);
        expect(config).not.toContain("chrome-devtools-mcp@1.7.0");
        expect(config).toContain("@modelcontextprotocol/server-sequential-thinking@2025.7.1");
        expect(config.match(/mcp_servers\..*chrome/gi)).toHaveLength(1);
        const outputState = JSON.parse(
          readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8"),
        ) as { codexToml: { mcpServers: string[] } };
        expect(outputState.codexToml.mcpServers).not.toContain("chrome-devtools");
        expect(outputState.codexToml.mcpServers).toContain("sequential-thinking");
        return;
      }
      expect(config).toContain("chrome-devtools-mcp@1.7.0");
      expect(config).toContain("startup_timeout_sec = 30");
      expect(config).not.toContain("@latest");
      if (
        legacyPosition === "vanished" ||
        legacyPosition === "live-relinquished" ||
        legacyPosition === "live-config-takeover" ||
        legacyPosition === "temp-cleanup"
      )
        expect(config).not.toContain('[mcp_servers."sequential-thinking"]');
      else expect(config).toContain('[mcp_servers."sequential-thinking"]');
      expect(config.match(/# >>> aih managed \(mcp\) >>>/g)).toHaveLength(1);
      expect(readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")).toContain(
        '"chrome-devtools"',
      );
      const outputState = readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8");
      const outputRootKeys = (
        JSON.parse(outputState) as {
          codexToml: { rootKeys: string[] };
        }
      ).codexToml.rootKeys;
      if (legacyPosition === "live-relinquished") {
        expect(outputRootKeys).not.toContain("approval_policy");
        expect(outputRootKeys).toContain("sandbox_mode");
      } else if (legacyPosition === "live-config-takeover") {
        expect(outputRootKeys).toContain("approval_policy");
        expect(outputRootKeys).not.toContain("sandbox_mode");
      } else expect(outputRootKeys).toContain("approval_policy");
      if (legacyPosition === "temp-cleanup") {
        const mergedPath = readFileSync(join(repo, "merge-path.txt"), "utf8");
        expect(mergedPath).toMatch(/\.aih-codex-[^\\/]+[\\/]config\.toml$/);
        expect(
          readdirSync(join(home, ".codex")).filter((entry) => entry.startsWith(".aih-codex-")),
        ).toEqual([]);
      }
      const agents = readFileSync(join(home, ".codex", "AGENTS.md"), "utf8");
      if (
        legacyPosition === "vanished" ||
        legacyPosition === "live-relinquished" ||
        legacyPosition === "live-config-takeover" ||
        legacyPosition === "temp-cleanup"
      ) {
        expect(outputState).not.toContain("sequential-thinking");
        expect(agents).not.toContain("`sequential-thinking`");
      } else expect(agents).toContain("`sequential-thinking`");
    },
  );

  it("keeps the default scoped candidate config and state unchanged when managed files fail", () => {
    const home = join(tmp, "direct-candidate-home");
    const repo = join(tmp, "ecc");
    mkdirSync(join(home, ".codex"), { recursive: true });
    prepareCodexRepo(home);
    writeFileSync(
      join(repo, "scripts", "codex", "merge-codex-config.js"),
      [
        'const fs = require("node:fs");',
        "const config = process.argv[2];",
        'const raw = fs.readFileSync(config, "utf8");',
        "fs.writeFileSync(config, 'approval_policy = \"on-request\"\\n' + raw);",
      ].join(" "),
    );
    writeFileSync(
      join(repo, "scripts", "codex", "merge-mcp-config.js"),
      'throw new Error("vendor MCP merge must not run");\n',
    );
    const configPath = join(home, ".codex", "config.toml");
    const statePath = join(home, ".codex", "ecc-aih-install-state.json");
    writeFileSync(configPath, 'sandbox_mode = "operator"\n', "utf8");
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: [] },
        agentsBlock: true,
      })}\n`,
      "utf8",
    );
    const beforeConfig = readFileSync(configPath, "utf8");
    const beforeState = readFileSync(statePath, "utf8");
    const base = makeCtx({ cli: "codex" });
    const action = codexEccActions(
      { ...base, env: { ...base.env, HOME: home, USERPROFILE: home } },
      { dir: repo, posix: repo.replace(/\\\\/g, "/"), explicit: true, hasCache: false },
      "minimal",
    ).find(
      (candidate): candidate is ExecAction =>
        candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
    );
    if (action === undefined) throw new Error("missing default scoped Codex merge action");

    const result = spawnSync(process.execPath, action.argv.slice(1), {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig);
    expect(readFileSync(statePath, "utf8")).toBe(beforeState);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
  });

  it.each([
    ["stale claim", ["chrome-devtools", "sequential-thinking"]],
    ["duplicate claim", ["sequential-thinking", "sequential-thinking"]],
    ["hostile claim", ["sequential-thinking", "bad\n[mcp_servers.evil]"]],
  ])("refuses a %s in live Codex MCP state before effects", (_case, mcpServers) => {
    const home = join(tmp, `state-${_case.replace(/\W+/g, "-")}`);
    const repo = join(tmp, `ecc-${_case.replace(/\W+/g, "-")}`);
    mkdirSync(join(home, ".codex"), { recursive: true });
    const putRepo = (relative: string, contents: string) => {
      const target = join(repo, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, contents, "utf8");
    };
    putRepo("scripts/codex/merge-codex-config.js", "process.exit(0);\n");
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."sequential-thinking"]',
        'command = "npx"',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, ".codex", "ecc-aih-install-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers },
        agentsBlock: true,
      }),
    );
    const base = makeCtx({ cli: "codex" });
    const ctx = { ...base, env: { ...base.env, HOME: home, USERPROFILE: home } };
    const action = codexEccActions(
      ctx,
      { dir: repo, posix: repo.replace(/\\/g, "/"), explicit: true, hasCache: false },
      "minimal",
      undefined,
      coreOwnedEccCodexMcpServers(),
    ).find(
      (candidate): candidate is ExecAction =>
        candidate.kind === "exec" && candidate.describe.startsWith("Install ECC for Codex"),
    );
    if (action === undefined) throw new Error("missing Codex merge action");
    const before = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const result = spawnSync(process.execPath, action.argv.slice(1), {
      cwd: repo,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before);
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("keeps AIH state when prune cannot safely remove a claimed pre-fence Chrome table", () => {
    const home = join(tmp, "legacy-prune-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        'approval_policy = "on-request"',
        "",
        "[mcp_servers.chrome-devtools]",
        'command = "npx"',
        'args = ["chrome-devtools-mcp@latest"]',
        "startup_timeout_sec = 30",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, ".codex", "ecc-aih-install-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: {
          rootKeys: ["approval_policy"],
          tables: [],
          tableKeys: {},
          mcpServers: ["chrome-devtools"],
        },
        agentsBlock: true,
      }),
    );
    const base = makeCtx({ cli: "codex" });
    const action = codexInstallStateCleanupAction({
      ...base,
      env: { ...base.env, HOME: home, USERPROFILE: home },
    });
    expect(action?.kind).toBe("exec");
    if (action?.kind !== "exec") throw new Error("missing held-custody Codex cleanup action");
    expect(action.describe).toContain("custody remains");
    const executable = action.argv[0];
    if (executable === undefined) throw new Error("missing held-custody Codex cleanup executable");
    const result = spawnSync(executable, action.argv.slice(1), { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing AIH state cleanup");
    expect(existsSync(join(home, ".codex", "ecc-aih-install-state.json"))).toBe(true);
  });

  it("keeps AIH state when cleanup reobserves an encoded claimed Chrome root", () => {
    const home = join(tmp, "encoded-legacy-prune-home");
    const statePath = join(home, ".codex", "ecc-aih-install-state.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        '[mcp_servers."chrome\\u002ddevtools"]',
        'command = "operator-devtools"',
        'args = ["--local"]',
        "",
      ].join("\n"),
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: ["chrome-devtools"] },
        agentsBlock: true,
      }),
    );
    const base = makeCtx({ cli: "codex" });
    const action = codexInstallStateCleanupAction({
      ...base,
      env: { ...base.env, HOME: home, USERPROFILE: home },
    });
    expect(action?.kind).toBe("exec");
    if (action?.kind !== "exec") throw new Error("missing encoded-custody Codex cleanup action");
    expect(action.describe).toContain("custody remains");
    const executable = action.argv[0];
    if (executable === undefined)
      throw new Error("missing encoded-custody Codex cleanup executable");

    const result = spawnSync(executable, action.argv.slice(1), { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing AIH state cleanup");
    expect(existsSync(statePath)).toBe(true);
  });

  it("reobserves the live Codex config before a planned state cleanup", () => {
    const home = join(tmp, "prune-reobserve-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const statePath = join(home, ".codex", "ecc-aih-install-state.json");
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."chrome-devtools"]',
        'command = "npx"',
        'args = ["-y", "chrome-devtools-mcp@1.7.0"]',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: ["chrome-devtools"] },
        agentsBlock: true,
      }),
    );
    const base = makeCtx({ cli: "codex" });
    const action = codexInstallStateCleanupAction({
      ...base,
      env: { ...base.env, HOME: home, USERPROFILE: home },
    });
    expect(action?.kind).toBe("exec");
    if (action?.kind !== "exec") throw new Error("missing Codex state cleanup action");
    const executable = action.argv[0];
    if (executable === undefined) throw new Error("missing Codex state cleanup executable");
    const result = spawnSync(executable, action.argv.slice(1), { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing AIH state cleanup");
    expect(existsSync(statePath)).toBe(true);
  });

  it("keeps AIH state when an encoded claimed Chrome root appears after cleanup planning", () => {
    const home = join(tmp, "encoded-prune-reobserve-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    const configPath = join(home, ".codex", "config.toml");
    const statePath = join(home, ".codex", "ecc-aih-install-state.json");
    writeFileSync(
      configPath,
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."chrome-devtools"]',
        'command = "npx"',
        'args = ["-y", "chrome-devtools-mcp@1.7.0"]',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        managedBy: "aih",
        codexToml: { rootKeys: [], tables: [], tableKeys: {}, mcpServers: ["chrome-devtools"] },
        agentsBlock: true,
      }),
    );
    const base = makeCtx({ cli: "codex" });
    const action = codexInstallStateCleanupAction({
      ...base,
      env: { ...base.env, HOME: home, USERPROFILE: home },
    });
    expect(action?.kind).toBe("exec");
    if (action?.kind !== "exec") throw new Error("missing Codex state cleanup action");
    writeFileSync(
      configPath,
      '[mcp_servers."chrome\\u002ddevtools"]\ncommand = "operator-devtools"\n',
    );
    const executable = action.argv[0];
    if (executable === undefined) throw new Error("missing Codex state cleanup executable");

    const result = spawnSync(executable, action.argv.slice(1), { encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing AIH state cleanup");
    expect(existsSync(statePath)).toBe(true);
  });

  it.skipIf(!symlinksAvailable).each(["existing", "dangling"] as const)(
    "rejects an %s destination symlink before following it",
    (kind) => {
      const home = join(tmp, "home");
      const config = join(home, ".codex", "config.toml");
      const outside = join(tmp, "outside", "target.toml");
      mkdirSync(join(outside, ".."), { recursive: true });
      mkdirSync(join(config, ".."), { recursive: true });
      if (kind === "existing") writeFileSync(outside, "outside-before\n");
      symlinkSync(outside, config);

      const result = guardedMerge(config);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /unsafe (?:existing Codex destination|live Codex file)/,
      );
      if (kind === "existing") expect(readFileSync(outside, "utf8")).toBe("outside-before\n");
      else expect(existsSync(outside)).toBe(false);
    },
  );

  it("rejects a hard-linked managed destination before truncating its peer", () => {
    const home = join(tmp, "home");
    const config = join(home, ".codex", "config.toml");
    const outside = join(tmp, "outside.toml");
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(outside, "outside-before\n");
    linkSync(outside, config);

    const result = guardedMerge(config);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /unsafe (?:existing Codex destination|live Codex file)/,
    );
    expect(readFileSync(outside, "utf8")).toBe("outside-before\n");
  });

  it.skipIf(!symlinksAvailable)("rejects a symlinked managed destination ancestor", () => {
    const home = join(tmp, "home");
    const outside = join(tmp, "outside-codex");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(home, ".codex"), "dir");
    const config = join(home, ".codex", "config.toml");

    const result = guardedMerge(config);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unsafe Codex destination directory/);
    expect(existsSync(join(outside, "config.toml"))).toBe(false);
  });

  it.skipIf(!symlinksAvailable)(
    "accepts a declared home alias while retaining canonical destination checks",
    () => {
      const realHome = join(tmp, "real-home");
      const aliasHome = join(tmp, "home");
      mkdirSync(realHome, { recursive: true });
      symlinkSync(realHome, aliasHome, "dir");
      prepareCodexRepo(aliasHome);

      const result = guardedMerge(join(aliasHome, ".codex", "config.toml"));

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/unsafe writeInstallState reached/);
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/outside trusted home/);
    },
  );

  const assertRejectedManagedUpstreamInstallState = (kind: "symlink" | "hardlink") => {
    const home = join(tmp, "home");
    const statePath = join(home, ".codex", "ecc-install-state.json");
    const outside = join(tmp, "outside-install-state.json");
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(outside, "outside-before\n");
    if (kind === "symlink") symlinkSync(outside, statePath);
    else linkSync(outside, statePath);
    prepareCodexRepo(home);

    const result = guardedMerge(join(home, ".codex", "config.toml"));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/unsafe existing Codex destination/);
    expect(readFileSync(outside, "utf8")).toBe("outside-before\n");
  };

  it.skipIf(!symlinksAvailable)("rejects a managed upstream install-state symlink", () => {
    assertRejectedManagedUpstreamInstallState("symlink");
  });

  it("rejects a managed upstream install-state hardlink", () => {
    assertRejectedManagedUpstreamInstallState("hardlink");
  });
});

describe("ECC install mechanism registry (#555)", () => {
  it("resolves a mechanism for every registered CLI", () => {
    for (const cli of REGISTRY_IDS) {
      expect(ECC_INSTALL_MECHANISM_LABELS[eccInstallMechanism(cli as Cli)]).toBeTypeOf("string");
    }
  });

  it("defaults an unregistered target to consult, so it cannot inherit an install claim", () => {
    // The #553/#555 failure mode: a newly registered tool silently inheriting a claim
    // that is false for it. Anything not explicitly mapped installs nothing.
    expect(eccInstallMechanism("some-future-cli" as Cli)).toBe("consult");
  });

  it("maps each mechanism to exactly the targets that use it", () => {
    expect(eccInstallMechanism("kiro")).toBe("native-script");
    expect(eccInstallMechanism("codex")).toBe("checkout-merge");
    expect(eccInstallMechanism("claude")).toBe("npm");
    expect(eccInstallMechanism("windsurf")).toBe("consult");
    for (const cli of AIH_DIRECT_ECC_INSTALL_TARGETS) {
      expect(eccInstallMechanism(cli)).toBe("npm");
    }
  });

  it("agrees with the routing predicates it replaces", () => {
    for (const cli of REGISTRY_IDS as Cli[]) {
      expect(eccInstallMechanism(cli) === "npm").toBe(isAihDirectEccInstallTarget(cli));
      expect(["npm", "checkout-merge"].includes(eccInstallMechanism(cli))).toBe(
        isEccInstallTarget(cli),
      );
    }
  });
});

describe("ECC installed-source drift detection (#555)", () => {
  /** A kiro plan context whose ECC checkout reports `commit` for `git rev-parse HEAD`. */
  function kiroCtx(commit: string): PlanContext {
    const run = fakeRunner((argv) =>
      argv.includes("rev-parse")
        ? {
            code: 0,
            stdout: `${commit}
`,
          }
        : undefined,
    );
    return {
      root: tmp,
      contextDir: ".ai-context",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: { HOME: tmp, USERPROFILE: tmp },
      options: { cli: "kiro" },
    };
  }

  const driftProbe = async (ctx: PlanContext) => {
    const found = (await command.plan(ctx)).actions.filter(
      (a): a is ProbeAction => a.kind === "probe" && a.describe.includes("installed-source drift"),
    );
    expect(found).toHaveLength(1);
    const probeAction = found[0];
    if (probeAction === undefined) throw new Error("missing drift probe");
    return probeAction.run(ctx);
  };

  const installKiroContent = (): void => {
    put(".kiro/steering/00-canon.md", "canon body\n");
    put(".kiro/agents/reviewer.md", "reviewer body\n");
  };

  const recordManifestAt = (commit: string): void => {
    writeEccInstallManifestAtomic(tmp, {
      schemaVersion: ECC_INSTALL_MANIFEST_SCHEMA_VERSION,
      installs: [
        {
          target: "kiro",
          mechanism: "native-script",
          root: join(tmp, ".kiro"),
          installedAt: "2026-07-31T00:00:00.000Z",
          source: { kind: "git-checkout", ref: "main", commit, package: null, version: null },
          files: [
            {
              path: "agents/reviewer.md",
              sha256: hashManagedFile(join(tmp, ".kiro"), "agents/reviewer.md") ?? "",
            },
            {
              path: "steering/00-canon.md",
              sha256: hashManagedFile(join(tmp, ".kiro"), "steering/00-canon.md") ?? "",
            },
          ],
        },
      ],
    });
  };

  it("ACCEPTANCE: installed from source A, re-run at source B surfaces a drift finding", async () => {
    installKiroContent();
    recordManifestAt("a".repeat(40));
    const check = await driftProbe(kiroCtx("b".repeat(40)));
    expect(check.verdict).toBe("skip"); // advisory: reporting is in scope, repair is not
    expect(check.code).toBe("ecc.install-drift");
    expect(check.detail).toMatch(/2 stale/);
    expect(check.detail).toMatch(/cannot update these/);
  });

  it("reports no drift when the checkout still matches the recorded source", async () => {
    installKiroContent();
    recordManifestAt("a".repeat(40));
    const check = await driftProbe(kiroCtx("a".repeat(40)));
    expect(check.verdict).toBe("pass");
    expect(check.detail).toMatch(/matches the installed source/);
  });

  it("never reports a locally edited file as stale, even when the source moved on", async () => {
    installKiroContent();
    recordManifestAt("a".repeat(40));
    put(".kiro/steering/00-canon.md", "the operator rewrote this\n");
    const check = await driftProbe(kiroCtx("b".repeat(40)));
    expect(check.detail).toMatch(/1 stale/);
    expect(check.detail).toMatch(/1 locally modified/);
    expect(check.detail).toContain("steering/00-canon.md (user-modified)");
  });

  it("reports an install predating the manifest as unknown provenance, never stale", async () => {
    installKiroContent(); // content on disk, no manifest — the pre-#555 install
    const check = await driftProbe(kiroCtx("b".repeat(40)));
    expect(check.verdict).toBe("skip");
    expect(check.code).toBe("ecc.install-drift");
    expect(check.detail).toMatch(/no ownership record/);
    expect(check.detail).not.toMatch(/stale/);
  });

  it("passes cleanly when nothing is installed yet", async () => {
    const check = await driftProbe(kiroCtx("a".repeat(40)));
    expect(check.verdict).toBe("pass");
  });

  it("brackets the Kiro install with a snapshot before and an ownership capture after", async () => {
    const argvs = execs((await command.plan(kiroCtx("a".repeat(40)))).actions).map((e) => e.argv);
    const snapshot = argvs.findIndex((argv) => argv.includes("snapshot"));
    const install = argvs.findIndex((argv) => argv.some((v) => v.includes("install.sh")));
    const capture = argvs.findIndex((argv) => argv.includes("capture"));
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(snapshot);
    expect(capture).toBeGreaterThan(install);
  });

  it("only records ownership after a SUCCESSFUL install", async () => {
    const capture = execs((await command.plan(kiroCtx("a".repeat(40)))).actions).find((e) =>
      e.argv.includes("capture"),
    );
    expect(capture?.requiresPriorExecSuccess).toBe(true);
  });

  // The capture script is generated source inside a string, so CodeQL cannot see it and
  // the exec-ordering tests above never run it. Run the real argv the plan emits: the
  // hash IS the ownership proof, so a symlink planted while the external installer runs
  // must never be hashed into the manifest as AIH-owned content.
  it("records created regular files but never hashes a planted symlink (runs the real capture script)", async () => {
    const planned = execs((await command.plan(kiroCtx("a".repeat(40)))).actions);
    const snapshot = planned.find((e) => e.argv.includes("snapshot"));
    const capture = planned.find((e) => e.argv.includes("capture"));
    if (snapshot === undefined || capture === undefined) throw new Error("missing capture wiring");

    const runScript = (argv: readonly string[]): void => {
      const result = spawnSync(argv[0] ?? "node", argv.slice(1), { encoding: "utf8" });
      expect(result.status).toBe(0);
    };

    runScript(snapshot.argv); // .kiro/ is empty at this point

    // Stand in for the installer: one real file, plus a symlink pointing outside the root.
    const outside = mkdtempSync(join(tmpdir(), "aih-ecc-capture-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "content outside the managed root\n", "utf8");
      put(".kiro/agents/reviewer.md", "reviewer body\n");
      try {
        symlinkSync(join(outside, "secret.md"), join(tmp, ".kiro", "agents", "linked.md"), "file");
      } catch {
        return; // unprivileged Windows cannot create symlinks; nothing to assert
      }

      runScript(capture.argv);

      const read = readEccInstallManifest(tmp);
      expect(read.present).toBe(true);
      const install = read.present ? read.manifest.installs[0] : undefined;
      const paths = (install?.files ?? []).map((f) => f.path);
      expect(paths).toContain("agents/reviewer.md");
      expect(paths).not.toContain("agents/linked.md");
      const outsideHash = hashManagedFile(outside, "secret.md");
      expect((install?.files ?? []).some((f) => f.sha256 === outsideHash)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
