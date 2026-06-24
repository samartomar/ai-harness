import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/profile/index.js";
import { scanRepo } from "../../src/profile/scan.js";

// ---- fixtures -------------------------------------------------------------

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

function pkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string {
  return JSON.stringify({ name: "fixture", dependencies: deps, devDependencies: devDeps });
}

/** Build a dry-run PlanContext rooted at `tmp` with a fake, network-free host. */
function makeCtx(options: Record<string, unknown> = {}, contextDir = ".ai-context"): PlanContext {
  const run = fakeRunner(() => undefined);
  const host = makeHostAdapter({ platform: "linux", run, env: {} });
  return {
    root: tmp,
    contextDir,
    apply: false,
    verify: false,
    json: false,
    run,
    host,
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

// ---- scanRepo: detection rules -------------------------------------------

describe("scanRepo", () => {
  it("detects a Node + vitest repo with the right test runner", () => {
    put("package.json", pkg({}, { vitest: "^2.0.0" }));

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["TypeScript/Node.js"]);
    expect(stack.testRunner).toBe("npx vitest run");
  });

  it("detects jest and next from package.json", () => {
    put("package.json", pkg({ next: "14.0.0" }, { jest: "^29.0.0" }));

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["TypeScript/Node.js"]);
    expect(stack.testRunner).toBe("npm run test");
    expect(stack.buildCommand).toBe("next build");
  });

  it("detects a Python + pytest repo with ruff lint", () => {
    put("pyproject.toml", "[project]\nname = 'svc'\n");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["Python"]);
    expect(stack.testRunner).toBe("pytest");
    expect(stack.buildCommand).toBe("python -m build");
    expect(stack.lintCommand).toBe("ruff check");
  });

  it("detects Go, Rust, and .NET signatures", () => {
    put("go.mod", "module example.com/x\n");
    const goStack = scanRepo(tmp, { maxDepth: 8 });
    expect(goStack.languages).toEqual(["Go"]);
    expect(goStack.testRunner).toBe("go test ./...");
    expect(goStack.buildCommand).toBe("go build ./...");

    rmSync(join(tmp, "go.mod"));
    put("Cargo.toml", "[package]\nname = 'x'\n");
    const rustStack = scanRepo(tmp, { maxDepth: 8 });
    expect(rustStack.languages).toEqual(["Rust"]);
    expect(rustStack.testRunner).toBe("cargo test");

    rmSync(join(tmp, "Cargo.toml"));
    put("Api.csproj", "<Project></Project>");
    const dotnetStack = scanRepo(tmp, { maxDepth: 8 });
    expect(dotnetStack.languages).toEqual([".NET Core"]);
    expect(dotnetStack.testRunner).toBe("dotnet test");
    expect(dotnetStack.buildCommand).toBe("dotnet build");
  });

  it("detects .NET from a .slnx solution file (blueprint sln|slnx|csproj regex)", () => {
    put("App.slnx", "<Solution></Solution>");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual([".NET Core"]);
    expect(stack.testRunner).toBe("dotnet test");
  });

  it("detects Java/Maven with the blueprint build command", () => {
    put("pom.xml", "<project></project>");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["Java/Maven"]);
    expect(stack.testRunner).toBe("mvn test");
    expect(stack.buildCommand).toBe("mvn clean package");
  });

  it("detects deployment targets (Docker, Helm, Terraform) without languages", () => {
    put("Dockerfile", "FROM node:20\n");
    put("chart/Chart.yaml", "apiVersion: v2\nname: svc\n");
    put("infra/main.tf", 'provider "aws" {}\n');

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.deployment).toEqual(["Docker", "Kubernetes/Helm", "Terraform"]);
    expect(stack.languages).toEqual([]);
  });

  it("detects a polyglot repo and dedupes languages across nested dirs", () => {
    put("package.json", pkg({}, { vitest: "^2.0.0" }));
    put("services/api/go.mod", "module example.com/api\n");
    put("services/worker/package.json", pkg());
    put("Dockerfile", "FROM scratch\n");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    // TypeScript appears in two package.json files but is listed once.
    expect(stack.languages.filter((l) => l === "TypeScript/Node.js")).toHaveLength(1);
    expect(stack.languages).toContain("Go");
    expect(stack.deployment).toEqual(["Docker"]);
  });

  it("excludes node_modules and other vendored/generated directories", () => {
    put("package.json", pkg({}, { vitest: "^2.0.0" }));
    // A Cargo.toml buried in node_modules must NOT register Rust.
    put("node_modules/some-dep/Cargo.toml", "[package]\nname = 'dep'\n");
    put("dist/main.tf", 'provider "aws" {}\n');
    put(".git/config", "[core]\n");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["TypeScript/Node.js"]);
    expect(stack.deployment).toEqual([]); // dist/ is excluded
  });

  it("respects maxDepth and stops descending", () => {
    // root(0)/a(1)/b(2)/go.mod lives at depth 2.
    put("a/b/go.mod", "module example.com/deep\n");

    expect(scanRepo(tmp, { maxDepth: 1 }).languages).toEqual([]);
    expect(scanRepo(tmp, { maxDepth: 2 }).languages).toEqual(["Go"]);
  });

  it("still registers Node when package.json is malformed", () => {
    put("package.json", "{ not valid json");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack.languages).toEqual(["TypeScript/Node.js"]);
    expect(stack.testRunner).toBeUndefined();
  });

  it("returns an empty profile for a repo with no signatures", () => {
    put("README.md", "# nothing here\n");

    const stack = scanRepo(tmp, { maxDepth: 8 });

    expect(stack).toEqual({
      languages: [],
      testRunner: undefined,
      buildCommand: undefined,
      lintCommand: undefined,
      deployment: [],
    });
  });
});

// ---- plan(): generated artifacts -----------------------------------------

describe("profile.plan", () => {
  it("emits a thin CLAUDE.md (< 30 lines) with the pointer sentence and detected commands", async () => {
    put("package.json", pkg({}, { vitest: "^2.0.0" }));
    const ctx = makeCtx();

    const result = await command.plan(ctx);
    const claude = findWrite(result.actions, "CLAUDE.md");

    expect(claude).toBeDefined();
    const text = claude?.contents ?? "";
    expect(text.split("\n").length).toBeLessThan(30);
    expect(text).toContain("This file is not the full rulebook.");
    expect(text).toContain("npx vitest run");
    expect(text).toContain(".ai-context");
  });

  it("routes CLAUDE.md to a custom context dir", async () => {
    put("go.mod", "module example.com/x\n");
    const ctx = makeCtx({}, "ai-coding");

    const result = await command.plan(ctx);
    const text = findWrite(result.actions, "CLAUDE.md")?.contents ?? "";

    expect(text).toContain("ai-coding/");
    expect(text).not.toContain(".ai-context");
  });

  it("writes a 01-stack.mdc with valid frontmatter and commands", async () => {
    put("pyproject.toml", "[project]\nname = 'svc'\n");
    const ctx = makeCtx();

    const result = await command.plan(ctx);
    const mdc = findWrite(result.actions, ".cursor/rules/01-stack.mdc")?.contents ?? "";

    expect(mdc.startsWith("---\n")).toBe(true);
    expect(mdc).toContain('globs: ["**/*"]');
    expect(mdc).toContain("alwaysApply: false");
    expect(mdc).toContain("ruff check");
  });

  it("adds the TypeScript .mdc only when a TS/Node stack is detected", async () => {
    put("package.json", pkg());
    const tsResult = await command.plan(makeCtx());
    expect(findWrite(tsResult.actions, ".cursor/rules/02-typescript.mdc")).toBeDefined();

    rmSync(join(tmp, "package.json"));
    put("go.mod", "module example.com/x\n");
    const goResult = await command.plan(makeCtx());
    expect(findWrite(goResult.actions, ".cursor/rules/02-typescript.mdc")).toBeUndefined();
  });

  it("adds the EF Core .mdc only when a .NET stack is detected", async () => {
    put("Api.csproj", "<Project></Project>");
    const result = await command.plan(makeCtx());

    const efcore = findWrite(result.actions, ".cursor/rules/03-efcore.mdc");
    expect(efcore).toBeDefined();
    expect(efcore?.contents).toContain("AsNoTracking()");
    expect(efcore?.contents).toContain("sync-over-async");
  });

  it("BOUNDARY: produces only local write actions — no exec, doc, or probe", async () => {
    put("package.json", pkg({ next: "14.0.0" }, { vitest: "^2.0.0" }));
    put("Api.csproj", "<Project></Project>");

    const result = await command.plan(makeCtx());

    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every((a) => a.kind === "write")).toBe(true);
    // every write targets a repo-relative path, never an absolute/remote location
    for (const action of writes(result.actions)) {
      expect(action.path.startsWith("/")).toBe(false);
      expect(action.contents).toBeDefined();
    }
  });

  it("is idempotent: the same tree yields byte-identical plans", async () => {
    put("package.json", pkg({}, { vitest: "^2.0.0" }));
    put("services/api/go.mod", "module example.com/api\n");

    const first = await command.plan(makeCtx());
    const second = await command.plan(makeCtx());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("falls back to the default depth when --max-depth is unparseable", async () => {
    // go.mod at depth 2; a garbage flag must not silently shrink the scan to 0.
    put("a/b/go.mod", "module example.com/deep\n");
    const ctx = makeCtx({ maxDepth: "not-a-number" });

    const result = await command.plan(ctx);
    const text = findWrite(result.actions, "CLAUDE.md")?.contents ?? "";

    expect(text).toContain("go test ./...");
  });
});
