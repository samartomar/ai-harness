import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/ecc/index.js";
import { eccInstallerArgv, eccMethod } from "../../src/ecc/install.js";
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
    env: {},
    options,
  };
}

const docs = (actions: Action[]): DocAction[] =>
  actions.filter((a): a is DocAction => a.kind === "doc");
const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((a): a is ExecAction => a.kind === "exec");

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

describe("eccMethod / eccInstallerArgv", () => {
  it("routes each CLI to the right install method", () => {
    expect(eccMethod("claude")).toBe("plugin");
    expect(eccMethod("cursor")).toBe("installer");
    expect(eccMethod("zed")).toBe("installer");
    expect(eccMethod("gemini")).toBe("consult");
    expect(eccMethod("antigravity")).toBe("consult");
    // codex/kiro/opencode are NOT ecc-install targets — they're intercepted in
    // eccPlan (native scripts / AGENTS.md auto-detect), verified in the plan tests.
    expect(eccMethod("codex")).not.toBe("installer");
    expect(eccMethod("opencode")).not.toBe("installer");
  });

  it("builds a stack-customized installer argv", () => {
    const argv = eccInstallerArgv("cursor", {
      profile: "core",
      packs: ["typescript", "python"],
      installEverything: false,
      stackSummary: "x",
    });
    expect(argv).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "core",
      "typescript",
      "python",
    ]);
  });

  it("uses --profile full and no packs when installing everything", () => {
    const argv = eccInstallerArgv("cursor", {
      profile: "core",
      packs: [],
      installEverything: true,
      stackSummary: "x",
    });
    expect(argv).toEqual([
      "npx",
      "--yes",
      "ecc-install",
      "--target",
      "cursor",
      "--profile",
      "full",
    ]);
  });
});

describe("ecc.plan — real affaan-m/ECC install", () => {
  it("default (claude) emits the plugin marketplace + install commands as a doc", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx())).actions;
    const text = docs(actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("/plugin marketplace add https://github.com/affaan-m/ECC");
    expect(text).toContain("/plugin install ecc@ecc");
    // No installer exec for the default claude-only selection (plugin path).
    expect(execs(actions)).toHaveLength(0);
  });

  it("always documents the ECC ecosystem tools (consult + agentshield)", async () => {
    const text = docs((await command.plan(makeCtx())).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("npx ecc consult");
    expect(text).toContain("npx ecc-agentshield scan");
  });

  it("--cli codex uses ECC's native sync-ecc-to-codex.sh, not ecc-install", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx({ cli: "codex" }))).actions;
    const blob = actions
      .map((a) => (a.kind === "doc" ? a.text : a.kind === "exec" ? a.argv.join(" ") : ""))
      .join("\n");
    expect(blob).toContain("sync-ecc-to-codex.sh");
    // Codex is not an ecc-install target — never fabricate that command.
    expect(blob).not.toContain("ecc-install --target codex");
  });

  it("--cli opencode documents AGENTS.md auto-detect (no ecc-install target)", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx({ cli: "opencode" }))).actions;
    const blob = actions
      .map((a) => (a.kind === "doc" ? a.text : a.kind === "exec" ? a.argv.join(" ") : ""))
      .join("\n");
    expect(blob).toContain("AGENTS.md");
    expect(blob).not.toContain("ecc-install --target opencode");
  });

  it("honors --profile", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx({ cli: "cursor", profile: "full" }))).actions;
    expect(execs(actions)[0]?.argv).toContain("full");
  });

  it("--cli gemini routes through the consult advisor doc", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const text = docs((await command.plan(makeCtx({ cli: "gemini" }))).actions)
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("npx ecc consult");
    expect(text).toContain("--target gemini");
  });

  it("--cli kiro uses ECC's native .kiro/install.sh (exec if found, else clone doc)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "kiro" }))).actions;
    const blob = actions
      .map((a) => (a.kind === "doc" ? a.text : a.kind === "exec" ? a.argv.join(" ") : ""))
      .join("\n");
    expect(blob).toContain(".kiro/install.sh");
    // No fabricated ECC consult/installer for kiro — it's the native installer path.
    expect(blob).not.toContain("ecc-install --target kiro");
  });

  it("--all-tools covers plugin (claude), installer (cursor/zed), native (codex/kiro), consult (gemini)", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    const text = docs(actions)
      .map((d) => d.text)
      .join("\n");
    const blob = actions
      .map((a) => (a.kind === "doc" ? a.text : a.kind === "exec" ? a.argv.join(" ") : ""))
      .join("\n");
    expect(text).toContain("/plugin install ecc@ecc"); // claude plugin
    const targets = execs(actions)
      .filter((e) => e.argv.includes("--target"))
      .map((e) => e.argv[e.argv.indexOf("--target") + 1]);
    expect(targets).toEqual(expect.arrayContaining(["cursor", "zed"]));
    // codex/opencode are no longer (invalid) ecc-install targets.
    expect(targets).not.toContain("codex");
    expect(targets).not.toContain("opencode");
    expect(blob).not.toContain("ecc-install --target codex");
    expect(blob).not.toContain("ecc-install --target opencode");
    expect(blob).toContain("sync-ecc-to-codex.sh"); // codex native script
    expect(blob).toContain(".kiro/install.sh"); // kiro native installer
    expect(text).toContain("--target gemini"); // consult
  });

  it("BOUNDARY: only doc/exec actions and no remote/URL write targets", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    for (const a of actions) {
      expect(["doc", "exec"]).toContain(a.kind);
    }
  });
});
