import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { reportToSarif } from "../../src/internals/sarif.js";
import { acceptChanged } from "../../src/internals/scan-allowlist.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/secrets/index.js";
import { SECRET_RULE } from "../../src/secrets/probes.js";
import { scanConfigSecrets, scanExternalConfigSecrets, scanSecrets } from "../../src/secrets/scan.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const env = { HOME: dir, USERPROFILE: dir, ...(over.env ?? {}) };
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
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

  it("--since-style scans flag root secrets/ when Git reports a changed child", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "token.txt"), "token\n");
    const scan = scanSecrets(dir, {
      accept: acceptChanged(undefined, new Set(["secrets/token.txt"])),
    });
    expect(scan.secretDirs).toEqual(["secrets"]);
    expect(scan.matches).toEqual(["secrets"]);
  });

  it("does not follow symlinked first-level directories outside the repo", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-secrets-outside-"));
    try {
      writeFileSync(join(outside, ".env"), "TOKEN=outside\n");
      symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(outside, join(dir, "secrets"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }

    const scan = scanSecrets(dir);
    rmSync(outside, { recursive: true, force: true });

    expect(scan.envFiles).not.toContain("linked/.env");
    expect(scan.secretDirs).toEqual([]);
    expect(scan.matches).toEqual([]);
  });
});

describe("scanConfigSecrets", () => {
  it("flags a provider token hardcoded in .mcp.json", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { gh: { command: "x", env: { GITHUB_TOKEN: `ghp_${"a".repeat(36)}` } } },
      }),
    );
    const hits = scanConfigSecrets(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(".mcp.json");
    expect(hits[0]?.kind).toContain("github");
  });

  it("does not flag short GitHub-like strings as provider tokens", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          labels: {
            env: {
              SHORT_CLASSIC: `ghp_${"a".repeat(10)}`,
              SHORT_FINE_GRAINED: `github_pat_${"b".repeat(12)}`,
            },
          },
        },
      }),
    );

    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("does NOT flag an env-var placeholder (the sanctioned form)", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${VAR} placeholder is the value under test
      JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } } }),
    );
    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("flags a literal value under a secret-looking key", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { db: { env: { API_KEY: "abcd1234efgh5678" } } } }),
    );
    const hits = scanConfigSecrets(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("API_KEY");
  });

  it("flags a literal value under a secret-looking key in JSONC MCP config", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      '{\n  // supported JSONC\n  "mcpServers": { "db": { "env": { "API_KEY": "abcd1234efgh5678", }, }, }\n}\n',
    );
    const hits = scanConfigSecrets(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("API_KEY");
  });

  it("flags a literal value under a secret-looking key in malformed MCP JSON", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      '{"mcpServers":{"db":{"env":{"API_KEY":"abcd1234efgh5678"',
    );
    const hits = scanConfigSecrets(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("API_KEY");
    expect(JSON.stringify(hits)).not.toContain("abcd1234efgh5678");
  });

  it("does NOT flag path-designating keys holding path-shaped values", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: {
            env: {
              GITHUB_TOKEN_FILE: "/run/secrets/github-token",
              AWS_ACCESS_KEY_PATH: "C:\\Users\\svc\\aws\\access-key",
              CREDENTIAL_DIR: "\\\\fileserver\\vault\\creds",
            },
          },
        },
      }),
    );
    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("still flags a secret-shaped value under a path-designating key", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { db: { env: { API_KEY_PATH: "hunter2-hunter2-hunter2" } } },
      }),
    );
    const hits = scanConfigSecrets(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("API_KEY_PATH");
  });

  it("does NOT flag path-valued path keys in an external TOML config (raw fallback)", () => {
    const abs = join(dir, "config.toml");
    writeFileSync(
      abs,
      'NODE_REPL_NODE_PATH = "C:\\Program Files\\nodejs\\node.exe"\n' +
        'NODE_REPL_TRUSTED_CODE_PATHS = "C:\\dev\\trusted"\n' +
        'CODEX_CLI_PATH = "/usr/local/bin/codex"\n',
    );
    expect(scanExternalConfigSecrets([{ file: "~/.codex/config.toml", absPath: abs }])).toEqual([]);
  });

  it("still flags a secret-shaped value under a path key in the raw fallback", () => {
    const abs = join(dir, "config.toml");
    writeFileSync(abs, 'API_KEY_PATH = "hunter2-hunter2-hunter2"\n');
    const hits = scanExternalConfigSecrets([{ file: "~/.codex/config.toml", absPath: abs }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("API_KEY_PATH");
  });

  it("does not follow symlinked MCP config paths outside the repo", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "aih-mcp-outside-")), "mcp.json");
    try {
      writeFileSync(
        outside,
        JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: `ghp_${"a".repeat(36)}` } } } }),
      );
      symlinkSync(outside, join(dir, ".mcp.json"), "file");
    } catch {
      rmSync(dirname(outside), { recursive: true, force: true });
      return;
    }
    const hits = scanConfigSecrets(dir);
    rmSync(dirname(outside), { recursive: true, force: true });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      file: ".mcp.json",
      key: "",
      code: "mcp.config-invalid",
    });
    expect(JSON.stringify(hits)).not.toContain("github");
  });

  it("flags a literal Authorization bearer header", () => {
    const literal = "Bearer pasted-token-value";
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { gh: { headers: { Authorization: literal } } } }),
    );
    const hits = scanConfigSecrets(dir);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("Authorization");
    expect(hits[0]?.kind).toContain("authorization bearer");
    expect(JSON.stringify(hits)).not.toContain(literal);
  });

  it("does NOT flag an Authorization bearer env placeholder", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: { headers: { Authorization: "Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        },
      }),
    );

    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("scans Kiro MCP config for a literal Authorization bearer header", () => {
    mkdirSync(join(dir, ".kiro", "settings"), { recursive: true });
    writeFileSync(
      join(dir, ".kiro", "settings", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: { headers: { Authorization: "Bearer pasted-token-value" } },
        },
      }),
    );
    const hits = scanConfigSecrets(dir);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(".kiro/settings/mcp.json");
    expect(hits[0]?.kind).toContain("authorization bearer");
    expect(JSON.stringify(hits)).not.toContain("pasted-token-value");
  });

  it("scans known global MCP configs for redacted secret literals", async () => {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), 'api_key = "abcd1234efgh5678"\n');

    const p = await command.plan(ctx());
    const warning = p.actions.find(
      (a) => a.kind === "doc" && a.describe.startsWith("MCP config secret-scan findings"),
    );

    expect(warning?.kind === "doc" ? warning.text : "").toContain("~/.codex/config.toml");
    expect(JSON.stringify(p.actions)).not.toContain("abcd1234efgh5678");
  });

  it("allows Kiro MCP Authorization bearer env placeholders", () => {
    mkdirSync(join(dir, ".kiro", "settings"), { recursive: true });
    writeFileSync(
      join(dir, ".kiro", "settings", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          gh: { headers: { Authorization: "Bearer $" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        },
      }),
    );

    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("flags a literal Authorization bearer header in malformed MCP JSON", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      '{"mcpServers":{"gh":{"headers":{"Authorization":"Bearer pasted-token-value"}}',
    );
    const hits = scanConfigSecrets(dir);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(".mcp.json");
    expect(hits[0]?.key).toBe("");
    expect(hits[0]?.kind).toContain("authorization bearer");
    expect(JSON.stringify(hits)).not.toContain("pasted-token-value");
  });

  it("flags a literal Authorization bearer header ending at EOF in malformed MCP JSON", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      '{"mcpServers":{"gh":{"headers":{"Authorization":"Bearer pasted-token-value',
    );
    const hits = scanConfigSecrets(dir);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.file).toBe(".mcp.json");
    expect(hits[0]?.kind).toContain("authorization bearer");
    expect(JSON.stringify(hits)).not.toContain("pasted-token-value");
  });

  it("allows malformed MCP JSON when the bearer header is an env placeholder", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      '{"mcpServers":{"gh":{"headers":{"Authorization":"Bearer $' +
        '{GITHUB_PERSONAL_ACCESS_TOKEN}"}}',
    );

    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("returns nothing for a clean / absent config", () => {
    expect(scanConfigSecrets(dir)).toEqual([]);
  });

  it("never emits the secret value itself, only file/key/kind", () => {
    const token = `ghp_${"b".repeat(36)}`;
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { gh: { env: { TOKEN: token } } } }),
    );
    expect(JSON.stringify(scanConfigSecrets(dir))).not.toContain(token);
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

  it("gates the Claude deny-files on the target set, but keeps vault guidance + probes", async () => {
    plantFixture(dir);
    // Under init with a non-claude target set: no `.claude/settings.json`, no
    // `.claudeignore` — those are Claude-specific. The tool-agnostic vault guidance
    // doc and the per-secret `--verify` probes still run (gitleaks is the real gate).
    const gated = await command.plan({ ...ctx({ verify: true }), targets: ["kiro"] });
    expect(byPath(gated.actions, ".claude/settings.json")).toBeUndefined();
    expect(byPath(gated.actions, ".claudeignore")).toBeUndefined();
    expect(
      gated.actions.some(
        (a) => a.kind === "doc" && a.describe.startsWith("Dynamic vault injection"),
      ),
    ).toBe(true);
    expect(gated.actions.some((a) => a.kind === "probe")).toBe(true);
    // With claude among the targets, the deny files return.
    const targeted = await command.plan({ ...ctx(), targets: ["claude", "kiro"] });
    expect(byPath(targeted.actions, ".claude/settings.json")).toBeDefined();
    expect(byPath(targeted.actions, ".claudeignore")).toBeDefined();
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

  it("labels unsafe MCP config paths as config-scan findings, not hardcoded secrets", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "aih-mcp-outside-")), "mcp.json");
    try {
      writeFileSync(
        outside,
        JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: `ghp_${"a".repeat(36)}` } } } }),
      );
      symlinkSync(outside, join(dir, ".mcp.json"), "file");
    } catch {
      rmSync(dirname(outside), { recursive: true, force: true });
      return;
    }

    const p = await command.plan(ctx({ verify: true, posture: "team" }));
    rmSync(dirname(outside), { recursive: true, force: true });
    const warning = p.actions.find(
      (a) => a.kind === "doc" && a.describe.startsWith("MCP config secret-scan findings"),
    );
    const probes = p.actions.filter((a) => a.kind === "probe");

    expect(warning?.kind).toBe("doc");
    if (warning?.kind === "doc") {
      expect(warning.text).toContain("mcp.config-invalid");
      expect(warning.text).toContain("unsafe config paths");
      expect(warning.text).not.toContain("github");
    }
    expect(probes.map((probe) => probe.describe)).toContain("MCP config finding: .mcp.json");
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
      await command.plan(ctx({ verify: true, posture: "team" })),
      ctx({ verify: true, posture: "team" }),
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

  it("keeps plaintext findings warning-only at the default vibe posture", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ verify: true })),
      ctx({ verify: true }),
    );
    const checks = result.report?.checks ?? [];
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.verdict === "pass")).toBe(true);
    expect(checks.every((c) => c.detail?.includes("warning-only"))).toBe(true);
    expect(result.report?.exitCode()).toBe(0);
  });

  it("emits one error-level SARIF result per secret under a single plaintext-secret rule", async () => {
    plantFixture(dir);
    const result = await executePlan(
      await command.plan(ctx({ verify: true, posture: "enterprise" })),
      ctx({ verify: true, posture: "enterprise" }),
    );
    if (!result.report) throw new Error("expected a verification report under --verify");
    const sarif = JSON.parse(reportToSarif(result.report));
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    // One rule groups every exposure (deduped by name), matching the drift-gate shape.
    expect(ruleIds).toContain(SECRET_RULE);
    const errors = sarif.runs[0].results.filter((r: { level: string }) => r.level === "error");
    expect(errors).toHaveLength(3);
    expect(errors.every((r: { ruleId: string }) => r.ruleId === SECRET_RULE)).toBe(true);
    const uris = errors
      .map(
        (r: { locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }) =>
          r.locations[0]?.physicalLocation.artifactLocation.uri,
      )
      .sort();
    expect(uris).toEqual([".env", ".env.local", "secrets"]);
    expect(
      errors.every(
        (r: { partialFingerprints?: Record<string, string> }) => r.partialFingerprints?.["aih/v1"],
      ),
    ).toBe(true);
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
