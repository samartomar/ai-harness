import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHARED_MARKER } from "../../src/bootstrap-ai/canon.js";
import { command as bootstrapCommand } from "../../src/bootstrap-ai/index.js";
import { command as doctorCommand } from "../../src/doctor.js";
import { command as guardrailsCommand } from "../../src/guardrails/index.js";
import { command as healCommand } from "../../src/heal/index.js";
import { beginLine, endLine } from "../../src/internals/markers.js";
import type { Action, Plan, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner, type RunResult } from "../../src/internals/proc.js";
import type { Check, CheckCode } from "../../src/internals/verify.js";
import { lintProbes } from "../../src/lint/run.js";
import { command as mcpCommand } from "../../src/mcp/index.js";
import type { Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as reportCommand } from "../../src/report/index.js";
import { mcpConfigSecretProbes, secretProbes } from "../../src/secrets/probes.js";
import { scanConfigSecrets, scanSecrets } from "../../src/secrets/scan.js";
import { command as usageCommand } from "../../src/usage/index.js";

/**
 * PR1 guardrail: every routable `fail`/`skip` emitter carries the `CheckCode` the
 * taxonomy assigns it (docs/research/check-code-taxonomy-plan.md). Codes are
 * asserted on the in-memory `Check` a probe returns — no clock/runner change, so
 * the suite stays deterministic. A reachability meta-test (bottom) proves every
 * union member is wired at a real emitter, the way `npm.trust-missing` would have
 * been caught for having none.
 */

const tmps: string[] = [];
function freshTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aih-code-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

interface CtxOpts {
  root: string;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  options?: Record<string, unknown>;
  platform?: Platform;
}
function makeCtx(o: CtxOpts): PlanContext {
  const run = o.run ?? fakeRunner(() => undefined);
  const env = o.env ?? {};
  return {
    root: o.root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: o.platform ?? "linux", run, env }),
    env,
    options: o.options ?? {},
  };
}

/** Run every probe in a plan and return the Checks (awaits async + captured probes alike). */
async function checksOf(plan: Plan, ctx: PlanContext): Promise<Check[]> {
  const out: Check[] = [];
  for (const a of plan.actions as Action[]) {
    if (a.kind === "probe") out.push(await a.run(ctx));
  }
  return out;
}
function codeOf(checks: Check[], namePart: string): CheckCode | undefined {
  return checks.find((c) => c.name.includes(namePart))?.code;
}

type ToolState = "ok" | "absent";
interface HealState {
  registry?: "ok" | "fail";
  pypi?: "ok" | "fail";
  node?: ToolState;
  npm?: ToolState;
  npx?: ToolState;
}
/** A runner that answers heal's TLS handshakes (by URL host) and tool --version checks. */
function healRunner(s: HealState): Runner {
  return fakeRunner((argv): Partial<RunResult> | undefined => {
    const cmd = argv[0] ?? "";
    const joined = argv.join(" ");
    if (cmd === "curl" || cmd === "powershell.exe" || cmd === "pwsh") {
      const m = joined.match(/https?:\/\/[^\s'"]+/);
      const host = m ? new URL(m[0]).hostname : "";
      if (host === "registry.npmjs.org")
        return (s.registry ?? "ok") === "fail"
          ? { code: 1, stderr: "SSL cert problem" }
          : { code: 0 };
      if (host === "pypi.org")
        return (s.pypi ?? "ok") === "fail" ? { code: 1, stderr: "SSL cert problem" } : { code: 0 };
    }
    const tool = cmd === "cmd" ? (argv[2] ?? "") : cmd;
    if (tool === "node")
      return (s.node ?? "ok") === "absent"
        ? { spawnError: true, code: 127 }
        : { code: 0, stdout: "v20.11.0" };
    if (tool === "npm")
      return (s.npm ?? "ok") === "absent"
        ? { spawnError: true, code: 127 }
        : { code: 0, stdout: "10.9.2" };
    if (tool === "npx")
      return (s.npx ?? "ok") === "absent"
        ? { spawnError: true, code: 127 }
        : { code: 0, stdout: "10.9.2" };
    return undefined;
  });
}

describe("Check.code — heal emitters", () => {
  it("tags TLS / CA / npm / PATH / MCP failures behind a broken proxy", async () => {
    const root = freshTmp();
    mkdirSync(join(root, ".local", "bin"), { recursive: true }); // exists but NOT on PATH
    write(root, ".mcp.json", JSON.stringify({ mcpServers: { x: { command: "npx" } } }));
    const env: NodeJS.ProcessEnv = { HOME: root, PATH: "/usr/bin" };
    const ctx = makeCtx({
      root,
      env,
      run: healRunner({ registry: "fail", pypi: "fail", node: "ok", npm: "absent", npx: "absent" }),
      options: { scope: "all", caPattern: "Zscaler" },
    });
    const checks = await checksOf(await healCommand.plan(ctx), ctx);

    expect(codeOf(checks, "TLS registry.npmjs.org")).toBe("tls.verify-failed");
    expect(codeOf(checks, "NODE_EXTRA_CA_CERTS")).toBe("cert.ca-missing");
    expect(codeOf(checks, "npm: runtime")).toBe("npm.runtime-broken");
    expect(codeOf(checks, "path: ~/.local/bin")).toBe("path.missing");
    expect(codeOf(checks, "npx launcher")).toBe("mcp.blocked");
  });

  it("tags an absent node runtime", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      env: { HOME: root, PATH: "/usr/bin" },
      run: healRunner({ node: "absent" }),
      options: { scope: "npm", caPattern: "Zscaler" },
    });
    expect(codeOf(await checksOf(await healCommand.plan(ctx), ctx), "node: runtime")).toBe(
      "env.node-runtime",
    );
  });

  it("tags a repo with no .mcp.json as config-missing (skip)", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      env: { HOME: root, PATH: "/usr/bin" },
      run: healRunner({}),
      options: { scope: "mcp", caPattern: "Zscaler" },
    });
    expect(codeOf(await checksOf(await healCommand.plan(ctx), ctx), "npx launcher")).toBe(
      "mcp.config-missing",
    );
  });

  it("leaves a passing check uncoded", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      env: { HOME: root, PATH: "/usr/bin" },
      run: healRunner({ registry: "ok", pypi: "ok" }),
      options: { scope: "all", caPattern: "Zscaler" },
    });
    const tls = (await checksOf(await healCommand.plan(ctx), ctx)).find((c) =>
      c.name.includes("TLS registry.npmjs.org"),
    );
    expect(tls?.verdict).toBe("pass");
    expect(tls?.code).toBeUndefined();
  });
});

describe("Check.code — bootstrap-ai emitters", () => {
  it("tags a missing bootloader, missing router, and undetected CLI", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      // HOME → the empty tmp so detectOne finds no `~/.claude` config dir and falls
      // through to the (spawn-erroring) PATH probe — i.e. claude reads as absent.
      env: { HOME: root },
      run: fakeRunner(() => ({ spawnError: true, code: 127 })),
      options: { cli: "claude" },
    });
    const checks = await checksOf(await bootstrapCommand.plan(ctx), ctx);
    expect(codeOf(checks, "RULE_ROUTER.md present")).toBe("canon.router-missing");
    expect(codeOf(checks, "bootloader CLAUDE.md in sync")).toBe("cli.bootloader-missing");
    expect(codeOf(checks, "claude installed")).toBe("cli.not-detected");
  });

  it("tags a drifted bootloader", async () => {
    const root = freshTmp();
    const drifted = `# Preamble\n\n${beginLine(SHARED_MARKER, "src")}\n\nOLD DRIFTED BODY\n\n${endLine(SHARED_MARKER)}\n`;
    write(root, "CLAUDE.md", drifted);
    const ctx = makeCtx({
      root,
      run: fakeRunner(() => ({ spawnError: true, code: 127 })),
      options: { cli: "claude" },
    });
    expect(
      codeOf(await checksOf(await bootstrapCommand.plan(ctx), ctx), "bootloader CLAUDE.md in sync"),
    ).toBe("cli.bootloader-drift");
  });
});

describe("Check.code — doctor emitters", () => {
  it("tags absent git, dev tools, and an unscaffolded context dir", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      run: fakeRunner((argv) => (argv[0] === "git" ? { spawnError: true, code: 127 } : undefined)),
    });
    const checks = await checksOf(await doctorCommand.plan(ctx), ctx);
    expect(codeOf(checks, "git")).toBe("env.git-missing");
    expect(codeOf(checks, "dev-tools")).toBe("env.dev-tool-missing");
    expect(codeOf(checks, "context-dir")).toBe("canon.context-dir-missing");
  });

  it("tags a stale committed repo contract", async () => {
    const root = freshTmp();
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "lib",
        scripts: { test: "vitest run", build: "tsc -p ." },
        devDependencies: { typescript: "^5", vitest: "^1" },
      }),
    );
    write(
      root,
      "ai-coding/project.json",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: [],
        languages: ["TypeScript/Node.js"],
        frameworks: [],
        cloud: [],
        databases: [],
        deployment: [],
        entrypoints: [],
        commands: { test: { value: "npm test", confidence: "detected" } },
        scale: { trackedFiles: 0, class: "small", isMonorepo: false },
        sensitivePaths: [],
        knownGaps: [],
      }),
    );
    const ctx = makeCtx({ root, options: { posture: "team" } });
    const checks = await checksOf(await doctorCommand.plan(ctx), ctx);

    expect(codeOf(checks, "contract truth")).toBe("contract.stale");
  });
});

describe("Check.code — mcp emitters", () => {
  it("tags absent uv and unvendored offline servers", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      run: fakeRunner((argv) => (argv[0] === "uv" ? { spawnError: true, code: 127 } : undefined)),
      options: { mode: "offline", scope: "project" },
    });
    const checks = await checksOf(await mcpCommand.plan(ctx), ctx);
    expect(codeOf(checks, "uv present")).toBe("mcp.uv-missing");
    expect(codeOf(checks, "vendored")).toBe("mcp.unvendored-offline");
  });
});

describe("Check.code — secrets / guardrails / usage / lint emitters", () => {
  it("tags a plaintext secret finding", async () => {
    const root = freshTmp();
    write(root, ".env", "API_KEY=abc123\n");
    const probe = secretProbes(scanSecrets(root), "team")[0];
    if (!probe) throw new Error("expected a secret probe");
    const check = await probe.run(makeCtx({ root }));
    expect(check.code).toBe("secrets.plaintext-detected");
  });

  it("tags a hardcoded secret in an MCP config file", async () => {
    const root = freshTmp();
    write(
      root,
      ".mcp.json",
      JSON.stringify({ mcpServers: { gh: { env: { GITHUB_TOKEN: `ghp_${"a".repeat(36)}` } } } }),
    );
    const probe = mcpConfigSecretProbes(scanConfigSecrets(root), "team")[0];
    if (!probe) throw new Error("expected a config-secret probe");
    const check = await probe.run(makeCtx({ root }));
    expect(check.code).toBe("mcp.hardcoded-secret");
  });

  it("tags a missing gitleaks binary", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      run: fakeRunner((argv) =>
        argv[0] === "gitleaks" ? { spawnError: true, code: 127 } : undefined,
      ),
    });
    expect(codeOf(await checksOf(await guardrailsCommand.plan(ctx), ctx), "gitleaks present")).toBe(
      "guardrails.gitleaks-missing",
    );
  });

  it("tags absent node and the not-yet-populated usage log", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      run: fakeRunner((argv) => (argv[0] === "node" ? { spawnError: true, code: 127 } : undefined)),
    });
    const checks = await checksOf(await usageCommand.plan(ctx), ctx);
    expect(codeOf(checks, "node")).toBe("env.node-runtime");
    expect(codeOf(checks, "usage-log")).toBe("usage.no-data");
  });

  it("tags a canon doc that fails the weak-model lint", async () => {
    const root = freshTmp();
    const [probe] = lintProbes(
      [{ path: "ai-coding/x.md", source: "# X\n\nTODO\n" }],
      new Set(),
      root,
    );
    if (probe?.kind !== "probe") throw new Error("expected a lint probe");
    const check = await probe.run(makeCtx({ root }));
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("canon.lint-failed");
  });
});

describe("Check.code — report emitters", () => {
  it("tags an over-budget footprint (advisory) and low adoption in an initialised repo", async () => {
    const root = freshTmp();
    write(root, "CLAUDE.md", "x".repeat(4000)); // ~1000 tok bootloader → over a tiny budget
    // The committed marker makes the repo "initialised", which gates the adoption nag.
    write(
      root,
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
    );
    const ctx = makeCtx({
      root,
      env: { HOME: root, USERPROFILE: root },
      options: { tokenBudget: "100" }, // over budget, no --gate → a non-gating skip advisory
    });
    const checks = await checksOf(await reportCommand.plan(ctx), ctx);
    expect(codeOf(checks, "context budget")).toBe("report.context-over-budget");
    expect(codeOf(checks, "adoption")).toBe("report.low-adoption");
    // advisories never fail the run — a bare `aih report` keeps exiting 0.
    expect(checks.every((c) => c.verdict !== "fail")).toBe(true);
  });
});

describe("Check.code — invariants", () => {
  it("unifies the three node emitters under one code", async () => {
    const healRoot = freshTmp();
    const healCtx = makeCtx({
      root: healRoot,
      env: { HOME: healRoot, PATH: "/usr/bin" },
      run: healRunner({ node: "absent" }),
      options: { scope: "npm", caPattern: "Zscaler" },
    });
    const healNode = codeOf(
      await checksOf(await healCommand.plan(healCtx), healCtx),
      "node: runtime",
    );

    const usageRoot = freshTmp();
    const usageCtx = makeCtx({
      root: usageRoot,
      run: fakeRunner((argv) => (argv[0] === "node" ? { spawnError: true, code: 127 } : undefined)),
    });
    const usageNode = codeOf(await checksOf(await usageCommand.plan(usageCtx), usageCtx), "node");

    expect(healNode).toBe("env.node-runtime");
    expect(usageNode).toBe("env.node-runtime");
    expect(healNode).toBe(usageNode);
  });

  it("wires every CheckCode union member to a real emitter (excl. verify.ts)", () => {
    // The Record forces this list to be EXHAUSTIVE over CheckCode: add a union
    // member and forget it here → TS compile error. Excluding verify.ts (whose
    // union declaration contains every literal) makes a missing emitter a real
    // failure — the check `npm.trust-missing` could never have passed.
    const present: Record<CheckCode, true> = {
      "env.node-runtime": true,
      "env.git-missing": true,
      "env.dev-tool-missing": true,
      "env.tool-install-blocked": true,
      "cert.ca-missing": true,
      "tls.verify-failed": true,
      "npm.runtime-broken": true,
      "path.missing": true,
      "mcp.blocked": true,
      "mcp.uv-missing": true,
      "mcp.config-missing": true,
      "mcp.unvendored-offline": true,
      "mcp.policy-denied": true,
      "mcp.hardcoded-secret": true,
      "mcp.allowlist-drift": true,
      "cli.not-detected": true,
      "cli.config-only": true,
      "cli.bootloader-missing": true,
      "cli.bootloader-drift": true,
      "cli.wont-load": true,
      "canon.router-missing": true,
      "canon.context-dir-missing": true,
      "canon.lint-failed": true,
      "canon.adoptable": true,
      "canon.cli-native-unmigrated": true,
      "secrets.plaintext-detected": true,
      "guardrails.gitleaks-missing": true,
      "usage.no-data": true,
      "scale.code-review-graph-missing": true,
      "contract.path-unportable": true,
      "contract.stale": true,
      "org-policy.drift": true,
      "org-policy.invalid": true,
      "org-policy.bundle-invalid": true,
      "report.context-over-budget": true,
      "report.low-adoption": true,
      "report.contract-untrue": true,
      "ready.blocked": true,
      "trust.fetch-blocked": true,
      "trust.detector-unavailable": true,
      "trust.hidden-unicode": true,
      "trust.prompt-injection": true,
      "trust.source-changed": true,
      "trust.auto-exec-hook": true,
      "trust.dependency-confusion": true,
      "trust.typosquat": true,
      "trust.malicious-code": true,
      "trust.source-drift": true,
      "trust.unpinned-dependency": true,
      "trust.untrusted-publisher": true,
      "trust.unsigned-source": true,
      "trust.license-missing": true,
      "trust.unapproved-skill": true,
      "pack.duplicate-name": true,
      "pack.pin-mismatch": true,
      "pack.missing-approval": true,
      "pack.unknown-manifest": true,
      "marketplace.manifest-parse": true,
      "marketplace.path-traversal": true,
      "marketplace.missing-file": true,
      "marketplace.checksum-mismatch": true,
      "marketplace.sums-coverage": true,
      "marketplace.unapproved-verdict": true,
      "marketplace.signature": true,
    };
    const srcDir = join(process.cwd(), "src");
    const src = (readdirSync(srcDir, { recursive: true }) as string[])
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith("internals/verify.ts"))
      .map((f) => readFileSync(join(srcDir, f), "utf8"))
      .join("\n");

    for (const code of Object.keys(present) as CheckCode[]) {
      expect(src.includes(`"${code}"`), `${code} must be set at an emitter in src/`).toBe(true);
    }
  });
});
