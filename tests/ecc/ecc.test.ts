import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/ecc/index.js";
import { allModuleSlugs } from "../../src/ecc/rules.js";
import { selectModules } from "../../src/ecc/select.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
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

function makeCtx(platform: "linux" | "windows" = "linux"): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform, run, env: {} }),
    env: {},
    options: {},
  };
}

function writeAt(actions: Action[], suffix: string): WriteAction | undefined {
  return actions.find(
    (a): a is WriteAction => a.kind === "write" && a.path.replace(/\\/g, "/").endsWith(suffix),
  );
}

describe("selectModules", () => {
  it("picks common + the language module for a TypeScript repo", () => {
    const sel = selectModules(stack({ languages: ["TypeScript/Node.js"], hasTypeScript: true }));
    expect(sel.modules).toEqual(["common", "typescript"]);
    expect(sel.installedEverything).toBe(false);
  });

  it("adds serverless-aws for a JS Serverless project", () => {
    const sel = selectModules(
      stack({
        languages: ["JavaScript/Node.js"],
        frameworks: ["Serverless Framework"],
        cloud: ["AWS"],
      }),
    );
    expect(sel.modules).toEqual(["common", "javascript", "serverless-aws"]);
  });

  it("adds the web module for a frontend framework", () => {
    const sel = selectModules(
      stack({ languages: ["TypeScript/Node.js"], frameworks: ["Next.js"] }),
    );
    expect(sel.modules).toEqual(expect.arrayContaining(["common", "typescript", "web"]));
  });

  it("installs EVERYTHING when no stack is detectable (empty repo)", () => {
    const sel = selectModules(stack());
    expect(sel.installedEverything).toBe(true);
    expect(sel.modules).toEqual(allModuleSlugs());
    expect(sel.modules).toContain("common");
    expect(sel.modules.length).toBeGreaterThan(5);
  });
});

describe("ecc.plan — install", () => {
  it("writes common + matched module files, a RULE_ROUTER, and a manifest", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");

    const actions = (await command.plan(makeCtx())).actions;
    expect(writeAt(actions, ".ai-context/rules/ecc/common.md")).toBeDefined();
    expect(writeAt(actions, ".ai-context/rules/ecc/typescript.md")).toBeDefined();
    expect(writeAt(actions, ".ai-context/rules/ecc/javascript.md")).toBeUndefined();

    const router = writeAt(actions, ".ai-context/rules/ecc/RULE_ROUTER.md");
    expect(router?.contents).toContain("typescript.md");
    expect(router?.contents).toContain("self-heal");

    const manifest = actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith("manifest.json"),
    );
    expect((manifest?.json as { modules: string[] }).modules).toEqual(["common", "typescript"]);
  });

  it("installs the serverless-aws rule for a JS Serverless repo", async () => {
    put("package.json", JSON.stringify({ name: "api", devDependencies: { serverless: "^3" } }));
    put("serverless.yml", "service: api\nprovider:\n  name: aws\n");
    const actions = (await command.plan(makeCtx())).actions;
    expect(writeAt(actions, ".ai-context/rules/ecc/serverless-aws.md")).toBeDefined();
    expect(writeAt(actions, ".ai-context/rules/ecc/javascript.md")).toBeDefined();
  });

  it("self-heals: re-running prunes a module that no longer applies", async () => {
    // Previous run installed python; the repo is now TypeScript.
    put(".ai-context/rules/ecc/manifest.json", JSON.stringify({ modules: ["common", "python"] }));
    put(".ai-context/rules/ecc/python.md", "# stale");
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");

    const actions = (await command.plan(makeCtx())).actions;
    const prune = actions.find(
      (a) =>
        a.kind === "exec" && a.argv.some((arg) => arg.replace(/\\/g, "/").endsWith("python.md")),
    );
    expect(prune).toBeDefined();
    expect(prune?.kind === "exec" ? prune.allowFailure : false).toBe(true);
  });

  it("BOUNDARY: only write/exec/doc actions — never a remote target", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    const actions = (await command.plan(makeCtx())).actions;
    for (const a of actions) {
      expect(["write", "exec", "doc"]).toContain(a.kind);
      if (a.kind === "write") expect(a.path.startsWith("http")).toBe(false);
    }
  });
});
