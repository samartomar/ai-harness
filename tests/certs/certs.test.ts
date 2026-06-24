import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargoConfig, command, pipConfig } from "../../src/certs/index.js";
import { upsertIniKey } from "../../src/certs/ini.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import type { CertEntry, HostAdapter, Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PEM_ONE =
  "-----BEGIN CERTIFICATE-----\nMIIBExampleZscalerRootCA\n-----END CERTIFICATE-----\n";
const PEM_TWO = "-----BEGIN CERTIFICATE-----\nMIIBExampleIssuingCA\n-----END CERTIFICATE-----\n";

type Handler = (argv: string[]) => Partial<RunResult> | undefined;

/**
 * Host adapter that returns canned certs (so no test reads the real OS trust
 * store) but keeps the real per-platform argv / profile-path / shell behavior so
 * the generated plan is asserted against the actual house conventions.
 */
function certsHost(
  certs: CertEntry[],
  opts: { platform?: Platform; env?: NodeJS.ProcessEnv; handler?: Handler } = {},
): HostAdapter {
  const platform = opts.platform ?? "linux";
  const run = fakeRunner(opts.handler ?? (() => undefined));
  const base = makeHostAdapter({ platform, run, env: opts.env ?? {} });
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "trustStoreCerts") {
        return async (_pattern: string): Promise<CertEntry[]> => certs;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface CtxOptions {
  certs?: CertEntry[];
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  options?: Record<string, unknown>;
  handler?: Handler;
  root: string;
  verify?: boolean;
}

function makeCtx(o: CtxOptions): PlanContext {
  const env = o.env ?? { HOME: o.root };
  const run = fakeRunner(o.handler ?? (() => undefined));
  return {
    root: o.root,
    contextDir: ".ai-context",
    apply: false,
    verify: o.verify ?? false,
    json: false,
    run,
    host: certsHost(o.certs ?? [{ subject: "CN=Zscaler Root CA", pem: PEM_ONE }], {
      platform: o.platform,
      env,
      handler: o.handler,
    }),
    env,
    options: o.options ?? {},
  };
}

function findWrite(actions: Action[], suffix: string) {
  return actions.find(
    (a): a is Extract<Action, { kind: "write" }> =>
      a.kind === "write" && a.path.replace(/\\/g, "/").endsWith(suffix),
  );
}

function findExec(actions: Action[]) {
  return actions.find((a): a is Extract<Action, { kind: "exec" }> => a.kind === "exec");
}

function findDoc(actions: Action[], needle: string) {
  return actions.find(
    (a): a is Extract<Action, { kind: "doc" }> => a.kind === "doc" && a.describe.includes(needle),
  );
}

function findEnvBlock(actions: Action[], scope: string) {
  return actions.find(
    (a): a is Extract<Action, { kind: "envblock" }> => a.kind === "envblock" && a.scope === scope,
  );
}

/**
 * The trust env block is an `envblock` action; the executor renders + folds it
 * into the shell profile. Apply the plan against the (temp) profile path and
 * return its contents so format/marker assertions inspect the real output.
 */
async function renderProfile(ctx: PlanContext): Promise<string> {
  const profile = ctx.host.shellProfilePaths()[0] as string;
  mkdirSync(dirname(profile), { recursive: true });
  const applyCtx: PlanContext = { ...ctx, apply: true };
  await executePlan(await command.plan(applyCtx), applyCtx);
  return readFileSync(profile, "utf8");
}

let tmp = "";
const dirs: string[] = [];
function freshTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "aih-certs-"));
  dirs.push(tmp);
  return tmp;
}

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("certs command surface", () => {
  it("keeps the foundation CLI name and the two options", () => {
    expect(command.name).toBe("certs");
    const flags = (command.options ?? []).map((o) => o.flags);
    expect(flags).toContain("--ca-pattern <pattern>");
    expect(flags).toContain("--out <dir>");
  });
});

describe("certs plan — happy path", () => {
  it("writes a locked-down PEM bundle to the default out dir", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));

    const pem = findWrite(p.actions, "/.config/enterprise-ca/corporate-root-ca.pem");
    expect(pem).toBeDefined();
    expect(pem?.contents).toBe(PEM_ONE);
    expect(pem?.path.replace(/\\/g, "/")).toContain(home.replace(/\\/g, "/"));
  });

  it("concatenates multiple certs into one PEM bundle", async () => {
    const root = freshTmp();
    const p = await command.plan(
      makeCtx({
        root,
        env: { HOME: root },
        certs: [
          { subject: "CN=Zscaler Root CA", pem: PEM_ONE },
          { subject: "CN=Zscaler Issuing CA", pem: PEM_TWO },
        ],
      }),
    );
    const pem = findWrite(p.actions, "corporate-root-ca.pem");
    expect(pem?.contents).toBe(PEM_ONE + PEM_TWO);
  });

  it("emits the PEM lockdown as an exec over the PEM path (the only exec)", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));

    const execs = p.actions.filter((a) => a.kind === "exec");
    expect(execs).toHaveLength(1);
    const lockdown = findExec(p.actions);
    // Linux adapter locks down with chmod 600 <pem>.
    expect(lockdown?.argv[0]).toBe("chmod");
    expect(lockdown?.argv.at(-1)?.replace(/\\/g, "/")).toContain("corporate-root-ca.pem");
  });

  it("exports the full trust env block into the shell profile", async () => {
    const root = freshTmp();
    const ctx = makeCtx({ root, env: { HOME: join(root, "home") } });

    // The trust env is an envblock (scope "certs") carrying all six vars.
    const eb = findEnvBlock((await command.plan(ctx)).actions, "certs");
    expect(eb).toBeDefined();
    const keys = eb?.vars.map((v) => v.key) ?? [];
    for (const key of [
      "NODE_EXTRA_CA_CERTS",
      "PIP_CERT",
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CARGO_HTTP_CAINFO",
      "SSL_CERT_DIR",
    ]) {
      expect(keys).toContain(key);
    }
    // The executor renders it into the profile with posix `export` + markers.
    const body = await renderProfile(ctx);
    expect(body).toContain("# >>> aih managed (certs) >>>");
    expect(body).toContain("export NODE_EXTRA_CA_CERTS=");
    expect(body).toMatch(/export SSL_CERT_DIR=.*enterprise-ca/);
  });

  it("re-running the profile upsert is idempotent (twice == once)", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const first = await command.plan(makeCtx({ root, env: { HOME: home } }));
    const body1 = findWrite(first.actions, "/.bashrc")?.contents ?? "";

    // Feed the generated block back in as the pre-existing profile.
    const existingProfile = join(home, ".bashrc");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(home, { recursive: true });
    writeFileSync(existingProfile, body1, "utf8");

    const second = await command.plan(makeCtx({ root, env: { HOME: home } }));
    const body2 = findWrite(second.actions, "/.bashrc")?.contents ?? "";
    expect(body2).toBe(body1);
  });
});

describe("certs plan — per-manager config files carry the PEM path", () => {
  it("npm .npmrc gets cafile=<pem>", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));
    const npmrc = findWrite(p.actions, "/.npmrc");
    expect(npmrc?.contents).toMatch(/^cafile=.*corporate-root-ca\.pem$/m);
  });

  it("pip pip.conf gets [global] cert=<pem> on posix", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, platform: "linux", env: { HOME: home } }));
    const pip = findWrite(p.actions, "/.config/pip/pip.conf");
    expect(pip).toBeDefined();
    expect(pip?.contents).toContain("[global]");
    expect(pip?.contents).toMatch(/cert=.*corporate-root-ca\.pem/);
    expect(pip?.contents).toContain("use-feature = truststore");
  });

  it("pip uses %APPDATA%\\pip\\pip.ini on windows", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const appdata = join(root, "AppData");
    const p = await command.plan(
      makeCtx({
        root,
        platform: "windows",
        env: { USERPROFILE: home, APPDATA: appdata, USERNAME: "samar" },
      }),
    );
    const pip = findWrite(p.actions, "/pip/pip.ini");
    expect(pip).toBeDefined();
    expect(pip?.path.replace(/\\/g, "/")).toContain(appdata.replace(/\\/g, "/"));
    expect(pip?.contents).toMatch(/cert=.*corporate-root-ca\.pem/);
  });

  it("cargo config.toml gets [http] cainfo and [net] git-fetch-with-cli", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));
    const cargo = findWrite(p.actions, "/.cargo/config.toml");
    expect(cargo).toBeDefined();
    expect(cargo?.contents).toContain("[http]");
    expect(cargo?.contents).toMatch(/cainfo = ".*corporate-root-ca\.pem"/);
    expect(cargo?.contents).toContain("[net]");
    expect(cargo?.contents).toContain("git-fetch-with-cli = true");
  });
});

describe("certs plan — boundary: cloud/optional managers are docs, not exec/write", () => {
  it("Homebrew and conda are doc actions carrying exact commands", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(makeCtx({ root, env: { HOME: home } }));

    const brew = findDoc(p.actions, "Homebrew");
    const conda = findDoc(p.actions, "conda");
    expect(brew?.text).toContain("c_rehash");
    expect(brew?.text).toContain("brew doctor");
    expect(conda?.text).toContain("conda config --set ssl_verify");

    // Neither manager is ever an exec, and no write targets brew/conda dirs.
    const execArgvs = p.actions
      .filter((a) => a.kind === "exec")
      .map((a) => (a as Extract<Action, { kind: "exec" }>).argv.join(" "));
    expect(
      execArgvs.some((s) => s.includes("brew") || s.includes("conda") || s.includes("c_rehash")),
    ).toBe(false);
  });
});

describe("certs plan — windows trust propagation", () => {
  it("locks the PEM down via icacls (blueprint /inheritance:r /grant:r), the only exec", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(
      makeCtx({
        root,
        platform: "windows",
        env: { USERPROFILE: home, APPDATA: join(root, "AppData"), USERNAME: "samar" },
      }),
    );

    const execs = p.actions.filter((a) => a.kind === "exec");
    expect(execs).toHaveLength(1);
    const lockdown = findExec(p.actions);
    // Windows adapter locks down with icacls, disabling inheritance and granting the user read.
    expect(lockdown?.argv.slice(0, 2)).toEqual(["icacls", expect.any(String)]);
    expect(lockdown?.argv).toContain("/inheritance:r");
    expect(lockdown?.argv).toContain("/grant:r");
    expect(lockdown?.argv).toContain("samar:(R)");
    expect(lockdown?.argv[1]?.replace(/\\/g, "/")).toContain("corporate-root-ca.pem");
  });

  it("exports the trust block to the PowerShell profile in $env: form", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const ctx = makeCtx({
      root,
      platform: "windows",
      env: { USERPROFILE: home, APPDATA: join(root, "AppData"), USERNAME: "samar" },
    });

    // Rendered by the executor into the PowerShell profile in $env: form.
    const body = await renderProfile(ctx);
    expect(body).toContain("# >>> aih managed (certs) >>>");
    // PowerShell syntax, not POSIX `export`.
    expect(body).toContain('$env:NODE_EXTRA_CA_CERTS = "');
    expect(body).not.toContain("export NODE_EXTRA_CA_CERTS=");
    expect(body).toMatch(/\$env:SSL_CERT_DIR = ".*enterprise-ca"/);
  });
});

describe("certs plan — no matching CA", () => {
  it("degrades to a single doc explaining --ca-pattern and writes nothing", async () => {
    const root = freshTmp();
    const p = await command.plan(makeCtx({ root, env: { HOME: root }, certs: [] }));

    expect(p.actions).toHaveLength(1);
    const only = p.actions[0];
    expect(only?.kind).toBe("doc");
    expect((only as Extract<Action, { kind: "doc" }>).text).toContain("--ca-pattern");
    expect(p.actions.some((a) => a.kind === "write")).toBe(false);
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("uses the requested pattern in the no-cert guidance", async () => {
    const root = freshTmp();
    const p = await command.plan(
      makeCtx({ root, env: { HOME: root }, certs: [], options: { caPattern: "Netskope" } }),
    );
    const only = p.actions[0] as Extract<Action, { kind: "doc" }>;
    expect(only.text).toContain("Netskope");
  });

  it("quotes the --ca-pattern hint per shell (single on posix, double on powershell)", async () => {
    const root = freshTmp();
    const posix = await command.plan(
      makeCtx({ root, platform: "linux", env: { HOME: root }, certs: [] }),
    );
    const posixDoc = posix.actions[0] as Extract<Action, { kind: "doc" }>;
    expect(posixDoc.text).toContain("--ca-pattern 'Corporate Issuing CA'");

    const win = await command.plan(
      makeCtx({ root, platform: "windows", env: { USERPROFILE: root }, certs: [] }),
    );
    const winDoc = win.actions[0] as Extract<Action, { kind: "doc" }>;
    expect(winDoc.text).toContain('--ca-pattern "Corporate Issuing CA"');
  });
});

describe("certs plan — out dir + probe", () => {
  it("honors --out and expands a leading ~ to home", async () => {
    const root = freshTmp();
    const home = join(root, "home");
    const p = await command.plan(
      makeCtx({ root, env: { HOME: home }, options: { out: "~/certs-store" } }),
    );
    const pem = findWrite(p.actions, "/certs-store/corporate-root-ca.pem");
    expect(pem).toBeDefined();
    expect(pem?.path.replace(/\\/g, "/")).toContain(`${home.replace(/\\/g, "/")}/certs-store`);
  });

  it("pypi probe passes on curl exit 0 and skips when curl is absent", async () => {
    const root = freshTmp();
    const home = join(root, "home");

    const okCtx = makeCtx({
      root,
      env: { HOME: home },
      handler: (argv) => (argv[0] === "curl" ? { code: 0 } : undefined),
      verify: true,
    });
    const p1 = await command.plan(okCtx);
    const probe1 = p1.actions.find((a) => a.kind === "probe") as Extract<Action, { kind: "probe" }>;
    expect(probe1).toBeDefined();
    expect((await probe1.run(okCtx)).verdict).toBe("pass");

    const missingCtx = makeCtx({
      root,
      env: { HOME: home },
      handler: (argv) => (argv[0] === "curl" ? { spawnError: true, code: 127 } : undefined),
      verify: true,
    });
    const p2 = await command.plan(missingCtx);
    const probe2 = p2.actions.find((a) => a.kind === "probe") as Extract<Action, { kind: "probe" }>;
    expect((await probe2.run(missingCtx)).verdict).toBe("skip");
  });
});

describe("ini helper", () => {
  it("appends a flat key and rewrites it in place on the second pass", () => {
    const once = upsertIniKey("registry=https://r.example\n", "cafile", "/x/ca.pem");
    expect(once).toContain("registry=https://r.example");
    expect(once).toContain("cafile=/x/ca.pem");
    const twice = upsertIniKey(once, "cafile", "/x/ca.pem");
    expect(twice).toBe(once);
  });

  it("places a key under an existing section without disturbing other sections", () => {
    const existing = "[global]\ntimeout=60\n\n[install]\nuser=true\n";
    const out = upsertIniKey(existing, "cert", "/x/ca.pem", { section: "global" });
    expect(out).toContain("timeout=60");
    expect(out).toContain("cert=/x/ca.pem");
    expect(out).toContain("[install]");
    expect(out).toContain("user=true");
    // The key landed inside [global], before [install].
    expect(out.indexOf("cert=")).toBeLessThan(out.indexOf("[install]"));
  });

  it("pipConfig is idempotent and keeps the truststore hint once", () => {
    const a = pipConfig("", "/x/ca.pem");
    const b = pipConfig(a, "/x/ca.pem");
    expect(b).toBe(a);
    expect((b.match(/use-feature = truststore/g) ?? []).length).toBe(1);
  });

  it("cargoConfig is idempotent across both sections", () => {
    const a = cargoConfig("", "/x/ca.pem");
    const b = cargoConfig(a, "/x/ca.pem");
    expect(b).toBe(a);
    expect(a).toContain('cainfo = "/x/ca.pem"');
    expect(a).toContain("git-fetch-with-cli = true");
  });
});
