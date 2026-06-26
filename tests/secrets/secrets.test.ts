import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { reportToSarif } from "../../src/internals/sarif.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/secrets/index.js";
import { SECRET_RULE } from "../../src/secrets/probes.js";
import { scanSecrets } from "../../src/secrets/scan.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

/** Plant the mission fixture: real env files, an example, and a secrets bundle. */
function plantFixture(root: string): void {
  writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-real\n");
  writeFileSync(join(root, ".env.local"), "DB_PASSWORD=hunter2\n");
  writeFileSync(join(root, ".env.example"), "OPENAI_API_KEY=\n");
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "x"), "token\n");
}

function writes(actions: Action[]): WriteAction[] {
  return actions.filter((a): a is WriteAction => a.kind === "write");
}
function byPath(actions: Action[], path: string): WriteAction | undefined {
  return writes(actions).find((w) => w.path === path);
}

describe("scanSecrets", () => {
  it("detects .env and .env.local but NOT .env.example", () => {
    plantFixture(dir);
    const scan = scanSecrets(dir);
    expect(scan.envFiles).toContain(".env");
    expect(scan.envFiles).toContain(".env.local");
    expect(scan.envFiles).not.toContain(".env.example");
  });

  it("detects a secrets/ directory and unions it into matches", () => {
    plantFixture(dir);
    const scan = scanSecrets(dir);
    expect(scan.secretDirs).toContain("secrets");
    expect(scan.matches).toEqual([".env", ".env.local", "secrets"]);
  });

  it("excludes .env.sample as well as .env.example", () => {
    writeFileSync(join(dir, ".env.sample"), "X=\n");
    writeFileSync(join(dir, ".env.production"), "X=1\n");
    const scan = scanSecrets(dir);
    expect(scan.envFiles).toEqual([".env.production"]);
  });

  it("scans one level deep for nested .env, but flags secrets/ only at the root", () => {
    mkdirSync(join(dir, "packages", "api"), { recursive: true });
    writeFileSync(join(dir, "packages", ".env"), "A=1\n");
    mkdirSync(join(dir, "packages", "secrets"), { recursive: true });
    const scan = scanSecrets(dir);
    expect(scan.envFiles).toContain("packages/.env");
    // A nested dir named "secrets" is code (e.g. src/secrets), not a credential store.
    expect(scan.secretDirs).not.toContain("packages/secrets");
    // Two levels deep is out of scope (shallow + one level only).
    writeFileSync(join(dir, "packages", "api", ".env"), "B=2\n");
    expect(scanSecrets(dir).envFiles).not.toContain("packages/api/.env");
  });

  it("does NOT flag nested code directories named secrets (src/secrets, tests/secrets)", () => {
    mkdirSync(join(dir, "src", "secrets"), { recursive: true });
    mkdirSync(join(dir, "tests", "secrets"), { recursive: true });
    writeFileSync(join(dir, "src", "secrets", "index.ts"), "export {};\n");
    const scan = scanSecrets(dir);
    expect(scan.secretDirs).toEqual([]);
    expect(scan.matches).toEqual([]);
  });

  it("returns empty results for a clean repo", () => {
    const scan = scanSecrets(dir);
    expect(scan.matches).toEqual([]);
  });

  it("flags a .env nested inside secrets/ without double-counting the dir", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", ".env"), "K=v\n");
    const scan = scanSecrets(dir);
    // The dir and the nested file are distinct, deduped entries.
    expect(scan.secretDirs).toEqual(["secrets"]);
    expect(scan.envFiles).toEqual(["secrets/.env"]);
    expect(scan.matches).toEqual(["secrets", "secrets/.env"]);
  });
});

describe("secrets command", () => {
  it("exposes the secrets command name", () => {
    expect(command.name).toBe("secrets");
  });

  it("dry-run plans the settings deny merge with both deny rules", async () => {
    const p = await command.plan(ctx());
    const settings = byPath(p.actions, ".claude/settings.json");
    expect(settings?.merge).toBe(true);
    expect(settings?.json).toEqual({
      permissions: { deny: ["Read(./.env*)", "Read(./secrets/**)"] },
    });
  });

  it("writes a .claudeignore listing .env* and secrets/ with an example allow-list", async () => {
    const p = await command.plan(ctx());
    const ignore = byPath(p.actions, ".claudeignore");
    expect(ignore?.contents).toContain(".env");
    expect(ignore?.contents).toContain(".env.*");
    expect(ignore?.contents).toContain("secrets/");
    expect(ignore?.contents).toContain("!.env.example");
    // Allow-list mirrors the scan's example/sample exclusion — both stay visible.
    expect(ignore?.contents).toContain("!.env.sample");
    expect(ignore?.contents).toContain("**/secrets/");
    expect(ignore?.contents?.endsWith("\n")).toBe(true);
  });

  it("emits vault guidance as a doc (cloud is doc, not write/exec/probe)", async () => {
    const p = await command.plan(ctx());
    const docs = p.actions.filter((a) => a.kind === "doc");
    const guidance = docs.find((d) =>
      d.kind === "doc" ? d.describe.startsWith("Dynamic vault injection") : false,
    );
    expect(guidance?.kind).toBe("doc");
    if (guidance?.kind === "doc") {
      expect(guidance.text).toContain("HashiCorp Vault");
      expect(guidance.text).toContain("AWS Secrets Manager");
      expect(guidance.text).toContain("1Password");
      expect(guidance.text).toContain("op run");
    }
  });

  it("never produces exec actions (boundary: no local or remote command execution)", async () => {
    plantFixture(dir);
    const p = await command.plan(ctx());
    // The hard guarantee is no `exec`: secrets never spawns a process. Probes ARE
    // allowed — they are read-only verdict carriers (the secret-scan gate), not
    // mutations; their behavior is asserted in the "--verify gate" block below.
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("routes the vault guidance to a custom contextDir", async () => {
    const p = await command.plan(ctx({ contextDir: ".enterprise-ai" }));
    const guidance = p.actions.find(
      (a) => a.kind === "doc" && a.describe.startsWith("Dynamic vault injection"),
    );
    if (guidance?.kind === "doc") {
      expect(guidance.text).toContain(".enterprise-ai");
    } else {
      throw new Error("expected vault guidance doc");
    }
  });

  it("adds an exposure-warning doc listing detected plaintext files", async () => {
    plantFixture(dir);
    const p = await command.plan(ctx());
    const warning = p.actions.find(
      (a) => a.kind === "doc" && a.describe.startsWith("Plaintext secrets detected"),
    );
    expect(warning?.kind).toBe("doc");
    if (warning?.kind === "doc") {
      expect(warning.describe).toContain("(3)");
      expect(warning.text).toContain(".env");
      expect(warning.text).toContain(".env.local");
      expect(warning.text).toContain("secrets");
      expect(warning.text).toContain("rotate");
    }
  });

  it("omits the exposure warning when no plaintext secrets exist", async () => {
    const p = await command.plan(ctx());
    const warning = p.actions.find(
      (a) => a.kind === "doc" && a.describe.startsWith("Plaintext secrets detected"),
    );
    expect(warning).toBeUndefined();
  });

  it("is idempotent — same plan shape across repeated runs", async () => {
    const a = await command.plan(ctx());
    const b = await command.plan(ctx());
    const shape = (p: typeof a) => p.actions.map((x) => `${x.kind}:${x.describe}`);
    expect(shape(a)).toEqual(shape(b));
  });
});

describe("secrets executor integration", () => {
  it("merge preserves a pre-existing .claude/settings.json key", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ model: "claude-opus-4-8", permissions: { deny: ["Read(./private/**)"] } }),
    );

    const result = await executePlan(
      await command.plan(ctx({ apply: true })),
      ctx({ apply: true }),
    );
    const settingsWrite = result.writes.find((w) => w.path === ".claude/settings.json");
    expect(settingsWrite?.effect).toBe("merge");

    const merged = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    // Pre-existing top-level key survives.
    expect(merged.model).toBe("claude-opus-4-8");
    // Pre-existing deny entry survives AND the new ones are unioned in.
    expect(merged.permissions.deny).toEqual([
      "Read(./private/**)",
      "Read(./.env*)",
      "Read(./secrets/**)",
    ]);
  });

  it("apply writes .claudeignore to disk and applies the plan", async () => {
    const result = await executePlan(
      await command.plan(ctx({ apply: true })),
      ctx({ apply: true }),
    );
    expect(result.applied).toBe(true);
    const ignore = readFileSync(join(dir, ".claudeignore"), "utf8");
    expect(ignore).toContain("secrets/");
  });

  it("BOUNDARY: vault guidance stays print-only — no cloud script lands on disk under --apply", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ apply: true })),
      ctx({ apply: true }),
    );
    // Cloud guidance is doc-only: every doc this plan emits has no `path`, so the
    // executor never materializes a vault-contacting preflight script.
    expect(result.docs.length).toBeGreaterThan(0);
    for (const d of result.docs) {
      expect(d.path).toBeUndefined();
    }
    // Nothing the executor wrote is an executable preflight / vault hook.
    for (const w of result.writes) {
      expect(w.path).not.toContain("preflight");
    }
    expect(existsSync(join(dir, "aih-secrets-preflight.sh"))).toBe(false);
  });

  it("BOUNDARY: apply runs zero exec actions (no local or remote command execution)", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ apply: true })),
      ctx({ apply: true }),
    );
    expect(result.execs).toEqual([]);
  });
});

describe("secrets --verify gate", () => {
  it("plans one read-only probe per detected plaintext secret", async () => {
    plantFixture(dir);
    const matches = scanSecrets(dir).matches; // .env, .env.local, secrets
    const p = await command.plan(ctx());
    const probes = p.actions.filter((a) => a.kind === "probe");
    expect(probes).toHaveLength(matches.length);
    expect(matches).toHaveLength(3);
  });

  it("plans no probe for a clean repo (green gate)", async () => {
    const p = await command.plan(ctx());
    expect(p.actions.some((a) => a.kind === "probe")).toBe(false);
  });

  it("each secret yields a fail verdict that flips the gate exit code", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ verify: true })),
      ctx({ verify: true }),
    );
    const report = result.report;
    if (!report) throw new Error("expected a verification report under --verify");
    const fails = report.checks.filter((c) => c.verdict === "fail");
    expect(fails).toHaveLength(3);
    // Stable rule id (one SARIF rule) + distinct per-path detail (distinct results).
    expect(fails.every((c) => c.name === SECRET_RULE)).toBe(true);
    const details = fails.map((c) => c.detail ?? "").join("\n");
    expect(details).toContain(".env");
    expect(details).toContain(".env.local");
    expect(details).toContain("secrets");
    expect(details).toContain("rotate");
    expect(report.ok).toBe(false);
    expect(report.exitCode()).toBe(1);
  });

  it("emits one error-level SARIF result per secret under a single plaintext-secret rule", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ verify: true })),
      ctx({ verify: true }),
    );
    if (!result.report) throw new Error("expected a verification report under --verify");
    const sarif = JSON.parse(reportToSarif(result.report));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    // One rule groups every exposure (deduped by name), matching the drift-gate shape.
    expect(ruleIds).toContain(SECRET_RULE);
    const errors = sarif.runs[0].results.filter((r: { level: string }) => r.level === "error");
    expect(errors).toHaveLength(3);
    expect(errors.every((r: { ruleId: string }) => r.ruleId === SECRET_RULE)).toBe(true);
  });

  it("renders a clean (green) report — no fail checks — when no plaintext secrets exist", async () => {
    const result = await executePlan(
      await command.plan(ctx({ verify: true })),
      ctx({ verify: true }),
    );
    const fails = (result.report?.checks ?? []).filter((c) => c.verdict === "fail");
    expect(fails).toEqual([]);
    expect(result.report?.ok ?? true).toBe(true);
    expect(result.report?.exitCode() ?? 0).toBe(0);
  });
});
