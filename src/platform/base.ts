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
