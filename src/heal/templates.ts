/**
 * Visible fix-guidance bodies for `heal`. These render as `digest` text (printed
 * verbatim beneath each headline), so they are exact, copy-pasteable commands.
 *
 * The npm self-heal is the load-bearing piece: it is emitted here as an
 * operator-run script, NEVER executed by aih — Node's built-in `https` honors
 * `NODE_EXTRA_CA_CERTS`, so it reaches the registry behind a TLS-intercepting
 * proxy (Zscaler, Netskope, Palo Alto, …) even when npm's own TLS is broken.
 */

import { lines } from "../internals/render.js";
import { REGISTRY_URL } from "./common.js";

/** Filename we suggest the operator save the self-heal script as. */
export const NPM_HEAL_SCRIPT = "heal-npm.mjs";

/**
 * The Node self-heal script. Resolves npm's current tarball from the registry
 * using Node's own TLS stack (so the corporate CA in NODE_EXTRA_CA_CERTS applies),
 * downloads it, and reinstalls npm globally with the freshly-unpacked `npm-cli.js`.
 * Pure stdlib — no dependency on the broken npm.
 */
export function npmHealScript(): string {
  return lines(
    `// ${NPM_HEAL_SCRIPT} — reinstall npm using Node's own TLS (run: node ${NPM_HEAL_SCRIPT})`,
    "import https from 'node:https';",
    "import fs from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    "",
    "const caFile = process.env.NODE_EXTRA_CA_CERTS;",
    "const ca = caFile && fs.existsSync(caFile) ? fs.readFileSync(caFile) : undefined;",
    "",
    "function fetch(url, asJson) {",
    "  return new Promise((resolve, reject) => {",
    "    https.get(url, { ca }, (res) => {",
    "      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {",
    "        res.resume();",
    "        resolve(fetch(res.headers.location, asJson));",
    "        return;",
    "      }",
    "      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }",
    "      const chunks = [];",
    "      res.on('data', (c) => chunks.push(c));",
    "      res.on('end', () => resolve(asJson ? JSON.parse(Buffer.concat(chunks)) : Buffer.concat(chunks)));",
    "    }).on('error', reject);",
    "  });",
    "}",
    "",
    `const meta = await fetch('${REGISTRY_URL}/npm/latest', true);`,
    "const tgz = await fetch(meta.dist.tarball, false);",
    "fs.writeFileSync('npm.tgz', tgz);",
    "execFileSync('tar', ['-xzf', 'npm.tgz']);",
    "execFileSync(process.execPath, ['package/bin/npm-cli.js', 'install', '-g', 'npm'], { stdio: 'inherit' });",
    "console.log('npm reinstalled — run: npm --version');",
  );
}

/** L1 — npm broken, Node present, registry reachable: emit the self-heal script. */
export function npmReinstallDoc(): string {
  return lines(
    "npm appears broken but Node can reach the registry. Reinstall npm using Node's",
    `own TLS (which honors NODE_EXTRA_CA_CERTS). Save as ${NPM_HEAL_SCRIPT} and run it:`,
    "",
    `  node ${NPM_HEAL_SCRIPT}`,
    "",
    "Script:",
    npmHealScript(),
  );
}

/**
 * L2 — npm broken AND the registry is unreachable (proxy blocks it). No download
 * is possible here; guide the offline reinstall using the existing npm-cli.js.
 */
export function npmOfflineDoc(cliPath: string | undefined): string {
  const cli = cliPath ?? "<node-dir>/node_modules/npm/bin/npm-cli.js";
  return lines(
    "npm is broken and the registry is NOT reachable (the proxy is blocking TLS, or",
    "the corporate CA is not trusted yet). Fix trust first (heal's certs step), then —",
    "if the network stays blocked — reinstall offline:",
    "",
    "  1. On a machine WITH access, download the npm tarball:",
    `       curl -fL ${REGISTRY_URL}/npm/-/npm-<version>.tgz -o npm.tgz`,
    "  2. Copy npm.tgz to this machine, then reinstall with the bundled CLI:",
    `       node "${cli}" install -g ./npm.tgz`,
  );
}

/** L3 — Node itself is missing; npm cannot be healed without it. */
export function nodeMissingDoc(): string {
  return lines(
    "Node.js was not found on PATH, so npm cannot be healed. Install Node.js >= 20",
    "from your internal software catalog (or nodejs.org if direct downloads are",
    "permitted), reopen your shell, then re-run `aih heal`.",
  );
}

/** Cert trust is broken end-to-end: point at the dedicated `certs` capability. */
export function certFixDoc(caPattern: string, shellFlag: string): string {
  return lines(
    "Corporate TLS trust is not reaching the runtimes. Re-extract the CA from the OS",
    "trust store and re-propagate it (package managers, Go, git, Docker, JVM tools, shell profile):",
    "",
    "  aih certs --apply",
    "",
    `If no CA matched "${caPattern}", pass the intercepting issuer's subject substring:`,
    "",
    `  aih certs ${shellFlag} --apply`,
  );
}

/**
 * Windows-only note paired with the persist-CA exec: GUI-launched apps read env
 * from the per-user registry, not the PowerShell profile, so the CA must be set
 * there for Kiro / Claude Desktop / IDEs to inherit it.
 */
export function guiCaNote(): string {
  return lines(
    "GUI-launched apps (Kiro, Claude Desktop, IDEs) inherit env from the per-user",
    "registry, not your PowerShell profile — so NODE_EXTRA_CA_CERTS is persisted there",
    "too. Relaunch those apps after applying for them to pick up the corporate CA.",
  );
}

/** PATH fix guidance, per shell (advisory: PATH edits are left for the operator). */
export function pathFixDoc(binDir: string, shell: "posix" | "powershell"): string {
  if (shell === "powershell") {
    return lines(
      `Tools are installed in ${binDir} but it is not on PATH. Add it for your user`,
      "(GUI apps included) — this appends without clobbering the existing value:",
      "",
      `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')`,
      "",
      "On cmd.exe, or a locked-down box without PowerShell 7 (or under Constrained",
      "Language Mode, where the [Environment] call above is blocked), use setx. Read",
      "your current USER Path, then append it back — do NOT reuse %Path%, which folds",
      "in the machine Path and can truncate the value at setx's 1024-char limit:",
      "",
      "  reg query HKCU\\Environment /v Path",
      `  setx Path "<current-user-path>;${binDir}"`,
      "",
      `(If that reg query reports no value your user Path is empty — then just: setx Path "${binDir}")`,
      "",
      "Then open a new terminal (and relaunch GUI apps) for it to take effect.",
    );
  }
  return lines(
    `Tools are installed in ${binDir} but it is not on PATH. Add it to your shell`,
    "profile (e.g. ~/.bashrc or ~/.zshrc):",
    "",
    `  export PATH="${binDir}:$PATH"`,
    "",
    "Then reopen your shell (or `source` the profile) for it to take effect.",
  );
}
