import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTool, versionArgv } from "../../src/heal/common.js";
import { command } from "../../src/heal/index.js";
import { probeNodeTls, runtimeTlsOrigins } from "../../src/heal/node-trust.js";
import { parseScope } from "../../src/heal/phases.js";
import { pathFixDoc } from "../../src/heal/templates.js";
import * as cliRegistry from "../../src/internals/cli-registry.js";
import { executePlan, summarizeResult } from "../../src/internals/execute.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { CertEntry, HostAdapter, Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBExampleCorporateRootCA\n-----END CERTIFICATE-----\n";
const ROOT_A_PEM = readFileSync(new URL("../fixtures/certs/root-a.pem", import.meta.url), "utf8");
const LEAF_A_PEM = readFileSync(new URL("../fixtures/certs/leaf-a.pem", import.meta.url), "utf8");
const ROOT_A: CertEntry = {
  subject: new X509Certificate(ROOT_A_PEM).subject,
  pem: ROOT_A_PEM,
};

type State = "ok" | "fail" | "absent" | "timeout";

interface Scenario {
  platform?: Platform;
  registry?: State;
  pypi?: State;
  nodeRegistry?: State;
  nodePypi?: State;
  /** Result when the selector retries divergent origins with NODE_USE_SYSTEM_CA=1. */
  systemCa?: State;
  /** Result when the selector retries divergent origins with its verified minimal bundle. */
  extraCa?: State;
  capturedChain?: string[];
  trustRoots?: CertEntry[];
  mcpNodeTls?: State;
  mcpPythonTls?: State;
  mcpNodeCaBundle?: State;
  mcpPythonCaBundle?: State;
  node?: State;
  npm?: State;
  npx?: State;
  /** "valid" PEM on disk | "missing" path | "bad" non-PEM file | "unset" (no env) */
  ca?: "valid" | "missing" | "bad" | "unset";
  /** Same states, but for Python's SSL_CERT_FILE bundle. */
  pythonCa?: "valid" | "missing" | "bad" | "unset";
  binOnDisk?: boolean;
  binOnPath?: boolean;
  mcpJson?: string | false;
  npmCli?: string;
  scope?: string;
  probeMcpEndpoints?: boolean;
  apply?: boolean;
  root: string;
}

function tlsResult(s: State): Partial<RunResult> {
  if (s === "absent") return { spawnError: true, code: 127 };
  if (s === "timeout")
    return { spawnError: true, code: 1, stderr: "process timed out after 25000ms" };
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
  return fakeRunner((argv, opts) => {
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
    if (tool === "node" && argv.includes("-e")) {
      const script = argv[argv.indexOf("-e") + 1] ?? "";
      const origin = argv.at(-1) ?? "";
      if (script.includes("rejectUnauthorized:false")) {
        if (sc.capturedChain === undefined) return { code: 1 };
        return {
          code: 0,
          stdout: JSON.stringify(
            sc.capturedChain.map((pem) => new X509Certificate(pem).raw.toString("base64")),
          ),
        };
      }
      if (script.includes("rootCertificates")) return tlsResult(sc.extraCa ?? "fail");

      const host = origin.startsWith("https://") ? new URL(origin).hostname : "";
      const current =
        host === "registry.npmjs.org"
          ? (sc.nodeRegistry ?? "ok")
          : host === "pypi.org"
            ? (sc.nodePypi ?? "ok")
            : (sc.mcpNodeTls ?? "ok");
      const selected =
        opts?.env?.NODE_USE_SYSTEM_CA === "1"
          ? (sc.systemCa ?? current)
          : sc.extraCa !== undefined && opts?.env?.NODE_EXTRA_CA_CERTS !== undefined
            ? sc.extraCa
            : current;
      return tlsResult(selected);
    }
    if ((tool === "python3" || tool === "py") && argv.includes("-c"))
      return tlsResult(sc.mcpPythonTls ?? "ok");
    if (cmd === "openssl" && argv.includes("s_client")) {
      const caIndex = argv.indexOf("-CAfile");
      const caPath = caIndex >= 0 ? (argv[caIndex + 1] ?? "") : "";
      return tlsResult(
        caPath.includes("python-ca.pem")
          ? (sc.mcpPythonCaBundle ?? "ok")
          : (sc.mcpNodeCaBundle ?? "ok"),
      );
    }
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
  if (sc.pythonCa === "valid") {
    const p = join(sc.root, "python-ca.pem");
    writeFileSync(p, PEM, "utf8");
    env.SSL_CERT_FILE = p;
  } else if (sc.pythonCa === "missing") {
    env.SSL_CERT_FILE = join(sc.root, "missing-python-ca.pem");
  } else if (sc.pythonCa === "bad") {
    const p = join(sc.root, "bad-python-ca.pem");
    writeFileSync(p, "not a certificate\n", "utf8");
    env.SSL_CERT_FILE = p;
  }
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
  if (sc.npmCli === undefined && sc.trustRoots === undefined) return base;
  return new Proxy(base, {
    get(t, p, r) {
      if (p === "npmCliPath" && sc.npmCli !== undefined) return () => sc.npmCli;
      if (p === "trustStoreRoots" && sc.trustRoots !== undefined) {
        return async (): Promise<CertEntry[]> => sc.trustRoots ?? [];
      }
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
  if (sc.probeMcpEndpoints) options.probeMcpEndpoints = true;
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
async function runCheck(
  actions: Action[],
  namePart: string,
  c: PlanContext,
): Promise<Check | undefined> {
  for (const a of actions) {
    if (a.kind === "probe") {
      const check = await a.run(c);
      if (check.name.includes(namePart)) return check;
    }
  }
  return undefined;
}
function execs(actions: Action[]) {
  return actions.filter((a): a is Extract<Action, { kind: "exec" }> => a.kind === "exec");
}

function findEnvBlock(actions: Action[], scope: string) {
  return actions.find(
    (action): action is Extract<Action, { kind: "envblock" }> =>
      action.kind === "envblock" && action.scope === scope,
  );
}

function trustBundleWrite(actions: Action[]) {
  return actions.find(
    (action): action is Extract<Action, { kind: "write" }> =>
      action.kind === "write" && action.path.endsWith("corporate-root-ca.pem"),
  );
}

describe("heal — command surface", () => {
  it("is a diagnose-by-default capability with the documented options", () => {
    expect(command.name).toBe("heal");
    expect(command.alwaysVerify).toBe(true);
    expect(command.readOnly).toBeUndefined();
    const flags = (command.options ?? []).map((o) => o.flags);
    expect(flags).toContain("--scope <list>");
    expect(flags).toContain("--ca-pattern <pattern>");
    expect(flags).toContain("--probe-mcp-endpoints");
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

describe("heal — Node TLS boundaries", () => {
  it("selects only bounded, credential-free HTTPS origins from configured targets", () => {
    const root = freshTmp();
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: ["claude", "codex", "cursor", "antigravity", "gemini"],
      }),
    );
    const originsByCli: Record<string, string[]> = {
      claude: [
        "http://insecure.example.test",
        "https://user:pass@credentials.example.test",
        "https://path.example.test/not-an-origin",
        "https://query.example.test/?query=value",
        "https://fragment.example.test/#fragment",
        "https://first.example.test",
      ],
      codex: ["https://first.example.test", "https://second.example.test"],
      cursor: ["https://third.example.test"],
      antigravity: ["https://fourth.example.test"],
      gemini: ["https://fifth.example.test"],
    };
    const originalEntry = cliRegistry.entry;
    const entrySpy = vi.spyOn(cliRegistry, "entry").mockImplementation((cli) => ({
      ...originalEntry(cli),
      tlsOrigins: originsByCli[cli] ?? [],
    }));

    try {
      expect(runtimeTlsOrigins(makeCtx({ root }))).toEqual([
        "https://registry.npmjs.org",
        "https://pypi.org",
        "https://first.example.test",
        "https://second.example.test",
        "https://third.example.test",
        "https://fourth.example.test",
      ]);
    } finally {
      entrySpy.mockRestore();
    }
  });

  it("reports a missing Node runtime as an explicit skip", async () => {
    const ctx = makeCtx({ root: freshTmp() });
    ctx.run = fakeRunner(() => ({
      code: 127,
      spawnError: true,
      stderr: "spawn node ENOENT",
    }));

    await expect(probeNodeTls(ctx, "https://node.example.test")).resolves.toEqual({
      name: "cert: Node TLS node.example.test",
      verdict: "skip",
      detail: "node not found on PATH",
    });
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

  it("fails when OS TLS passes but Node TLS fails", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        registry: "ok",
        pypi: "ok",
        nodeRegistry: "fail",
        nodePypi: "fail",
      }),
    );
    expect(findCheck(p.actions, "Node TLS registry.npmjs.org")?.verdict).toBe("fail");
    expect(findCheck(p.actions, "NODE_EXTRA_CA_CERTS")?.verdict).toBe("fail");
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

  it("system-ca persists only NODE_USE_SYSTEM_CA", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "unset",
        nodeRegistry: "fail",
        nodePypi: "ok",
        systemCa: "ok",
      }),
    );

    expect(findEnvBlock(p.actions, "heal-node-trust")?.vars).toEqual([
      { key: "NODE_USE_SYSTEM_CA", value: "1" },
    ]);
    expect(trustBundleWrite(p.actions)).toBeUndefined();
    expect(execs(p.actions)).toHaveLength(0);
    const note = findDigest(p.actions, "selected Node trust");
    expect(note?.text).toContain("NODE_USE_SYSTEM_CA");
    expect(note?.text).toContain("relaunch");
    expect(note?.text).toContain("operator verification");
  });

  it("system-ca removes stale exact and mixed-case trust before profile and final verification", async () => {
    const ctx = makeCtx({
      root: freshTmp(),
      ca: "unset",
      nodeRegistry: "fail",
      nodePypi: "ok",
      systemCa: "ok",
      apply: true,
    });
    Object.assign(ctx.env, {
      NODE_EXTRA_CA_CERTS: "/stale/exact.pem",
      Node_Extra_Ca_Certs: "/stale/mixed.pem",
      node_use_system_ca: "0",
    });
    const calls: NodeJS.ProcessEnv[] = [];
    const base = ctx.run;
    ctx.run = async (argv, opts) => {
      if (argv[0] === "node" && argv.includes("-e")) calls.push(opts?.env ?? {});
      return base(argv, opts);
    };

    const p = await command.plan(ctx);
    expect(findEnvBlock(p.actions, "heal-node-trust")).toMatchObject({
      vars: [{ key: "NODE_USE_SYSTEM_CA", value: "1" }],
      unsetKeys: ["NODE_EXTRA_CA_CERTS"],
    });
    calls.length = 0;
    await executePlan(p, ctx);

    const finalEnv = calls.at(-1) ?? {};
    expect(
      Object.keys(finalEnv).filter((key) =>
        ["node_use_system_ca", "node_extra_ca_certs"].includes(key.toLowerCase()),
      ),
    ).toEqual(["NODE_USE_SYSTEM_CA"]);
    const profile = readFileSync(ctx.host.shellProfilePaths()[0] as string, "utf8");
    expect(profile).toContain("unset NODE_EXTRA_CA_CERTS");
    expect(profile.indexOf("unset NODE_EXTRA_CA_CERTS")).toBeLessThan(
      profile.indexOf("export NODE_USE_SYSTEM_CA=1"),
    );
  });

  it("extra-ca writes and locks one deterministic PEM then persists only NODE_EXTRA_CA_CERTS", async () => {
    const root = freshTmp();
    const p = await command.plan(
      makeCtx({
        root,
        ca: "unset",
        nodeRegistry: "fail",
        nodePypi: "ok",
        systemCa: "fail",
        extraCa: "ok",
        capturedChain: [LEAF_A_PEM],
        trustRoots: [ROOT_A, ROOT_A],
      }),
    );

    const bundle = trustBundleWrite(p.actions);
    expect(bundle?.path).toBe(join(root, ".config", "enterprise-ca", "corporate-root-ca.pem"));
    expect(bundle?.path.startsWith(root)).toBe(true);
    expect(bundle?.contents).toBe(ROOT_A_PEM);
    expect(bundle?.external).toBe(true);
    expect(findEnvBlock(p.actions, "heal-node-trust")?.vars).toEqual([
      { key: "NODE_EXTRA_CA_CERTS", value: bundle?.path },
    ]);
    const lock = execs(p.actions).find((action) => action.argv[0] === "chmod");
    expect(lock?.argv).toEqual(["chmod", "600", bundle?.path]);
    expect(p.actions.map((action) => action.describe).join("\n")).not.toContain(
      "BEGIN CERTIFICATE",
    );
  });

  it("extra-ca clears stale trust on macOS and redacts dry-run/apply results", async () => {
    for (const apply of [false, true]) {
      const root = freshTmp();
      const ctx = makeCtx({
        root,
        platform: "darwin",
        ca: "unset",
        nodeRegistry: "fail",
        nodePypi: "ok",
        systemCa: "fail",
        extraCa: "ok",
        capturedChain: [LEAF_A_PEM],
        trustRoots: [ROOT_A],
        apply,
      });
      Object.assign(ctx.env, {
        NODE_USE_SYSTEM_CA: "0",
        Node_Use_System_Ca: "1",
        NODE_EXTRA_CA_CERTS: "/stale/exact.pem",
        Node_Extra_Ca_Certs: "/stale/mixed.pem",
      });
      const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
      const base = ctx.run;
      ctx.run = async (argv, opts) => {
        calls.push({ argv, env: opts?.env });
        return base(argv, opts);
      };

      const p = await command.plan(ctx);
      expect(findEnvBlock(p.actions, "heal-node-trust")).toMatchObject({
        vars: [expect.objectContaining({ key: "NODE_EXTRA_CA_CERTS" })],
        unsetKeys: ["NODE_USE_SYSTEM_CA"],
      });
      const stalePlist = p.actions.find(
        (action) => action.kind === "write" && action.path.includes("node-use-system-ca"),
      );
      expect(stalePlist).toMatchObject({ kind: "write" });
      if (stalePlist?.kind === "write") expect(stalePlist.contents).toContain("unsetenv");

      calls.length = 0;
      const result = await executePlan(p, ctx);
      expect(JSON.stringify(result)).not.toContain(root);
      expect(summarizeResult(result)).not.toContain(root);
      if (apply) {
        expect(calls.map(({ argv }) => argv).some((argv) => argv[1] === "unsetenv")).toBe(true);
        const finalEnv = calls.filter(({ argv }) => argv[0] === "node").at(-1)?.env ?? {};
        expect(
          Object.keys(finalEnv).filter((key) =>
            ["node_use_system_ca", "node_extra_ca_certs"].includes(key.toLowerCase()),
          ),
        ).toEqual(["NODE_EXTRA_CA_CERTS"]);
      }
    }
  });

  it("unresolved divergence plans no trust mutation", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        platform: "windows",
        ca: "unset",
        nodeRegistry: "fail",
        nodePypi: "ok",
        systemCa: "fail",
      }),
    );

    expect(findEnvBlock(p.actions, "heal-node-trust")).toBeUndefined();
    expect(trustBundleWrite(p.actions)).toBeUndefined();
    expect(execs(p.actions).some((action) => action.argv[0] === "setx")).toBe(false);
    expect(findDigest(p.actions, "unresolved Node trust")).toBeDefined();
  });

  it("healthy Windows trust plans no trust mutation", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), platform: "windows", ca: "valid" }));

    expect(findEnvBlock(p.actions, "heal-node-trust")).toBeUndefined();
    expect(trustBundleWrite(p.actions)).toBeUndefined();
    expect(execs(p.actions).some((action) => action.argv[0] === "setx")).toBe(false);
  });

  it("apply runs selected persistence before the final Node verification", async () => {
    const ctx = makeCtx({
      root: freshTmp(),
      platform: "windows",
      ca: "unset",
      nodeRegistry: "fail",
      nodePypi: "ok",
      systemCa: "ok",
      apply: true,
    });
    Object.assign(ctx.env, {
      NODE_EXTRA_CA_CERTS: "C:\\stale\\exact.pem",
      Node_Extra_Ca_Certs: "C:\\stale\\mixed.pem",
      node_use_system_ca: "0",
    });
    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const base = ctx.run;
    ctx.run = async (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      return base(argv, opts);
    };
    const p = await command.plan(ctx);
    calls.length = 0;

    const result = await executePlan(p, ctx);
    const setxCalls = calls.filter(({ argv }) => argv[0] === "setx");
    expect(setxCalls.map(({ argv }) => argv)).toEqual([
      ["setx", "NODE_USE_SYSTEM_CA", "1"],
      ["setx", "NODE_EXTRA_CA_CERTS", ""],
    ]);
    const lastSetxIndex = calls.findLastIndex(({ argv }) => argv[0] === "setx");
    const finalProbeIndex = calls.findIndex(
      ({ argv, env }) =>
        argv[0] === "node" && argv.includes("-e") && env?.NODE_USE_SYSTEM_CA === "1",
    );
    expect(lastSetxIndex).toBeGreaterThanOrEqual(0);
    expect(finalProbeIndex).toBeGreaterThan(lastSetxIndex);
    expect(
      Object.keys(calls[finalProbeIndex]?.env ?? {}).filter((key) =>
        ["node_use_system_ca", "node_extra_ca_certs"].includes(key.toLowerCase()),
      ),
    ).toEqual(["NODE_USE_SYSTEM_CA"]);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cert: verify persisted Node trust", verdict: "pass" }),
      ]),
    );
  });

  it("apply writes and locks the selected extra bundle before final Node verification", async () => {
    const root = freshTmp();
    const ctx = makeCtx({
      root,
      ca: "unset",
      nodeRegistry: "fail",
      nodePypi: "ok",
      systemCa: "fail",
      extraCa: "ok",
      capturedChain: [LEAF_A_PEM],
      trustRoots: [ROOT_A],
      apply: true,
    });
    const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const base = ctx.run;
    let bundleAtFinal = "";
    ctx.run = async (argv, opts) => {
      calls.push({ argv, env: opts?.env });
      if (
        argv[0] === "node" &&
        argv.includes("-e") &&
        opts?.env?.NODE_EXTRA_CA_CERTS !== undefined
      ) {
        bundleAtFinal = readFileSync(opts.env.NODE_EXTRA_CA_CERTS, "utf8");
      }
      return base(argv, opts);
    };
    const p = await command.plan(ctx);
    calls.length = 0;

    const result = await executePlan(p, ctx);
    const lockIndex = calls.findIndex(({ argv }) => argv[0] === "chmod");
    const finalProbeIndex = calls.findIndex(
      ({ argv, env }) =>
        argv[0] === "node" && argv.includes("-e") && env?.NODE_EXTRA_CA_CERTS !== undefined,
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(finalProbeIndex).toBeGreaterThan(lockIndex);
    expect(calls[finalProbeIndex]?.env?.NODE_USE_SYSTEM_CA).toBeUndefined();
    expect(bundleAtFinal).toBe(ROOT_A_PEM);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cert: verify persisted Node trust", verdict: "pass" }),
      ]),
    );
  });

  it("a failed selected persist exec surfaces a failure and blocks final verification", async () => {
    const ctx = makeCtx({
      root: freshTmp(),
      platform: "windows",
      ca: "unset",
      nodeRegistry: "fail",
      nodePypi: "ok",
      systemCa: "ok",
      apply: true,
    });
    const base = ctx.run;
    let finalProbeRan = false;
    ctx.run = async (argv, opts) => {
      if (argv[0] === "setx") return { code: 5, stdout: "", stderr: "denied" };
      if (argv[0] === "node" && opts?.env?.NODE_USE_SYSTEM_CA === "1") finalProbeRan = true;
      return base(argv, opts);
    };
    const p = await command.plan(ctx);
    finalProbeRan = false;

    const result = await executePlan(p, ctx);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verdict: "fail", code: "cert.ca-missing" }),
      ]),
    );
    expect(finalProbeRan).toBe(false);
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

  it("L3: broken node is a visible node failure, not a healthy runtime", async () => {
    const p = await command.plan(makeCtx({ root: freshTmp(), ca: "valid", node: "fail" }));
    const node = findCheck(p.actions, "node: runtime");
    expect(node?.verdict).toBe("fail");
    expect(node?.code).toBe("env.node-runtime");
    expect(node?.detail).toContain("node --version");
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
    expect(text).toContain("%USERPROFILE%\\.local\\bin");
    expect(text).toContain("%APPDATA%\\Python\\Python3x\\Scripts");
  });

  it("quotes legal-but-hostile path characters in copy-paste PATH guidance", () => {
    const posix = pathFixDoc('/tmp/tool "bin"/$USER', "posix");
    expect(posix).toContain('export PATH="/tmp/tool \\"bin\\"/\\$USER":$PATH');
    expect(posix).toContain("$HOME/Library/Python/<python-version>/bin");
    expect(posix).toContain("$(python3 -m site --user-base)/bin");

    const windows = pathFixDoc("C:\\Users\\O'Hara\\bin%1", "powershell");
    expect(windows).toContain("'C:\\Users\\O''Hara\\bin%1'");
    expect(windows).toContain('setx Path "C:\\Users\\O\'Hara\\bin%%1"');
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

  it("does not probe repo-derived MCP endpoints unless explicitly opted in", async () => {
    const ctx = makeCtx({
      root: freshTmp(),
      ca: "valid",
      scope: "mcp",
      mcpJson: JSON.stringify({
        mcpServers: {
          hostile: { command: "node", url: "https://attacker.example:8443/mcp" },
        },
      }),
    });
    const calls: string[][] = [];
    const base = ctx.run;
    ctx.run = async (argv, opts) => {
      calls.push([...argv]);
      return base(argv, opts);
    };

    const p = await command.plan(ctx);

    expect(findCheck(p.actions, "mcp: TLS endpoint inventory")?.detail).toContain(
      "attacker.example:8443",
    );
    expect(findCheck(p.actions, "mcp: endpoint TLS probes")?.verdict).toBe("skip");
    expect(calls.some((argv) => argv.join(" ").includes("attacker.example"))).toBe(false);
  });

  it("formats non-default MCP endpoint ports correctly in OpenSSL guidance", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: JSON.stringify({
          mcpServers: {
            remote: { command: "node", url: "https://mcp.example.com:8443/mcp" },
          },
        }),
      }),
    );
    const guide = findDigest(p.actions, "MCP TLS interception diagnostics");

    expect(guide?.text).toContain("-connect mcp.example.com:8443");
    expect(guide?.text).toContain("-servername mcp.example.com");
    expect(guide?.text).not.toContain("mcp.example.com:8443:443");
  });

  it("does not infer public GitHub when a GitHub MCP server declares an explicit URL", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: JSON.stringify({
          mcpServers: {
            github: { command: "node", url: "https://github.enterprise.example/mcp" },
          },
        }),
      }),
    );
    const inventory = findCheck(p.actions, "mcp: TLS endpoint inventory");

    expect(inventory?.detail).toContain("github.enterprise.example");
    expect(inventory?.detail).not.toContain("api.github.com");
  });

  it("derives Node MCP endpoints and diagnoses endpoint TLS CA failures", async () => {
    const c = makeCtx({
      root: freshTmp(),
      ca: "valid",
      probeMcpEndpoints: true,
      mcpJson: JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      }),
      npx: "ok",
      mcpNodeTls: "fail",
    });
    const p = await command.plan(c);
    const inventory = findCheck(p.actions, "mcp: TLS endpoint inventory");
    const nodeTls = await runCheck(p.actions, "mcp: Node TLS endpoints", c);
    const guide = findDigest(p.actions, "MCP TLS interception diagnostics");

    expect(inventory?.detail).toContain("api.github.com");
    expect(nodeTls?.verdict).toBe("fail");
    expect(nodeTls?.code).toBe("mcp.blocked");
    expect(nodeTls?.detail).toContain("NODE_EXTRA_CA_CERTS");
    expect(guide?.text).toContain("openssl s_client");
    expect(guide?.text).toContain("api.github.com");
  });

  it("treats endpoint TLS timeouts as blocked instead of runtime-missing skips", async () => {
    const c = makeCtx({
      root: freshTmp(),
      ca: "valid",
      probeMcpEndpoints: true,
      mcpJson: JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      }),
      npx: "ok",
      mcpNodeTls: "timeout",
    });
    const p = await command.plan(c);
    const nodeTls = await runCheck(p.actions, "mcp: Node TLS endpoints", c);

    expect(nodeTls?.verdict).toBe("fail");
    expect(nodeTls?.code).toBe("mcp.blocked");
    expect(nodeTls?.detail).toContain("Node TLS failed");
  });

  it("compares served MCP chains against the configured Node CA bundle", async () => {
    const c = makeCtx({
      root: freshTmp(),
      ca: "valid",
      probeMcpEndpoints: true,
      mcpJson: JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
        },
      }),
      npx: "ok",
      mcpNodeTls: "ok",
      mcpNodeCaBundle: "fail",
    });
    const p = await command.plan(c);
    const caCheck = await runCheck(p.actions, "mcp: Node CA bundle verifies endpoints", c);

    expect(caCheck?.verdict).toBe("fail");
    expect(caCheck?.code).toBe("mcp.blocked");
    expect(caCheck?.detail).toContain("NODE_EXTRA_CA_CERTS");
    expect(caCheck?.detail).toContain("stale or incomplete");
  });

  it("derives Python MCP endpoints and emits SSL_CERT_FILE guidance", async () => {
    const c = makeCtx({
      root: freshTmp(),
      ca: "valid",
      probeMcpEndpoints: true,
      mcpJson: JSON.stringify({
        mcpServers: {
          atlassian: {
            command: "uvx",
            args: ["mcp-atlassian"],
            env: { JIRA_URL: "https://acme.atlassian.net" },
          },
        },
      }),
      mcpPythonTls: "fail",
    });
    const p = await command.plan(c);
    const pythonTls = await runCheck(p.actions, "mcp: Python TLS endpoints", c);
    const guide = findDigest(p.actions, "MCP TLS interception diagnostics");

    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("skip");
    expect(pythonTls?.verdict).toBe("fail");
    expect(pythonTls?.detail).toContain("SSL_CERT_FILE");
    expect(guide?.text).toContain("acme.atlassian.net");
    expect(guide?.text).toContain("SSL_CERT_FILE");
  });

  it("compares served MCP chains against the configured Python CA bundle", async () => {
    const c = makeCtx({
      root: freshTmp(),
      ca: "valid",
      pythonCa: "valid",
      probeMcpEndpoints: true,
      mcpJson: JSON.stringify({
        mcpServers: {
          atlassian: {
            command: "uvx",
            args: ["mcp-atlassian"],
            env: { JIRA_URL: "https://acme.atlassian.net" },
          },
        },
      }),
      mcpPythonTls: "ok",
      mcpPythonCaBundle: "fail",
    });
    const p = await command.plan(c);
    const caCheck = await runCheck(p.actions, "mcp: Python CA bundle verifies endpoints", c);

    expect(caCheck?.verdict).toBe("fail");
    expect(caCheck?.code).toBe("mcp.blocked");
    expect(caCheck?.detail).toContain("SSL_CERT_FILE");
    expect(caCheck?.detail).toContain("stale or incomplete");
  });

  it("malformed .mcp.json text mentioning npx does not count as a launcher", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{ "description": "npx should not be detected from prose"',
        npx: "absent",
      }),
    );
    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("skip");
  });

  it("does not follow a symlinked .mcp.json while checking for npx launchers", async () => {
    const root = freshTmp();
    const outside = join(freshTmp(), "outside-mcp.json");
    writeFileSync(outside, '{"mcpServers":{"x":{"command":"npx"}}}');
    symlinkSync(outside, join(root, ".mcp.json"), "file");

    const p = await command.plan(makeCtx({ root, ca: "valid", mcpJson: false, npx: "absent" }));

    expect(findCheck(p.actions, "mcp: npx launcher")?.verdict).toBe("skip");
  });

  it("broken npx + failing registry → chains the cause to certs/TLS", async () => {
    const p = await command.plan(
      makeCtx({
        root: freshTmp(),
        ca: "valid",
        mcpJson: '{"mcpServers":{"x":{"command":"npx"}}}',
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
        mcpJson: '{"mcpServers":{"x":{"command":"npx"}}}',
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
      const argv = e.argv.map((arg) => arg.toLowerCase());
      const cmd = argv[0] ?? "";
      const joined = argv.join(" ");
      expect(joined).not.toMatch(/\bhttps?:\/\//);
      expect(
        argv.some(
          (arg) =>
            /(^|[/:@])registry[.-]/.test(arg) || /(^|[/:@])npm\.pkg\.github\.com([/:]|$)/.test(arg),
        ),
        `unexpected package registry reference in argv: ${e.argv.join(" ")}`,
      ).toBe(false);
      expect(joined).not.toMatch(/\.tgz(?:\b|$)/);
      expect(argv).not.toEqual(expect.arrayContaining(["curl"]));
      expect(argv).not.toEqual(expect.arrayContaining(["curl.exe"]));
      expect(
        cmd === "npm" && argv.includes("install"),
        `unexpected npm install in argv: ${e.argv.join(" ")}`,
      ).toBe(false);
      expect(
        argv.includes("install") && argv.includes("-g"),
        `unexpected global install in argv: ${e.argv.join(" ")}`,
      ).toBe(false);
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
