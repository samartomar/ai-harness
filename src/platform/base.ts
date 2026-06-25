import type { Runner } from "../internals/proc.js";

export type Platform = "windows" | "darwin" | "linux";
export type GpuVendor = "nvidia" | "apple" | "amd" | "none";
export type AccelBackend = "cuda" | "mps" | "rocm" | "cpu";
export type EnvShell = "posix" | "powershell";

export interface GpuInfo {
  vendor: GpuVendor;
  backend: AccelBackend;
  /** Total VRAM in GB; 0 when unknown or no discrete GPU. */
  vramGb: number;
  name?: string;
}

export interface VdiInfo {
  isVdi: boolean;
  /** The signal that matched, or why none did. */
  reason: string;
  kind?: "citrix" | "workspaces" | "res" | "rdp" | "generic";
}

export interface CertEntry {
  subject: string;
  /** PEM-encoded certificate (BEGIN/END CERTIFICATE). */
  pem: string;
}

/**
 * OS-specific behaviour behind one interface. Only the adapter matching the host
 * is `verified` (smoke-tested on real metal); the others are implemented and
 * unit-tested against captured fixture output but flagged unverified. Every
 * method that shells out does so through the injected {@link Runner}.
 */
export interface HostAdapter {
  readonly platform: Platform;
  readonly verified: boolean;

  /** Corporate root CAs whose subject contains `pattern`, from the OS trust store. */
  trustStoreCerts(pattern: string): Promise<CertEntry[]>;
  /** The argv that would restrict `path` to the current user (icacls/chmod). Not executed here. */
  lockDownFileArgv(path: string): string[];
  /** The argv that creates a directory symlink/junction at `linkPath` → `targetPath`. */
  symlinkDirArgv(linkPath: string, targetPath: string): string[];
  cpuPhysicalCores(): Promise<number>;
  totalRamGb(): Promise<number>;
  gpu(): Promise<GpuInfo>;
  detectVdi(): VdiInfo;
  /** Local, non-synced scratch root for caches/SQLite on this host. */
  scratchDir(user: string): string;
  /** Shell profile file(s) where env exports belong. */
  shellProfilePaths(): string[];
  envShell(): EnvShell;
}

/** Construction shape shared by the concrete adapters. */
export type AdapterFactory = (run: Runner, env: NodeJS.ProcessEnv) => HostAdapter;

/** Wrap raw base64 DER into a PEM certificate block with 64-char lines. */
export function derBase64ToPem(base64: string): string {
  const body =
    base64
      .replace(/\s+/g, "")
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** Validate a CA subject-match pattern (used in shell commands). Conservative allowlist. */
export function safeCaPattern(pattern: string): string {
  if (!/^[A-Za-z0-9 ._*-]{1,128}$/.test(pattern)) {
    throw new Error(`unsafe CA pattern: ${JSON.stringify(pattern)}`);
  }
  return pattern;
}

/** VDI kinds an operator may declare explicitly via `AIH_VDI_KIND`. */
const VDI_KINDS = ["citrix", "workspaces", "res", "rdp", "generic"] as const;

/**
 * Cross-platform, env-based VDI signals shared by every host adapter, checked
 * before the per-OS heuristics:
 *  - `AIH_VDI_KIND=<citrix|workspaces|res|rdp|generic>` lets fleet imaging pin the
 *    platform deterministically — the only reliable way to flag Amazon WorkSpaces
 *    or AVD, which expose no dependable env marker (this is what finally wires the
 *    `workspaces` kind into a reachable code path);
 *  - `AIH_FORCE_VDI=1` forces a generic VDI (back-compat; now honored on Windows
 *    too, which previously ignored it);
 *  - VMware / Omnissa Horizon exports `ViewClient_*` into the session, a genuine
 *    env-detectable marker.
 * Returns undefined when nothing matches, so the caller's OS-specific heuristics run.
 */
export function vdiFromEnv(env: NodeJS.ProcessEnv): VdiInfo | undefined {
  const declared = env.AIH_VDI_KIND?.trim().toLowerCase();
  if (declared && (VDI_KINDS as readonly string[]).includes(declared)) {
    return {
      isVdi: true,
      reason: `declared via AIH_VDI_KIND=${declared}`,
      kind: declared as VdiInfo["kind"],
    };
  }
  if (env.AIH_FORCE_VDI === "1") {
    return { isVdi: true, reason: "forced via AIH_FORCE_VDI=1", kind: "generic" };
  }
  if (Object.keys(env).some((k) => /^ViewClient_/i.test(k))) {
    return {
      isVdi: true,
      reason: "VMware/Omnissa Horizon session (ViewClient_*)",
      kind: "generic",
    };
  }
  return undefined;
}
