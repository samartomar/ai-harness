import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/ecc/index.js";
import {
  AIH_DIRECT_ECC_INSTALL_TARGETS,
  ECC_INSTALL_TARGETS,
  ECC_NPM_BINS,
  eccInstallerArgv,
  isAihDirectEccInstallTarget,
  isEccInstallTarget,
  normalizeEccInstallVersion,
} from "../../src/ecc/install.js";
import { eccLanguages } from "../../src/ecc/select.js";
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
    .map((e) => e.argv.join(" "))
    .join("\n")
    .replace(/\\/g, "/");
const installTargets = (actions: Action[]): (string | undefined)[] =>
  execs(actions)
    .filter((e) => e.argv.includes("ecc-install") && e.argv.includes("--target"))
    .map((e) => e.argv[e.argv.indexOf("--target") + 1]);

function codexInstallState(actions: Action[]): {
  codexToml: { tables: string[]; tableKeys: Record<string, string[]> };
} {
  const install = execs(actions).find((e) => e.describe.includes("record prune state"));
  const stateB64 = install?.argv.at(-1);
  if (!stateB64) throw new Error("missing encoded Codex install state");
  return JSON.parse(Buffer.from(stateB64, "base64").toString("utf8")) as {
    codexToml: { tables: string[]; tableKeys: Record<string, string[]> };
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
      "core",
      "typescript",
    ]);
    // the marketplace plugin is still offered as a doc alternative
    expect(
      docs(actions)
        .map((d) => d.text)
        .join("\n"),
    ).toContain("/plugin install ecc@ecc");
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
    expect(blob).toContain("scripts/codex/merge-mcp-config.js");
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

  it("--cli codex passes the requested profile into the managed Codex file install", async () => {
    const install = execs(
      (await command.plan(makeCtx({ cli: "codex", profile: "minimal" }))).actions,
    ).find((e) => e.describe.includes("record prune state"));
    expect(install?.argv).toContain("minimal");
    expect(install?.argv.join(" ")).toContain("createManifestInstallPlan");
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
      "core",
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
      "core",
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
      expect(["doc", "exec", "write"]).toContain(a.kind);
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
  it("refuses Codex when existing global transport would collide with ECC's planned MCP addition", async () => {
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

  it("allows a project Context7 HTTP override while ECC plans the global stdio server", async () => {
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
    expect(execBlob(actions)).toContain("merge-mcp-config.js");
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mcp.config-invalid" })]),
    );
  });

  it("allows a project Context7 HTTP override of an existing global stdio server", async () => {
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
    expect(execBlob(actions)).toContain("merge-mcp-config.js");
    const probes = actions.filter((a): a is ProbeAction => a.kind === "probe");
    const checks = await Promise.all(probes.map((p) => p.run(ctx)));
    expect(checks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "mcp.config-invalid" })]),
    );
  });
});
