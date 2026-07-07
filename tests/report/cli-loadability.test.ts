import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_REGISTRY, type CliEntry } from "../../src/internals/cli-registry.js";
import { LOADABILITY_SENTINEL } from "../../src/internals/loadability-sentinel.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadabilityFor, loadabilityForWithDryRun } from "../../src/report/cli-loadability.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-load-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function ctx(runHandler: Parameters<typeof fakeRunner>[0] = () => undefined): PlanContext {
  const run = fakeRunner(runHandler);
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
  write("ai-coding/RULE_ROUTER.md", `# router\n${LOADABILITY_SENTINEL}\n`);
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

async function withClaudeDryRunProbe<T>(
  dryRunProbe: CliEntry["dryRunProbe"],
  run: () => Promise<T>,
): Promise<T> {
  const claude = CLI_REGISTRY.claude;
  if (!claude) throw new Error("claude registry entry missing");
  const original = claude.dryRunProbe;
  claude.dryRunProbe = dryRunProbe;
  try {
    return await run();
  } finally {
    claude.dryRunProbe = original;
  }
}

describe("activation frontmatter", () => {
  it("cursor .mdc with alwaysApply:true is structurally valid but runtime-unverified", () => {
    scaffoldCanon();
    write(".cursor/rules/00-canon.mdc", "---\nalwaysApply: true\n---\nRULE_ROUTER.md\n");
    const l = loadabilityFor(ctx(), "cursor");
    expect(l.verdict).toBe("unverified");
    expect(checkOk(l, "activation")).toBe(true);
    expect(checkOk(l, "dry-run-probe")).toBeUndefined();
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

  it("kiro steering with inclusion:always is structurally valid but runtime-unverified", () => {
    scaffoldCanon();
    write(".kiro/steering/00-canon.md", "---\ninclusion: always\n---\nRULE_ROUTER.md\n");
    expect(loadabilityFor(ctx(), "kiro").verdict).toBe("unverified");
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

  it("an always-on bootloader with the chain intact is runtime-unverified without a probe", () => {
    scaffoldCanon();
    write("CLAUDE.md", "RULE_ROUTER.md\n");
    const l = loadabilityFor(ctx(), "claude");
    expect(l.verdict).toBe("unverified");
    expect(checkOk(l, "dry-run-probe")).toBeUndefined();
  });

  it("a workspace bootloader structurally resolves through workspace canon docs", () => {
    scaffoldWorkspaceCanon();
    write("CLAUDE.md", "`ai-coding/cross-repo-architecture.md`\n`ai-coding/repo-discipline.md`\n");

    const l = loadabilityFor(ctx(), "claude");

    expect(l.verdict).toBe("unverified");
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

describe("Tier-2 dry-run canary", () => {
  it("promotes a structural pass to loads when the resolved context prints the sentinel", async () => {
    await withClaudeDryRunProbe({ kind: "command", argv: ["dump-context"] }, async () => {
      scaffoldCanon();
      write("CLAUDE.md", "RULE_ROUTER.md\n");
      const l = await loadabilityForWithDryRun(
        ctx((argv, opts) => {
          expect(argv).toEqual(["dump-context"]);
          expect(opts?.cwd).toBe(dir);
          return { stdout: `context\n${LOADABILITY_SENTINEL}\n` };
        }),
        "claude",
      );

      expect(l.verdict).toBe("loads");
      expect(checkOk(l, "dry-run-probe")).toBe(true);
    });
  });

  it("fails closed when a registered context dump runs but omits the sentinel", async () => {
    await withClaudeDryRunProbe({ kind: "command", argv: ["dump-context"] }, async () => {
      scaffoldCanon();
      write("CLAUDE.md", "RULE_ROUTER.md\n");
      const l = await loadabilityForWithDryRun(
        ctx(() => ({ stdout: "context without canary" })),
        "claude",
      );

      expect(l.verdict).toBe("wontLoad");
      expect(checkOk(l, "dry-run-probe")).toBe(false);
    });
  });

  it("keeps a registered probe unverified when the command cannot run", async () => {
    await withClaudeDryRunProbe({ kind: "command", argv: ["dump-context"] }, async () => {
      scaffoldCanon();
      write("CLAUDE.md", "RULE_ROUTER.md\n");
      const l = await loadabilityForWithDryRun(
        ctx(() => ({ code: 127, stderr: "not found", spawnError: true })),
        "claude",
      );

      expect(l.verdict).toBe("unverified");
      expect(checkOk(l, "dry-run-probe")).toBeUndefined();
      expect(l.checks.find((c) => c.name === "dry-run-probe")?.detail).toContain(
        "spawn failed or timed out",
      );
      expect(l.checks.find((c) => c.name === "dry-run-probe")?.detail).not.toContain("not found");
    });
  });
});
