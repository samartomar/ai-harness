import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/profile/index.js";
import { scanRepo } from "../../src/profile/scan.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-profile-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write `contents` to `tmp/<relPath>`, creating parent directories. */
function put(relPath: string, contents: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

interface PkgOpts {
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  scripts?: Record<string, string>;
  description?: string;
}
function pkg(opts: PkgOpts = {}): string {
  return JSON.stringify({
    name: "fixture",
    description: opts.description,
    scripts: opts.scripts ?? {},
    dependencies: opts.deps ?? {},
    devDependencies: opts.devDeps ?? {},
  });
}

function makeCtx(options: Record<string, unknown> = {}, contextDir = ".ai-context"): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

function writes(actions: Action[]): WriteAction[] {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}
function findWrite(actions: Action[], path: string): WriteAction | undefined {
  return writes(actions).find((a) => a.path === path);
}

describe("scanRepo — lint detection from a config file (AIH-PROFILE-001)", () => {
  it("detects eslint via eslint.config.mjs even when the root package.json has no lint script/dep", () => {
    // Mirrors a monorepo whose root package.json defines no lint and lists no linter
    // dep, but is clearly linted — the integration-hub case that produced a
    // gitleaks-only pre-commit gate.
    put("package.json", pkg({ scripts: { build: "tsc" } }));
    put("eslint.config.mjs", "export default []\n");
    put("pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBe("npx eslint .");
  });

  it("prefers a real root lint script over the config-file fallback", () => {
    put("package.json", pkg({ scripts: { lint: "eslint ." } }));
    put("eslint.config.mjs", "export default []\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBe("npm run lint");
  });

  it("detects biome via biome.json", () => {
    put("package.json", pkg({ scripts: {} }));
    put("biome.json", "{}\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBe("npx biome check .");
  });
});

describe("scanRepo — excludes its own generated context dir", () => {
  it("does not walk the configured context dir (no self-detection of generated canon)", () => {
    put("package.json", pkg({ scripts: {} }));
    // A manifest INSIDE the generated canon dir must never count as repo stack.
    put("ai-coding/nested/go.mod", "module x\n");
    const excluded = scanRepo(tmp, { maxDepth: 8, contextDir: "ai-coding" });
    expect(excluded.languages).not.toContain("Go");
    // Control: without the exclusion, the nested manifest leaks into the stack —
    // which is exactly the bug, since the default canon dir is the visible ai-coding.
    expect(scanRepo(tmp, { maxDepth: 8 }).languages).toContain("Go");
  });

  it("still excludes the legacy .ai-context default", () => {
    put("package.json", pkg({ scripts: {} }));
    put(".ai-context/nested/go.mod", "module x\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).languages).not.toContain("Go");
  });
});

// ---- the regression that motivated this rework ----------------------------

describe("scanRepo — JavaScript Serverless project (regression)", () => {
  function plantServerless(): void {
    put(
      "package.json",
      pkg({
        description: "Serverless blog API on AWS Lambda + DynamoDB",
        deps: { "aws-sdk": "^2.1500.0" },
        devDeps: { serverless: "^3.38.0" },
        // npm-init default placeholder — NOT a real test command.
        scripts: { test: 'echo "Error: no test specified" && exit 0', deploy: "serverless deploy" },
      }),
    );
    put(
      "serverless.yml",
      [
        "service: blog-api",
        "provider:",
        "  name: aws",
        "  runtime: nodejs20.x",
        "functions:",
        "  createPost:",
        "    handler: src/handlers/createPost.handler",
      ].join("\n"),
    );
    put("src/handlers/createPost.js", 'const AWS=require("aws-sdk");exports.handler=async()=>{};');
  }

  it("detects JavaScript (not TypeScript) — no tsconfig, no .ts files", () => {
    plantServerless();
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toContain("JavaScript/Node.js");
    expect(s.languages).not.toContain("TypeScript/Node.js");
    expect(s.hasTypeScript).toBe(false);
  });

  it("detects the Serverless Framework and AWS from serverless.yml + aws-sdk", () => {
    plantServerless();
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.frameworks).toContain("Serverless Framework");
    expect(s.cloud).toContain("AWS");
    expect(s.deployment).toContain("Serverless Framework");
  });

  it("does NOT invent a test command from a placeholder echo script, and finds no lint", () => {
    plantServerless();
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.testRunner).toBeUndefined(); // placeholder echo is not a real test
    expect(s.lintCommand).toBeUndefined(); // no lint script, no linter dep
  });

  it("surfaces the description and the serverless handler entry point", () => {
    plantServerless();
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.description).toBe("Serverless blog API on AWS Lambda + DynamoDB");
    expect(s.entryPoints).toContain("src/handlers/createPost.handler");
  });

  it("plan: emits 02-node.mdc + 03-serverless.mdc, and NEVER a TypeScript rule or CLAUDE.md", async () => {
    plantServerless();
    const actions = (await command.plan(makeCtx())).actions;
    expect(findWrite(actions, ".cursor/rules/02-node.mdc")).toBeDefined();
    expect(findWrite(actions, ".cursor/rules/03-serverless.mdc")).toBeDefined();
    expect(findWrite(actions, ".cursor/rules/02-typescript.mdc")).toBeUndefined();
    // Root bootloaders are owned by `aih bootstrap-ai`, never by profile.
    expect(findWrite(actions, "CLAUDE.md")).toBeUndefined();
    const stack = findWrite(actions, ".cursor/rules/01-stack.mdc")?.contents ?? "";
    expect(stack).toContain("JavaScript/Node.js");
    expect(stack).not.toContain("vitest");
  });
});

// ---- JS vs TS + command derivation ----------------------------------------

describe("scanRepo — language + command accuracy", () => {
  it("calls a package.json with a tsconfig TypeScript", () => {
    put("package.json", pkg());
    put("tsconfig.json", "{}");
    put("src/index.ts", "export const x = 1;");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toContain("TypeScript/Node.js");
    expect(s.hasTypeScript).toBe(true);
  });

  it("treats a plain package.json (no TS) as JavaScript", () => {
    put("package.json", pkg());
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual(["JavaScript/Node.js"]);
    expect(s.hasTypeScript).toBe(false);
  });

  it("uses `npm test` when a real test script exists", () => {
    put("package.json", pkg({ scripts: { test: "vitest run" } }));
    expect(scanRepo(tmp, { maxDepth: 8 }).testRunner).toBe("npm test");
  });

  it("surfaces a real start script as a local run command", () => {
    put("package.json", pkg({ scripts: { start: "node app.js" } }));
    expect(scanRepo(tmp, { maxDepth: 8 }).startCommand).toBe("npm start");
  });

  it("falls back to a test runner dep when there is no test script", () => {
    put("package.json", pkg({ devDeps: { vitest: "^2" } }));
    expect(scanRepo(tmp, { maxDepth: 8 }).testRunner).toBe("npx vitest run");
  });

  it("derives lint from a lint script or a known linter dep, else undefined", () => {
    put("package.json", pkg({ scripts: { lint: "eslint ." } }));
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBe("npm run lint");

    rmSync(join(tmp, "package.json"));
    put("package.json", pkg({ devDeps: { "@biomejs/biome": "^1" } }));
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBe("npx biome check .");

    rmSync(join(tmp, "package.json"));
    put("package.json", pkg());
    expect(scanRepo(tmp, { maxDepth: 8 }).lintCommand).toBeUndefined();
  });

  it("detects the package manager from the lockfile", () => {
    put("package.json", pkg());
    put("pnpm-lock.yaml", "lockfileVersion: 9\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).packageManager).toBe("pnpm");
  });

  it("detects Next.js / Express frameworks from deps", () => {
    put("package.json", pkg({ deps: { next: "14", express: "4" } }));
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.frameworks).toEqual(expect.arrayContaining(["Next.js", "Express"]));
  });
});

// ---- non-Node languages + deployment --------------------------------------

describe("scanRepo — other stacks", () => {
  it("detects Go / Rust / .NET with their commands", () => {
    put("go.mod", "module example.com/x\n");
    const go = scanRepo(tmp, { maxDepth: 8 });
    expect(go.languages).toEqual(["Go"]);
    expect(go.testRunner).toBe("go test ./...");

    rmSync(join(tmp, "go.mod"));
    put("Cargo.toml", "[package]\nname='x'\n");
    expect(scanRepo(tmp, { maxDepth: 8 }).languages).toEqual(["Rust"]);

    rmSync(join(tmp, "Cargo.toml"));
    put("Api.csproj", "<Project></Project>");
    const net = scanRepo(tmp, { maxDepth: 8 });
    expect(net.languages).toEqual([".NET"]);
    expect(net.testRunner).toBe("dotnet test");
  });

  it("detects Python Poetry projects with manifest-backed pytest + ruff", () => {
    put(
      "pyproject.toml",
      [
        "[tool.poetry]",
        'name = "svc"',
        'version = "0.1.0"',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'fastapi = "*"',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "*"',
        'ruff = "*"',
        "",
      ].join("\n"),
    );
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual(["Python"]);
    expect(s.frameworks).toContain("FastAPI");
    expect(s.packageManager).toBe("poetry");
    expect(s.testRunner).toBe("pytest");
    expect(s.lintCommand).toBe("ruff check .");
  });

  it("detects Python uv and pip manifests without inventing absent commands", () => {
    put("pyproject.toml", '[project]\nname = "svc"\ndependencies = ["flask"]\n');
    put("uv.lock", "version = 1\n");
    const uv = scanRepo(tmp, { maxDepth: 8 });
    expect(uv.languages).toEqual(["Python"]);
    expect(uv.frameworks).toContain("Flask");
    expect(uv.packageManager).toBe("uv");
    expect(uv.testRunner).toBeUndefined();
    expect(uv.lintCommand).toBeUndefined();

    rmSync(join(tmp, "pyproject.toml"));
    rmSync(join(tmp, "uv.lock"));
    put("requirements.txt", "django\npytest\nblack\nmypy\n");
    const pip = scanRepo(tmp, { maxDepth: 8 });
    expect(pip.frameworks).toContain("Django");
    expect(pip.packageManager).toBe("pip");
    expect(pip.testRunner).toBe("pytest");
    expect(pip.lintCommand).toBe("black --check .");
  });

  it("detects and excludes local Python virtualenv directories", () => {
    put(
      "pyproject.toml",
      '[project]\nname = "svc"\n[project.optional-dependencies]\ndev = ["pytest"]\n',
    );
    put(".venv/lib/python3.12/site-packages/rust_dep/Cargo.toml", "[package]\nname='dep'\n");
    put(".var/python/Lib/venv/not-an-env.py", "# stdlib module, not a local virtualenv\n");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual(["Python"]);
    expect(s.languages).not.toContain("Rust");
    expect(s.virtualEnvPaths).toEqual([".venv"]);
  });

  it("detects deployment targets and CDK/Terraform", () => {
    put("Dockerfile", "FROM node:20\n");
    put("chart/Chart.yaml", "apiVersion: v2\n");
    put("infra/network.tf", 'provider "aws" {}\n');
    put("cdk.json", '{ "app": "node bin/app.js" }');
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.deployment).toEqual(
      expect.arrayContaining(["Docker", "Kubernetes/Helm", "Terraform", "AWS CDK"]),
    );
    expect(s.cloud).toContain("AWS");
  });

  it("excludes node_modules and vendored/generated dirs", () => {
    put("package.json", pkg());
    put("node_modules/some-dep/Cargo.toml", "[package]\nname='dep'\n");
    put("dist/main.tf", 'provider "aws" {}\n');
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual(["JavaScript/Node.js"]);
    expect(s.deployment).toEqual([]);
  });

  it("still registers Node when package.json is malformed", () => {
    put("package.json", "{ not valid json");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual(["JavaScript/Node.js"]);
    expect(s.testRunner).toBeUndefined();
  });

  it("returns an empty profile for a repo with no signatures", () => {
    put("README.md", "# nothing\n");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toEqual([]);
    expect(s.frameworks).toEqual([]);
    expect(s.deployment).toEqual([]);
    expect(s.testRunner).toBeUndefined();
    expect(s.hasTypeScript).toBe(false);
  });

  it("respects maxDepth", () => {
    put("a/b/go.mod", "module example.com/deep\n");
    expect(scanRepo(tmp, { maxDepth: 1 }).languages).toEqual([]);
    expect(scanRepo(tmp, { maxDepth: 2 }).languages).toEqual(["Go"]);
  });
});

// ---- monorepo / workspace detection (P1-G) --------------------------------

describe("scanRepo — monorepo / workspace detection", () => {
  it("flags a pnpm workspace and labels the tool", () => {
    put("package.json", pkg());
    put("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.isMonorepo).toBe(true);
    expect(s.workspaceTool).toBe("pnpm");
  });

  it("detects Turborepo from turbo.json", () => {
    put("package.json", pkg());
    put("turbo.json", "{}");
    expect(scanRepo(tmp, { maxDepth: 8 }).workspaceTool).toBe("turbo");
  });

  it("detects an npm/yarn workspaces field on the root package.json", () => {
    put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: {} }));
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.isMonorepo).toBe(true);
    expect(s.workspaceTool).toBe("npm/yarn workspaces");
  });

  it("detects a Bazel workspace and a Gradle multi-project", () => {
    put("WORKSPACE.bazel", "");
    expect(scanRepo(tmp, { maxDepth: 8 }).workspaceTool).toBe("bazel");
    rmSync(join(tmp, "WORKSPACE.bazel"));
    put("settings.gradle", "include 'app'\n");
    put("build.gradle", "");
    expect(scanRepo(tmp, { maxDepth: 8 }).workspaceTool).toBe("gradle");
  });

  it("detects a Maven multi-module reactor from <modules>", () => {
    put("pom.xml", "<project><modules><module>core</module></modules></project>");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.languages).toContain("Java/Maven");
    expect(s.workspaceTool).toBe("maven");
    expect(s.isMonorepo).toBe(true);
  });

  it("flags multiple package manifests as a monorepo even without an orchestrator", () => {
    put("package.json", pkg());
    put("packages/ui/package.json", pkg());
    put("packages/api/package.json", pkg());
    expect(scanRepo(tmp, { maxDepth: 8 }).isMonorepo).toBe(true);
  });

  it("a single-package repo is NOT a monorepo", () => {
    put("package.json", pkg({ scripts: { test: "vitest run" } }));
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.isMonorepo).toBe(false);
    expect(s.workspaceTool).toBeUndefined();
  });

  it("turbo wins precedence over a bare workspaces field (deterministic)", () => {
    put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"], scripts: {} }));
    put("turbo.json", "{}");
    expect(scanRepo(tmp, { maxDepth: 8 }).workspaceTool).toBe("turbo");
  });

  it("renders the monorepo note + label in the stack rule", async () => {
    put(
      "package.json",
      JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
        scripts: { test: "turbo run test" },
      }),
    );
    put("turbo.json", "{}");
    const stackMdc =
      findWrite((await command.plan(makeCtx())).actions, ".cursor/rules/01-stack.mdc")?.contents ??
      "";
    expect(stackMdc).toContain("Monorepo: turbo workspace");
    expect(stackMdc).toContain("turbo monorepo");
    // a non-monorepo stack rule carries no such note
    rmSync(join(tmp, "turbo.json"));
    rmSync(join(tmp, "package.json"));
    put("package.json", pkg({ scripts: { test: "vitest run" } }));
    const single =
      findWrite((await command.plan(makeCtx())).actions, ".cursor/rules/01-stack.mdc")?.contents ??
      "";
    expect(single.toLowerCase()).not.toContain("monorepo");
  });
});

// ---- build-tool wrapper preference (P1-H sliver) --------------------------

describe("scanRepo — prefers the project's build wrapper", () => {
  it("prefers ./mvnw over mvn when the Maven wrapper is present", () => {
    put("pom.xml", "<project></project>");
    put("mvnw", "#!/bin/sh\n");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.testRunner).toBe("./mvnw test");
    expect(s.buildCommand).toBe("./mvnw clean package");
  });

  it("falls back to bare mvn when no wrapper is present", () => {
    put("pom.xml", "<project></project>");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.testRunner).toBe("mvn test");
    expect(s.buildCommand).toBe("mvn clean package");
  });

  it("prefers ./gradlew over gradle when the Gradle wrapper is present", () => {
    put("build.gradle", "");
    put("gradlew", "#!/bin/sh\n");
    const s = scanRepo(tmp, { maxDepth: 8 });
    expect(s.testRunner).toBe("./gradlew test");
    expect(s.buildCommand).toBe("./gradlew build");
  });
});

// ---- plan(): generated artifacts ------------------------------------------

describe("profile.plan", () => {
  it("emits the stack Cursor rule with the detected language + real command", async () => {
    put("package.json", pkg({ scripts: { test: "vitest run", start: "node app.js" } }));
    const stack =
      findWrite((await command.plan(makeCtx())).actions, ".cursor/rules/01-stack.mdc")?.contents ??
      "";
    expect(stack).toContain("JavaScript/Node.js");
    expect(stack).toContain("npm test");
    expect(stack).toContain("npm start");
  });

  it("writes no root bootloader — that is `aih bootstrap-ai`'s job", async () => {
    put("go.mod", "module example.com/x\n");
    const actions = (await command.plan(makeCtx({}, "ai-coding"))).actions;
    expect(findWrite(actions, "CLAUDE.md")).toBeUndefined();
    expect(findWrite(actions, ".cursor/rules/01-stack.mdc")).toBeDefined();
  });

  it("emits the JS node rule for a plain-JS repo (not the TS rule)", async () => {
    put("package.json", pkg());
    const actions = (await command.plan(makeCtx())).actions;
    const node = findWrite(actions, ".cursor/rules/02-node.mdc")?.contents ?? "";
    expect(node).toContain("JavaScript");
    expect(node).toContain("do not add TypeScript");
  });

  it("emits the EF Core rule only for a .NET stack", async () => {
    put("Api.csproj", "<Project></Project>");
    const efcore = findWrite(
      (await command.plan(makeCtx())).actions,
      ".cursor/rules/03-efcore.mdc",
    );
    expect(efcore?.contents).toContain("AsNoTracking()");
  });

  it("BOUNDARY: produces only local write actions — no exec/doc/probe", async () => {
    put("package.json", pkg({ deps: { next: "14" } }));
    const actions = (await command.plan(makeCtx())).actions;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.kind === "write")).toBe(true);
    for (const a of writes(actions)) {
      expect(a.path.startsWith("/")).toBe(false);
    }
  });

  it("is idempotent: the same tree yields byte-identical plans", async () => {
    put("package.json", pkg({ devDeps: { vitest: "^2" } }));
    put("services/api/go.mod", "module example.com/api\n");
    const first = await command.plan(makeCtx());
    const second = await command.plan(makeCtx());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("is the Cursor profiler standalone (always writes), but silent when Cursor isn't a target", async () => {
    put("package.json", pkg());
    // Standalone (no ctx.targets): always writes the Cursor stack rule.
    expect(
      findWrite((await command.plan(makeCtx())).actions, ".cursor/rules/01-stack.mdc"),
    ).toBeDefined();
    // Under init gating with a non-cursor target set: emits nothing.
    const gated = await command.plan({ ...makeCtx(), targets: ["claude"] });
    expect(gated.actions).toHaveLength(0);
    // With cursor among the targets: writes as usual.
    const targeted = await command.plan({ ...makeCtx(), targets: ["claude", "cursor"] });
    expect(findWrite(targeted.actions, ".cursor/rules/01-stack.mdc")).toBeDefined();
  });
});
