import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EccReconcileTransactionPayload,
  eccReconcileTransactionAction,
} from "../../src/ecc/reconcile-driver.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-reconcile-driver-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: root } }),
    env: { HOME: root },
    options: {},
  };
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

interface Fixture {
  targetRoot: string;
  cppPath: string;
  statePath: string;
  jsonPath: string;
  ledgerPath: string;
  before: Record<string, Buffer>;
  payload: EccReconcileTransactionPayload;
}

function fixture(): Fixture {
  const targetRoot = join(root, ".codex");
  const cppPath = join(targetRoot, "skills", "cpp-testing", "SKILL.md");
  const statePath = join(targetRoot, "ecc-install-state.json");
  const jsonPath = join(targetRoot, "settings.json");
  const ledgerPath = join(root, ".aih", "ecc", "registration-ledger.json");
  mkdirSync(join(cppPath, ".."), { recursive: true });
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  writeFileSync(cppPath, "cpp\n", "utf8");
  writeFileSync(statePath, '{"operations":["react","cpp"]}\n', "utf8");
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ managed: { cpp: true, react: true }, user: "keep" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(ledgerPath, '{"projects":["react","cpp"]}\n', "utf8");
  const before = Object.fromEntries(
    [cppPath, statePath, jsonPath, ledgerPath].map((path) => [path, readFileSync(path)]),
  );
  const payload: EccReconcileTransactionPayload = {
    reads: Object.entries(before).map(([path, contents]) => ({ path, sha256: sha256(contents) })),
    mutations: [
      { kind: "remove-file", path: cppPath, root: targetRoot },
      {
        kind: "remove-json-subset",
        path: jsonPath,
        root: targetRoot,
        payloads: [{ managed: { cpp: true } }],
      },
      {
        kind: "write-file",
        path: statePath,
        root: targetRoot,
        contents: '{"operations":["react"]}\n',
      },
    ],
    ledger: {
      path: ledgerPath,
      root,
      contents: '{"projects":["react"]}\n',
      mode: 0o600,
    },
  };
  return { targetRoot, cppPath, statePath, jsonPath, ledgerPath, before, payload };
}

function run(payload: EccReconcileTransactionPayload, env: NodeJS.ProcessEnv = {}) {
  const action = eccReconcileTransactionAction(ctx(), payload);
  const executable = action.argv[0];
  if (executable === undefined) throw new Error("missing ECC reconciliation driver executable");
  return spawnSync(executable, action.argv.slice(1), {
    cwd: action.cwd ?? root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function preload(contents: string): string {
  const path = join(root, `preload-${Math.random().toString(16).slice(2)}.cjs`);
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("ECC reconciliation transaction driver", () => {
  it("removes orphan files, preserves user JSON, writes target state, and commits the ledger last", () => {
    const value = fixture();
    const result = run(value.payload);

    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(value.cppPath)).toThrow();
    expect(readFileSync(value.statePath, "utf8")).toBe('{"operations":["react"]}\n');
    expect(JSON.parse(readFileSync(value.jsonPath, "utf8"))).toEqual({
      managed: { react: true },
      user: "keep",
    });
    expect(readFileSync(value.ledgerPath, "utf8")).toBe('{"projects":["react"]}\n');
    expect(readdirSync(value.targetRoot).some((name) => name.includes(".aih-ecc-prune."))).toBe(
      false,
    );
  });

  it("rolls every mutation back when the final ledger step fails", () => {
    const value = fixture();
    const hook = preload(
      [
        'const fs = require("node:fs");',
        "const rename = fs.renameSync;",
        "let calls = 0;",
        "fs.renameSync = (...args) => {",
        "  calls += 1;",
        "  if (calls === 6) {",
        '    const error = new Error("injected ledger failure");',
        '    error.code = "EIO";',
        "    throw error;",
        "  }",
        "  return rename(...args);",
        "};",
        "",
      ].join("\n"),
    );
    const result = run(value.payload, { NODE_OPTIONS: `--require=${hook}` });

    expect(result.status).not.toBe(0);
    for (const [path, contents] of Object.entries(value.before)) {
      expect(readFileSync(path)).toEqual(contents);
    }
  });

  it("fails before mutation when an input changes after planning", () => {
    const value = fixture();
    writeFileSync(value.cppPath, "changed after planning\n", "utf8");

    const result = run(value.payload);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ECC prune input changed after planning");
    expect(readFileSync(value.cppPath, "utf8")).toBe("changed after planning\n");
    expect(readFileSync(value.statePath)).toEqual(value.before[value.statePath]);
    expect(readFileSync(value.jsonPath)).toEqual(value.before[value.jsonPath]);
    expect(readFileSync(value.ledgerPath)).toEqual(value.before[value.ledgerPath]);
  });

  it("rejects a symlink substituted for a managed destination", () => {
    if (process.platform === "win32") return;
    const value = fixture();
    const outside = join(root, "user-owned.md");
    writeFileSync(outside, "cpp\n", "utf8");
    rmSync(value.cppPath);
    symlinkSync(outside, value.cppPath);

    const result = run(value.payload);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing symlinked ECC reconciliation path");
    expect(readFileSync(outside, "utf8")).toBe("cpp\n");
    expect(readFileSync(value.statePath)).toEqual(value.before[value.statePath]);
    expect(readFileSync(value.jsonPath)).toEqual(value.before[value.jsonPath]);
    expect(readFileSync(value.ledgerPath)).toEqual(value.before[value.ledgerPath]);
  });

  it("retries one transient rename and is byte-idempotent after replanning", () => {
    const value = fixture();
    const hook = preload(
      [
        'const fs = require("node:fs");',
        "const rename = fs.renameSync;",
        "let calls = 0;",
        "fs.renameSync = (...args) => {",
        "  if (calls++ === 0) {",
        '    const error = new Error("injected transient rename failure");',
        '    error.code = "EPERM";',
        "    throw error;",
        "  }",
        "  return rename(...args);",
        "};",
        "",
      ].join("\n"),
    );

    expect(run(value.payload, { NODE_OPTIONS: `--require=${hook}` }).status).toBe(0);
    const after = Object.fromEntries(
      [value.statePath, value.jsonPath, value.ledgerPath].map((path) => [path, readFileSync(path)]),
    );
    const second: EccReconcileTransactionPayload = {
      reads: Object.entries(after).map(([path, contents]) => ({ path, sha256: sha256(contents) })),
      mutations: [],
      ledger: {
        path: value.ledgerPath,
        root,
        contents: readFileSync(value.ledgerPath, "utf8"),
        mode: 0o600,
      },
    };
    expect(run(second).status).toBe(0);
    for (const [path, contents] of Object.entries(after)) {
      expect(readFileSync(path)).toEqual(contents);
    }
  });

  it("filters only Codex managed MCP and skill entries while preserving user content", () => {
    const codexRoot = join(root, ".codex");
    const configPath = join(codexRoot, "config.toml");
    const agentsPath = join(codexRoot, "AGENTS.md");
    const ledgerPath = join(root, ".aih", "ecc", "registration-ledger.json");
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(join(ledgerPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      [
        '[mcp_servers."user-owned"]',
        'url = "https://example.invalid"',
        "",
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."sequential-thinking"]',
        'command = "npx"',
        "",
        '[mcp_servers."github"]',
        'url = "https://api.githubcopilot.com/mcp/"',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      agentsPath,
      [
        "user preamble",
        "",
        "<!-- BEGIN ecc-codex:agents (generated from affaan-m/ECC .codex/AGENTS.md) -->",
        "## Skills Discovery",
        "",
        "Available skills:",
        "- coding-standards",
        "- cpp-testing",
        "- react-testing",
        "",
        "## External Action Boundaries",
        "",
        "boundary",
        "",
        "<!-- END ecc-codex:agents -->",
        "",
        "user suffix",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(ledgerPath, '{"projects":["react","cpp"]}\n', "utf8");
    const reads = [configPath, agentsPath, ledgerPath].map((path) => ({
      path,
      sha256: sha256(readFileSync(path)),
    }));
    const payload: EccReconcileTransactionPayload = {
      reads,
      mutations: [
        {
          kind: "filter-codex-mcp-block",
          path: configPath,
          root: codexRoot,
          keepNames: ["sequential-thinking"],
        },
        {
          kind: "filter-codex-agents-block",
          path: agentsPath,
          root: codexRoot,
          keepSkills: ["coding-standards", "react-testing"],
          removeBlock: false,
        },
      ],
      ledger: {
        path: ledgerPath,
        root,
        contents: '{"projects":["react"]}\n',
        mode: 0o600,
      },
    };

    const result = run(payload);

    expect(result.status, result.stderr).toBe(0);
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain('[mcp_servers."user-owned"]');
    expect(config).toContain('[mcp_servers."sequential-thinking"]');
    expect(config).not.toContain('[mcp_servers."github"]');
    const agents = readFileSync(agentsPath, "utf8");
    expect(agents).toContain("user preamble");
    expect(agents).toContain("user suffix");
    expect(agents).toContain("- coding-standards");
    expect(agents).toContain("- react-testing");
    expect(agents).not.toContain("- cpp-testing");
  });

  it("fails before mutation when a claimed Codex managed marker is malformed", () => {
    const codexRoot = join(root, ".codex");
    const configPath = join(codexRoot, "config.toml");
    const ledgerPath = join(root, ".aih", "ecc", "registration-ledger.json");
    mkdirSync(codexRoot, { recursive: true });
    mkdirSync(join(ledgerPath, ".."), { recursive: true });
    writeFileSync(configPath, "# >>> aih managed (mcp) >>>\nmissing end\n", "utf8");
    writeFileSync(ledgerPath, '{"projects":["react","cpp"]}\n', "utf8");
    const before = readFileSync(configPath);
    const payload: EccReconcileTransactionPayload = {
      reads: [configPath, ledgerPath].map((path) => ({
        path,
        sha256: sha256(readFileSync(path)),
      })),
      mutations: [
        {
          kind: "filter-codex-mcp-block",
          path: configPath,
          root: codexRoot,
          keepNames: [],
        },
      ],
      ledger: {
        path: ledgerPath,
        root,
        contents: '{"projects":["react"]}\n',
        mode: 0o600,
      },
    };

    expect(run(payload).status).not.toBe(0);
    expect(readFileSync(configPath)).toEqual(before);
    expect(readFileSync(ledgerPath, "utf8")).toBe('{"projects":["react","cpp"]}\n');
  });
});
