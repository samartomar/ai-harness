import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../errors.js";

export interface InertDiscoveryInput {
  root: string;
  treeSha256: string;
}

export interface InertProviderDiscovery {
  manifestPath: "package.json" | undefined;
  packageName: string | undefined;
  scripts: Readonly<Record<string, string>>;
  installerEntries: readonly string[];
  installerContractFingerprint: string;
  providerCodeExecuted: false;
}

const INSTALLER_SCRIPT_NAMES = new Set(["install", "setup", "uninstall", "update", "repair"]);

function discoveryFailure(message: string): never {
  throw new AihError(message, "QUALIFICATION_INCOMPLETE");
}

function parseManifest(root: string): {
  packageName: string | undefined;
  scripts: Record<string, string>;
} {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { packageName: undefined, scripts: {} };
  if (lstatSync(path).isSymbolicLink())
    discoveryFailure("provider manifest must not be a symbolic link");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return discoveryFailure("provider manifest is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return discoveryFailure("provider manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  const packageName = typeof manifest.name === "string" ? manifest.name : undefined;
  if (manifest.scripts === undefined) return { packageName, scripts: {} };
  if (
    manifest.scripts === null ||
    typeof manifest.scripts !== "object" ||
    Array.isArray(manifest.scripts)
  ) {
    return discoveryFailure("provider manifest scripts must be an object");
  }
  const scripts = Object.entries(manifest.scripts as Record<string, unknown>);
  if (scripts.some(([, script]) => typeof script !== "string")) {
    return discoveryFailure("provider manifest scripts must contain only strings");
  }
  return {
    packageName,
    scripts: Object.fromEntries(
      scripts
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, script]) => [name, script as string] as [string, string]),
    ),
  };
}

export function discoverInertProvider(input: InertDiscoveryInput): InertProviderDiscovery {
  const manifest = parseManifest(input.root);
  const installerEntries = Object.keys(manifest.scripts).filter((name) =>
    INSTALLER_SCRIPT_NAMES.has(name),
  );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({ treeSha256: input.treeSha256, scripts: manifest.scripts, installerEntries }),
      "utf8",
    )
    .digest("hex");
  return {
    manifestPath: existsSync(join(input.root, "package.json")) ? "package.json" : undefined,
    packageName: manifest.packageName,
    scripts: manifest.scripts,
    installerEntries,
    installerContractFingerprint: fingerprint,
    providerCodeExecuted: false,
  };
}
