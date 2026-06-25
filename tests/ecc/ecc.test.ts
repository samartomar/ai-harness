import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/ecc/index.js";
import {
  ECC_INSTALL_TARGETS,
  eccInstallerArgv,
  isEccInstallTarget,
} from "../../src/ecc/install.js";
import { eccLanguages } from "../../src/ecc/select.js";
import type { Action, DocAction, ExecAction, PlanContext } from "../../src/internals/plan.js";
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

  it("signals installEverything when no stack is detectable (empty repo)", () => {
    const sel = eccLanguages(stack());
    expect(sel.installEverything).toBe(true);
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
  });

  it("builds the npx ecc-install argv scoped only by profile", () => {
    expect(eccInstallerArgv("cursor", "core")).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "core",
    ]);
    expect(eccInstallerArgv("gemini", "full")).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "gemini",
      "--profile",
      "full",
    ]);
  });
});

describe("ecc.plan — runs ECC's own installer (latest)", () => {
  it("default (claude) runs npx ecc-install --target claude under --apply", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx())).actions;
    expect(execs(actions)[0]?.argv).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "claude",
      "--profile",
      "core",
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

  it("--cli codex now installs via npx ecc-install --target codex (npm v2 target)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "codex" }))).actions;
    expect(installTargets(actions)).toContain("codex");
    // the old native sync-script / clone path is gone.
    expect(execBlob(actions)).not.toContain("sync-ecc-to-codex.sh");
  });

  it("--cli gemini installs via npx ecc-install (a real v2 target now, not consult)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "gemini" }))).actions;
    expect(execs(actions)[0]?.argv).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "gemini",
      "--profile",
      "core",
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

  it("--all-tools: every npm target via ecc-install, kiro via git checkout", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    expect(installTargets(actions)).toEqual(
      expect.arrayContaining([
        "claude",
        "codex",
        "cursor",
        "antigravity",
        "gemini",
        "opencode",
        "zed",
      ]),
    );
    expect(installTargets(actions)).not.toContain("kiro");
    expect(installTargets(actions)).not.toContain("copilot"); // not an ECC target → consult
    expect(installTargets(actions)).not.toContain("kimi"); // not an ECC target → consult
    const blob = execBlob(actions);
    expect(blob).toContain(".kiro/install.sh"); // kiro native installer
    expect(blob).not.toContain("ecc-install --target kiro");
  });

  it("BOUNDARY: only doc/exec actions (no remote/URL write targets)", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    for (const a of actions) {
      expect(["doc", "exec"]).toContain(a.kind);
    }
  });
});
