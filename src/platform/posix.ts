import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * POSIX (macOS + Linux) implementations of the heal-facing {@link HostAdapter}
 * methods, shared so the two adapters stay byte-identical here. Windows differs
 * (registry env, a different npm layout, a PowerShell TLS probe) and implements
 * its own.
 */

/**
 * npm's `npm-cli.js` relative to the running Node. POSIX installs put Node at
 * `<prefix>/bin/node` and npm at `<prefix>/lib/node_modules/npm/bin/npm-cli.js`.
 * Returns `undefined` when it cannot be located.
 */
export function posixNpmCliPath(): string | undefined {
  const binDir = dirname(process.execPath); // <prefix>/bin
  const cli = join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(cli) ? cli : undefined;
}

/** A read-only TLS reachability probe via curl — present on macOS and modern Linux. */
export function posixTlsProbeArgv(url: string): string[] {
  return ["curl", "-Iv", "--max-time", "20", url];
}
