import { isAbsolute, join } from "node:path";
import type { EnvVar } from "../internals/envfile.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type CommandSpec,
  doc,
  envBlock,
  exec,
  type Plan,
  type PlanContext,
  plan,
  probe,
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { upsertIniKey } from "./ini.js";
import { homebrewDoc, noCertDoc } from "./templates.js";

const DEFAULT_OUT_DIR = "~/.config/enterprise-ca";
const PEM_NAME = "corporate-root-ca.pem";

/**
 * `aih certs` — extract the corporate root CA from the OS trust store and
 * propagate that trust to the runtimes that ignore the system store (Node, pip,
 * cargo, Homebrew, conda).
 *
 * The plan is a fixed pipeline: export a locked-down PEM bundle, export the trust
 * env vars into the shell profile, write the per-manager config files, and emit
 * doc steps for the managers that may be absent. Cloud/remote systems are never
 * touched — Homebrew and conda are guidance (`doc`), the PEM lockdown is the only
 * `exec` (local icacls/chmod), and the pypi reachability check is a read-only
 * `probe`. When no CA matches the pattern, the plan degrades to a single `doc`.
 */
async function planCerts(ctx: PlanContext): Promise<Plan> {
  const pattern = String(ctx.options.caPattern ?? "Zscaler");
  const certs = await ctx.host.trustStoreCerts(pattern);

  const shell = ctx.host.envShell();
  if (certs.length === 0) {
    return plan(
      "certs",
      doc("no matching corporate CA found", noCertDoc(pattern, caPatternHint(shell))),
    );
  }

  const home = ctx.env.USERPROFILE || ctx.env.HOME || ctx.root;
  const outDir = resolveOutDir(ctx.options.out, home);
  const pemPath = join(outDir, PEM_NAME);

  const bundle = certs.map((c) => c.pem).join("");

  const profile = ctx.host.shellProfilePaths()[0] ?? join(home, ".profile");
  const envVars = trustEnvVars(pemPath, outDir);

  // `certs` is a HOST-level capability: every file it writes lives under the user's
  // home/system (PEM bundle + per-manager configs), not the repo root, so each write
  // opts out of the executor's repo containment with `external: true`.
  return plan(
    "certs",
    // 1. The exported CA bundle, then lock it down to the current user.
    writeText(pemPath, bundle, `corporate root CA bundle (PEM, ${certs.length} cert(s))`, {
      external: true,
    }),
    exec("lock down the PEM to the current user", ctx.host.lockDownFileArgv(pemPath)),

    // 2. Propagate trust to every runtime via shell-profile env exports.
    envBlock(
      profile,
      "certs",
      shell,
      envVars,
      "export NODE_EXTRA_CA_CERTS / PIP_CERT / SSL_CERT_FILE / SSL_CERT_DIR / REQUESTS_CA_BUNDLE / CARGO_HTTP_CAINFO",
    ),

    // 3. Per-manager config files (faithful to the blueprint matrix; idempotent).
    writeText(
      join(home, ".npmrc"),
      upsertIniKey(readIfExists(join(home, ".npmrc")) ?? "", "cafile", pemPath),
      "npm: set cafile to the corporate CA bundle",
      { external: true },
    ),
    pipConfigWrite(ctx, home, pemPath),
    writeText(
      join(home, ".cargo", "config.toml"),
      cargoConfig(readIfExists(join(home, ".cargo", "config.toml")) ?? "", pemPath),
      "cargo: set [http] cainfo and [net] git-fetch-with-cli",
      { external: true },
    ),
    writeText(
      join(home, ".condarc"),
      condarcConfig(readIfExists(join(home, ".condarc")) ?? "", pemPath),
      "conda: set ssl_verify to the corporate CA bundle",
      { external: true },
    ),

    // 4. Homebrew bundles its own CA store and needs a prefix-specific cp + rehash
    //    (not a single config file), so it stays guidance — emitted, never run.
    doc("Homebrew: trust the corporate CA (run if brew is installed)", homebrewDoc(pemPath)),

    // 5. Read-only reachability check (skips cleanly when curl is absent).
    probe("CA trust reaches pypi", (c) => pypiProbe(c)),
  );
}

/** The trust env vars, in blueprint order. All point at the PEM except SSL_CERT_DIR. */
function trustEnvVars(pemPath: string, outDir: string): EnvVar[] {
  return [
    { key: "NODE_EXTRA_CA_CERTS", value: pemPath },
    { key: "PIP_CERT", value: pemPath },
    { key: "SSL_CERT_FILE", value: pemPath },
    { key: "REQUESTS_CA_BUNDLE", value: pemPath },
    { key: "CARGO_HTTP_CAINFO", value: pemPath },
    { key: "SSL_CERT_DIR", value: outDir },
  ];
}

/** Resolve the PEM output directory, expanding a leading `~` to the home dir. */
function resolveOutDir(out: unknown, home: string): string {
  const raw = typeof out === "string" && out.length > 0 ? out : DEFAULT_OUT_DIR;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(home, raw.slice(2));
  }
  if (isAbsolute(raw)) return raw;
  return join(home, raw);
}

/**
 * pip config FILE differs by OS: POSIX uses `~/.config/pip/pip.conf`; Windows
 * uses `%APPDATA%\pip\pip.ini`. Both carry `cert = <pem>` under `[global]`;
 * `use-feature = truststore` is noted (commented) for modern pip 3.10+ which
 * verifies through the OS store directly.
 */
function pipConfigWrite(ctx: PlanContext, home: string, pemPath: string) {
  const isWindows = ctx.host.platform === "windows";
  const pipPath = isWindows
    ? join(ctx.env.APPDATA ?? join(home, "AppData", "Roaming"), "pip", "pip.ini")
    : join(home, ".config", "pip", "pip.conf");
  const existing = readIfExists(pipPath) ?? "";
  return writeText(
    pipPath,
    pipConfig(existing, pemPath),
    "pip: set global.cert to the corporate CA bundle",
    {
      external: true, // home/system path, not repo-scoped
    },
  );
}

/** Upsert `[global] cert=<pem>` into a pip config, leaving the truststore hint. */
export function pipConfig(existing: string, pemPath: string): string {
  const hint = "# pip >= 24.2 on Python 3.10+ can instead verify via the OS store:";
  const withCert = upsertIniKey(existing, "cert", pemPath, { section: "global" });
  if (withCert.includes("use-feature")) return withCert;
  return `${withCert.replace(/\n+$/, "")}\n${hint}\n#   use-feature = truststore\n`;
}

/** Upsert cargo's `[http] cainfo = "<pem>"` and `[net] git-fetch-with-cli = true`. */
export function cargoConfig(existing: string, pemPath: string): string {
  const withCainfo = upsertIniKey(existing, "cainfo", `"${pemPath}"`, {
    section: "http",
    separator: " = ",
  });
  return upsertIniKey(withCainfo, "git-fetch-with-cli", "true", {
    section: "net",
    separator: " = ",
  });
}

/**
 * Upsert `ssl_verify: <pem>` into a YAML `.condarc`, preserving every other line.
 * conda/Anaconda verifies TLS through this key (not the shell env), so writing it
 * applies the corporate trust the same way `.npmrc`/pip/cargo do — no `conda` run.
 */
export function condarcConfig(existing: string, pemPath: string): string {
  const line = `ssl_verify: ${pemPath}`;
  const src = existing.replace(/\n+$/, "");
  const rows = src.length > 0 ? src.split("\n") : [];
  let replaced = false;
  const out = rows.map((r) => {
    if (/^\s*ssl_verify\s*:/.test(r)) {
      replaced = true;
      return line;
    }
    return r;
  });
  if (!replaced) out.push(line);
  return `${out.join("\n")}\n`;
}

/** Shell-appropriate `--ca-pattern` example for the no-cert guidance. */
function caPatternHint(shell: "posix" | "powershell"): string {
  return shell === "powershell"
    ? '--ca-pattern "Corporate Issuing CA"'
    : "--ca-pattern 'Corporate Issuing CA'";
}

/**
 * Read-only probe: `curl -Iv https://pypi.org` exercises the full TLS chain the
 * way pip would. Exit 0 → pass; curl absent (`spawnError`) → skip (never fail,
 * per the verification contract); any other exit → fail with the curl detail.
 */
async function pypiProbe(ctx: PlanContext): Promise<Check> {
  const res = await ctx.run(["curl", "-Iv", "--max-time", "20", "https://pypi.org"]);
  if (res.spawnError) {
    return { name: "CA trust reaches pypi", verdict: "skip", detail: "curl not found" };
  }
  if (res.code === 0) {
    return {
      name: "CA trust reaches pypi",
      verdict: "pass",
      detail: "TLS handshake to pypi.org succeeded",
    };
  }
  const detail = firstLine(res.stderr) || `curl exited ${res.code}`;
  return { name: "CA trust reaches pypi", verdict: "fail", detail };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

export const command: CommandSpec = {
  name: "certs",
  summary: "Extract corporate root CA(s) and propagate trust to npm/pip/cargo/conda",
  options: [
    {
      flags: "--ca-pattern <pattern>",
      description: "subject substring to match in the OS trust store",
      default: "Zscaler",
    },
    {
      flags: "--out <dir>",
      description: "directory for the exported PEM bundle",
      default: DEFAULT_OUT_DIR,
    },
  ],
  plan: planCerts,
};
