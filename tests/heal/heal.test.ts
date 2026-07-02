import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTool, versionArgv } from "../../src/heal/common.js";
import { command } from "../../src/heal/index.js";
import { parseScope } from "../../src/heal/phases.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { HostAdapter, Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBExampleCorporateRootCA\n-----END CERTIFICATE-----\n";

type State = "ok" | "fail" | "absent";

interface Scenario {
  platform?: Platform;
  registry?: State;
  pypi?: State;
  node?: State;
  npm?: State;
  npx?: State;
  /** "valid" PEM on disk | "missing" path | "bad" non-PEM file | "unset" (no env) */
  ca?: "valid" | "missing" | "bad" | "unset";
  binOnDisk?: boolean;
  binOnPath?: boolean;
  mcpJson?: string | false;
  npmCli?: string;
  scope?: string;
  apply?: boolean;
  root: string;
}

function tlsResult(s: State): Partial<RunResult> {
  if (s === "absent") return { spawnError: true, code: 127 };
  if (s === "fail")
    return { code: 1, stderr: "SSL certificate problem: self signed certificate in chain" };
  return { code: 0 };
}

function toolResult(s: State, version: string): Partial<RunResult> {
  if (s === "absent") return { spawnError: true, code: 127, stderr: "not found" };
  if (s === "fail") return { code: 1, stderr: "Error: Cannot find module 'fs-minipass'" };
  return { code: 0, stdout: version };
}

/** A runner that answers TLS probes (by URL) and node/npm/npx version checks. */
function runnerFor(sc: Scenario) {
  return fakeRunner((argv) => {
    const cmd = argv[0] ?? "";
    const joined = argv.join(" ");
    const isTls = cmd === "curl" || cmd === "powershell.exe" || cmd === "pwsh";
    if (isTls) {
      // Extract the probed URL and match its host EXACTLY (parse, don't substring —
      // avoids CodeQL's incomplete-url-substring-sanitization antipattern).
      const m = joined.match(/https?:\/\/[^\s'"]+/);
      const host = m ? new URL(m[0]).hostname : "";
      if (host === "registry.npmjs.org") return tlsResult(sc.registry ?? "ok");
      if (host === "pypi.org") return tlsResult(sc.pypi ?? "ok");
    }
    // node/npm/npx run directly on POSIX, or via `cmd /c <tool> --version` on Windows.
    const tool = cmd === "cmd" ? (argv[2] ?? "") : cmd;
    if (tool === "node") return toolResult(sc.node ?? "ok", "v20.11.0");
    if (tool === "npm") return toolResult(sc.npm ?? "ok", "10.9.2");
    if (tool === "npx") return toolResult(sc.npx ?? "ok", "10.9.2");
    return undefined;
  });
}

function envFor(sc: Scenario): NodeJS.ProcessEnv {
  const win = sc.platform === "windows";
  const home = sc.root;
  const env: NodeJS.ProcessEnv = win ? { USERPROFILE: home } : { HOME: home };
  // Certificate env var.
  if (sc.ca === "valid") {
    const p = join(sc.root, "ca.pem");
    writeFileSync(p, PEM, "utf8");
    env.NODE_EXTRA_CA_CERTS = p;
  } else if (sc.ca === "missing") {
    env.NODE_EXTRA_CA_CERTS = join(sc.root, "nope.pem");
  } else if (sc.ca === "bad") {
    const p = join(sc.root, "bad.pem");
    writeFileSync(p, "not a certificate\n", "utf8");
    env.NODE_EXTRA_CA_CERTS = p;
  } // "unset" / undefined → leave absent
  // PATH (with the user-bin dir present or not).
  const bin = join(home, ".local", "bin");
  if (sc.binOnDisk) mkdirSync(bin, { recursive: true });
  const sep = win ? ";" : ":";
  const entries = ["/usr/bin"];
  if (sc.binOnPath) entries.push(bin);
  const pathVal = entries.join(sep);
  if (win) env.Path = pathVal;
  else env.PATH = pathVal;
  return env;
}

function hostFor(sc: Scenario, env: NodeJS.ProcessEnv): HostAdapter {
  const base = makeHostAdapter({ platform: sc.platform ?? "linux", run: runnerFor(sc), env });
  if (sc.npmCli === undefined) return base;
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "npmCliPath") return () => sc.npmCli;
      return Reflect.get(t, p, r);
    },
  });
}

function makeCtx(sc: Scenario): PlanContext {
  const env = envFor(sc);
  if (sc.mcpJson !== false && sc.mcpJson !== undefined) {
    writeFileSync(join(sc.root, ".mcp.json"), sc.mcpJson, "utf8");
  }
  const options: Record<string, unknown> = { caPattern: "Zscaler" };
  if (sc.scope !== undefined) options.scope = sc.scope;
  return {
    root: sc.root,
    contextDir: "ai-coding",
    apply: sc.apply ?? false,
    verify: true,
    json: false,
    run: runnerFor(sc),
    host: hostFor(sc, env),
    env,
    options,
  };
}

const dirs: string[] = [];
function freshTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aih-heal-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function findCheck(actions: Action[], namePart: string): Check | undefined {
  for (const a of actions) {
    if (a.kind === "probe") {
      const c = a.run({} as PlanContext) as Check; // captured probes ignore ctx
      if (c.name.includes(namePart)) return c;
    }
  }
  return undefined;
}
function findDigest(actions: Action[], part: string) {
  return actions.find(
    (a): a is Extract<Action, { kind: "digest" }> =>
      a.kind === "digest" && a.describe.includes(part),
  );
}
function execs(actions: Action[]) {
  return actions.filter((a): a is Extract<Action, { kind: "exec" }> => a.kind === "exec");
}

describe("heal — command surface", () => {
  it("is a diagnose-by-default capability with the documented options", () => {
    expect(command.name).toBe("heal");
    expect(command.alwaysVerify).toBe(true);
    expect(command.readOnly).toBeUndefined();
    const flags = (command.options ?? []).map((o) => o.flags);
    expect(flags).toContain("--scope <list>");
    expect(flags).toContain("--ca-pattern <pattern>");
  });
});

describe("heal — parseScope", () => {
  it("treats absent / empty / 'all' as every step", () => {
    expect(parseScope(undefined)).toEqual(["certs", "npm", "path", "mcp"]);
    expect(parseScope("")).toEqual(["certs", "npm", "path", "mcp"]);
    expect(parseScope("all")).toEqual(["certs", "npm", "path", "mcp"]);
  });
  it("selects a subset in canonical order", () => {
    expect(parseScope("npm,certs")).toEqual(["certs", "npm"]);
    expect(parseScope("mcp")).toEqual(["mcp"]);
  });

  it("fails closed on unknown scope tokens", () => {
    expect(() => parseScope("bogus,nonsense")).toThrow("unknown --scope value(s): bogus, nonsense");
    expect(() => parseScope("npm,bogus")).toThrow("unknown --scope value(s): bogus");
  });
});

describe("heal — tool invocation (Windows .cmd shim)", () => {
  it("routes PATH tools through cmd /c on Windows, directly on POSIX", () => {
    expect(versionArgv("windows", "npm")).toEqual(["cmd", "/c", "npm", "--version"]);
    expect(versionArgv("linux", "npm")).toEqual(["npm", "--version"]);
  });

  it("classifies a spawn error (POSIX) and 'is not recognized' (Windows cmd) as absent", () => {
    expect(classifyTool({ code: 127, stdout: "", stderr: "", spawnError: true }, false)).toBe(
      "absent",
    );
    expect(
      classifyTool(
        {
          code: 1,
          stdout: "",
          stderr: "'npm' is not recognized as an internal or external command",
        },
        true,
      ),
    ).toBe("absent");
  });

  it("classifies exit 0 as ok and a present-but-failing tool as broken", () => {
    expect(classifyTool({ code: 0, stdout: "10.9.2", stderr: "" }, true)).toBe("ok");
    expect(
      classifyTool({ code: 1, stdout: "", stderr: "Cannot find module 'fs-minipass'" }, true),
    ).toBe("broken");
  });
});

describe("heal — cert step", () => {
  it("all green: cert + both TLS probes pass, no fix digest", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid" }));
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("pass");
    expect(findCheck(p.actions, "TLS registry.npmjs.org")?.verdict).toBe("pass");
    expect(findCheck(p.actions, "TLS pypi.org")?.verdict).toBe("pass");
    expect(findDigest(p.actions, "re-propagate corporate trust")).toBeUndefined();
  });

  it("unset env var + failing TLS fails and emits the certs fix digest", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "unset", registry: "fail" }));
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("fail");
    expect(findDigest(p.actions, "re-propagate corporate trust")?.text).toContain(
      "aih certs --apply",
    );
  });

  it("unset env var + healthy TLS is a skip, not a failure (no-proxy machine)", async () => {
    const p = await command.plan(
      makeCtx({ root: freshTmp(), ca: "unset", registry: "ok", pypi: "ok" }),
    );
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("skip");
    expect(findDigest(p.actions, "re-propagate corporate trust")).toBeUndefined();
  });

  it("env set but file missing fails", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "missing" }));
    const c = findCheck(p.actions, "NODE_EXTRA_CA_CERTS");
    expect(c?.verdict).toBe("fail");
    expect(c?.detail).toContain("missing");
  });

  it("env points at a non-PEM file fails", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "bad" }));
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("fail");
  });

  it("a TLS handshake failure marks the chain broken even with a valid PEM", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", registry: "fail" }));
    expect(findCheck(p.actions, "TLS registry.npmjs.org")?.verdict).toBe("fail");
    expect(findDigest(p.actions, "re-propagate corporate trust")).toBeDefined();
  });

  it("curl/probe absent is a skip, not a failure (no fix prescribed)", async () => {
    const p = await command.plan(
      makeCtx({ root: freshTmp(), ca: "valid", registry: "absent", pypi: "absent" }),
    );
    expect(findCheck(p.actions, "TLS registry.npmjs.org")?.verdict).toBe("skip");
    expect(findDigest(p.actions, "re-propagate corporate trust")).toBeUndefined();
  });

  it("Windows persists the CA at user scope so GUI apps inherit it", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), platform: "windows", ca: "valid" }));
    const e = execs(p.actions);
    expect(e).toHaveLength(1);
    // `setx` (not a pwsh-only [Environment]::SetEnvironmentVariable) so the persist works
    // on managed images without PowerShell 7 and under Constrained Language Mode. Spawned
    // DIRECTLY (no `cmd /c` wrapper), so the CA path is a single literal argv element and
    // cmd never re-parses `&`/`%`/`^` in it (see persistentEnvArgv).
    expect(e[0]?.argv.slice(0, 2)).toEqual(["setx", "NODE_EXTRA_CA_CERTS"]);
    expect(e[0]?.argv).toHaveLength(3);
    expect(e[0]?.argv[2]).toContain("ca.pem");
    expect(findDigest(p.actions, "GUI apps inherit the CA")).toBeDefined();
  });

  it("a failed persist exec under --apply surfaces a failing check (not an invisible exit-1)", async () => {
    // Before the fix the persist exec was pwsh-only: on a box without PowerShell 7 it
    // ENOENTed (exit 127), runCapability set exit 1 (execFailed), yet the report printed
    // "0 failed" — a contradiction any scripted gate on heal would choke on. Now a
    // failureCheck lands the failure IN the report so exit code and report agree.
    const ctx = makeCtx({ root: freshTmp(), platform: "windows", ca: "valid", apply: true });
    // Fail ONLY the `setx …` persist exec (as on a locked-down box where setx is
    // policy-blocked); TLS + node/npm/npx still answer healthy via the base runner.
    const base = ctx.run;
    ctx.run = async (argv, opts) =>
      argv[0] === "setx"
        ? { code: 127, stdout: "", stderr: "'setx' is not recognized", spawnError: true }
        : base(argv, opts);

    const result = await executePlan(await command.plan(ctx), ctx);

    // The persist exec ran and failed …
    const persist = result.execs.find((x) => x.argv[0] === "setx");
    expect(persist?.ran).toBe(true);
    expect(persist?.ok).toBe(false);
    // … and that failure is now the report's single failing check (cert-coded), so
    // result.report.exitCode() (1) agrees with runCapability's execFailed-driven exit.
    const fails = result.report?.checks.filter((c) => c.verdict === "fail") ?? [];
    expect(fails).toHaveLength(1);
    expect(fails[0]?.name).toBe("cert: persist at user scope");
    expect(fails[0]?.code).toBe("cert.ca-missing");
    expect(result.report?.exitCode()).toBe(1);
  });

  it("POSIX emits no persist exec (the profile envblock is the durable seam)", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), platform: "linux", ca: "valid" }));
    expect(execs(p.actions)).toHaveLength(0);
  });
});

describe("heal — npm ladder", () => {
  it("L0: npm works → no npm fix digest", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", npm: "ok" }));
    expect(findCheck(p.actions, "npm: runtime")?.verdict).toBe("pass");
    expect(findDigest(p.actions, "reinstall npm")).toBeUndefined();
  });

  it("L1: npm broken + registry reachable → emits the Node-https reinstall script", async () => {
    const p = await command.plan(
      makeCtx({ root: freshTmp(), ca: "valid", npm: "fail", registry: "ok" }),
    );
    expect(findCheck(p.actions, "npm: runtime")?.verdict).toBe("fail");
    const d = findDigest(p.actions, "reinstall npm via Node");
    expect(d?.text).toContain("heal-npm.mjs");
    expect(d?.text).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("L2: npm broken + registry blocked → offline guidance using npm-cli.js", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        npm: "fail",
        registry: "fail",
        npmCli: "/opt/node/npm-cli.js",
      }),
    );
    const d = findDigest(p.actions, "reinstall npm offline");
    expect(d).toBeDefined();
    expect(d?.text).toContain("/opt/node/npm-cli.js");
  });

  it("L3: node missing → install-Node guidance and npm check skipped", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", node: "absent" }));
    expect(findCheck(p.actions, "node: runtime")?.verdict).toBe("fail");
    expect(findCheck(p.actions, "npm: runtime")?.verdict).toBe("skip");
    expect(findDigest(p.actions, "install Node.js")).toBeDefined();
  });
});

describe("heal — path step", () => {
  it("bin dir absent → skip, no fix", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", binOnDisk: false }));
    expect(findCheck(p.actions, "path: ~/.local/bin")?.verdict).toBe("skip");
    expect(findDigest(p.actions, "add the tool dir to PATH")).toBeUndefined();
  });

  it("bin dir on PATH → pass", async () => {
    // platform matches the (Windows) test host so the real `join()` path and the
    // PATH separator agree — a POSIX simulation here would split the drive-letter
    // colon as a `:` separator. The not-on-PATH branch below covers POSIX.
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        platform: "windows",
        ca: "valid",
        binOnDisk: true,
        binOnPath: true,
      }),
    );
    expect(findCheck(p.actions, "path: ~/.local/bin")?.verdict).toBe("pass");
  });

  it("bin exists but not on PATH → fail + per-shell fix digest", async () => {
    const p = await command.plan(
      makeCtx({ root: freshTmp(), ca: "valid", binOnDisk: true, binOnPath: false }),
    );
    expect(findCheck(p.actions, "path: ~/.local/bin")?.verdict).toBe("fail");
    expect(findDigest(p.actions, "add the tool dir to PATH")?.text).toContain('export PATH="');
  });

  it("Windows fix offers the PowerShell registry form and a cmd/setx fallback", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        platform: "windows",
        ca: "valid",
        binOnDisk: true,
        binOnPath: false,
      }),
    );
    const text = findDigest(p.actions, "add the tool dir to PATH")?.text;
    // Primary: PowerShell appends to the User Path without clobbering.
    expect(text).toContain("SetEnvironmentVariable");
    // Fallback for cmd.exe / no-PowerShell-7 / Constrained Language Mode boxes.
    expect(text).toContain("setx Path");
    // The fallback reads the USER Path specifically and appends via a placeholder —
    // never the combined %Path% that setx would truncate at 1024 chars.
    expect(text).toContain("reg query HKCU\\Environment");
    expect(text).toContain('setx Path "<current-user-path>');
  });
});

describe("heal — mcp pre-flight", () => {
  it("no .mcp.json → skip", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", mcpJson: false }));
    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("skip");
  });

  it("mcp config without npx → skip", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{"mcpServers":{"x":{"command":"node"}}}',
      }),
    );
    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("skip");
  });

  it("npx-backed servers + working npx → pass", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{"mcpServers":{"x":{"command":"npx"}}}',
        npx: "ok",
      }),
    );
    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("pass");
  });

  it("broken npx + failing registry → chains the cause to certs/TLS", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{"x":{"command":"npx"}}',
        npx: "absent",
        registry: "fail",
      }),
    );
    const c = findCheck(p.actions, "mcp: npx launcher");
    expect(c?.verdict).toBe("fail");
    expect(c?.detail).toContain("certs/TLS");
  });

  it("broken npx + healthy registry → chains the cause to npm", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{"x":{"command":"npx"}}',
        npx: "absent",
        registry: "ok",
      }),
    );
    expect(findCheck(p.actions, "mcp: npx launcher")?.detail).toContain("npm is broken");
  });
});

describe("heal — scope filtering", () => {
  it("--scope npm runs only the npm step", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", scope: "npm" }));
    expect(findCheck(p.actions, "npm: runtime")).toBeDefined();
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")).toBeUndefined();
    expect(findCheck(p.actions, "path: ~/.local/bin")).toBeUndefined();
    expect(findCheck(p.actions, "mcp: npx launcher")).toBeUndefined();
  });

  it("--scope certs runs only the cert step", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", scope: "certs" }));
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")).toBeDefined();
    expect(findCheck(p.actions, "npm: runtime")).toBeUndefined();
  });
});

describe("heal — invariant guard (D4)", () => {
  it("never emits an exec that contacts a remote, even when everything is broken", async () => {
    const sc: Scenario = {
      root: freshTmp(),
      platform: "windows",
      ca: "valid", // valid so the Windows persist-CA exec is emitted (the only exec)
      npm: "fail",
      registry: "fail",
      node: "ok",
      binOnDisk: true,
      binOnPath: false,
      mcpJson: '{"x":{"command":"npx"}}',
      npx: "absent",
    };
    const p = await command.plan(makeCtx(sc));
    for (const e of execs(p.actions)) {
      const joined = e.argv.join(" ").toLowerCase();
      expect(joined).not.toContain("registry");
      expect(joined).not.toContain("npm install");
      expect(joined).not.toContain("install -g");
      expect(joined).not.toContain(".tgz");
      expect(joined).not.toContain("curl");
    }
  });
});

describe("heal — verification report integration", () => {
  it("a broken runtime drives a non-zero verify exit code", async () => {
    const ctx = makeCtx({ root: freshTmp(), ca: "unset", npm: "fail", registry: "fail" });
    const result = await executePlan(await command.plan(ctx), ctx);
    expect(result.report?.ok).toBe(false);
    expect(result.report?.exitCode()).toBe(1);
  });

  it("a healthy runtime passes verification", async () => {
    // No user-bin dir (path → skip) and no .mcp.json (mcp → skip); skips never fail
    // the report, so cert+TLS+node+npm passes leave it green.
    const ctx = makeCtx({ root: freshTmp(), ca: "valid", mcpJson: false });
    const result = await executePlan(await command.plan(ctx), ctx);
    expect(result.report?.ok).toBe(true);
    expect(result.report?.exitCode()).toBe(0);
  });
});
