import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadabilityFor } from "../../src/report/cli-loadability.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-load-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function write(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Scaffold the canon the router-chain check resolves to. */
function scaffoldCanon(): void {
  write("ai-coding/RULE_ROUTER.md", "# router\nRULE_ROUTER\n");
  write("ai-coding/rules/agent-behavior-core.md", "# core\n");
}

function scaffoldWorkspaceCanon(): void {
  write(
    ".aih-workspace.json",
    JSON.stringify({
      workspaceType: "multi-repo",
      contextDir: "ai-coding",
      repos: ["service-api"],
      git: true,
      generatedBy: "aih workspace",
    }),
  );
  write("ai-coding/cross-repo-architecture.md", "# Cross-repo architecture\n");
  write("ai-coding/repo-discipline.md", "# Repo discipline\n");
}

const checkOk = (l: ReturnType<typeof loadabilityFor>, name: string) =>
  l.checks.find((c) => c.name === name)?.ok;

describe("activation frontmatter", () => {
  it("cursor .mdc with alwaysApply:true loads", () => {
    scaffoldCanon();
    write(".cursor/rules/00-canon.mdc", "---\nalwaysApply: true\n---\nRULE_ROUTER.md\n");
    expect(loadabilityFor(ctx(), "cursor").verdict).toBe("loads");
  });

  it("cursor .mdc with alwaysApply:false won't load — present but not auto-loaded", () => {
    scaffoldCanon();
    write(".cursor/rules/00-canon.mdc", "---\nalwaysApply: false\n---\nRULE_ROUTER.md\n");
    const l = loadabilityFor(ctx(), "cursor");
    expect(l.verdict).toBe("wontLoad");
    expect(checkOk(l, "activation")).toBe(false);
  });

  it("kiro steering without inclusion:always won't load", () => {
    scaffoldCanon();
    write(".kiro/steering/00-canon.md", "---\ndescription: x\n---\nRULE_ROUTER.md\n");
    expect(loadabilityFor(ctx(), "kiro").verdict).toBe("wontLoad");
  });

  it("kiro steering with inclusion:always loads", () => {
    scaffoldCanon();
    write(".kiro/steering/00-canon.md", "---\ninclusion: always\n---\nRULE_ROUTER.md\n");
    expect(loadabilityFor(ctx(), "kiro").verdict).toBe("loads");
  });
});

describe("hygiene + router chain", () => {
  it("a BOM before content won't load", () => {
    scaffoldCanon();
    write(".windsurfrules", `${String.fromCharCode(0xfeff)}RULE_ROUTER.md\n`);
    const l = loadabilityFor(ctx(), "windsurf");
    expect(l.verdict).toBe("wontLoad");
    expect(checkOk(l, "frontmatter-hygiene")).toBe(false);
  });

  it("a present bootloader whose router target is missing won't load", () => {
    write("CLAUDE.md", "RULE_ROUTER.md (pointer present, target absent)\n"); // no scaffoldCanon
    const l = loadabilityFor(ctx(), "claude");
    expect(l.verdict).toBe("wontLoad");
    expect(checkOk(l, "router-chain")).toBe(false);
  });

  it("an always-on bootloader with the chain intact loads", () => {
    scaffoldCanon();
    write("CLAUDE.md", "RULE_ROUTER.md\n");
    expect(loadabilityFor(ctx(), "claude").verdict).toBe("loads");
  });

  it("a workspace bootloader loads through workspace canon docs, not repo RULE_ROUTER", () => {
    scaffoldWorkspaceCanon();
    write("CLAUDE.md", "`ai-coding/cross-repo-architecture.md`\n`ai-coding/repo-discipline.md`\n");

    const l = loadabilityFor(ctx(), "claude");

    expect(l.verdict).toBe("loads");
    expect(checkOk(l, "router-chain")).toBe(true);
    expect(l.checks.find((c) => c.name === "router-chain")?.detail).toContain("workspace");
  });

  it("a workspace bootloader fails when a workspace canon target is missing", () => {
    scaffoldWorkspaceCanon();
    write("CLAUDE.md", "`ai-coding/cross-repo-architecture.md`\n");
    rmSync(join(dir, "ai-coding", "repo-discipline.md"));

    const l = loadabilityFor(ctx(), "claude");

    expect(l.verdict).toBe("wontLoad");
    expect(checkOk(l, "router-chain")).toBe(false);
    expect(l.checks.find((c) => c.name === "router-chain")?.detail).toContain("repo-discipline.md");
  });
});

describe("unverified (D0 — never claimed as loads or wontLoad)", () => {
  it("is unverified when no bootloader is on disk", () => {
    scaffoldCanon();
    expect(loadabilityFor(ctx(), "claude").verdict).toBe("unverified");
  });
});
