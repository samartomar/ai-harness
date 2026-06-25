import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Runner } from "../internals/proc.js";
import {
  type CertEntry,
  type GpuInfo,
  type HostAdapter,
  safeCaPattern,
  type VdiInfo,
  vdiFromEnv,
} from "./base.js";
import { parseFirstInt, parseNvidiaSmi } from "./parse.js";
import { posixNpmCliPath, posixTlsProbeArgv } from "./posix.js";

const ANCHOR_DIRS = [
  "/usr/local/share/ca-certificates",
  "/etc/pki/ca-trust/source/anchors",
  "/etc/ssl/certs",
];

/**
 * Linux host adapter (implemented, fixture-tested, not smoke-tested on this box).
 * Trust-store matching is filename-based across the standard anchor dirs (no
 * openssl dependency); hardware facts come from /proc with runner fallbacks.
 */
export class LinuxAdapter implements HostAdapter {
  readonly platform = "linux" as const;
  // Smoke-tested on real metal (Ubuntu 24.04, kernel 6.8) via a Hyper-V VM:
  // real /proc profiling, /etc/ssl/certs extraction, chmod lockdown, and ln -sfn.
  readonly verified = true;

  constructor(
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
    /** Override the trust-store anchor dirs (tests); defaults to the system set. */
    private readonly anchorDirs: readonly string[] = ANCHOR_DIRS,
  ) {}

  async trustStoreCerts(pattern: string): Promise<CertEntry[]> {
    const needle = safeCaPattern(pattern).toLowerCase();
    const out: CertEntry[] = [];
    const seen = new Set<string>();
    for (const dir of this.anchorDirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      // The consolidated system bundle is huge and full of public roots — match it
      // by filename only (loose subject matching there could pull an unrelated CA).
      const canSubjectMatch = dir !== "/etc/ssl/certs";
      for (const name of names) {
        if (!/\.(crt|pem|cer)$/i.test(name)) continue;
        const full = join(dir, name);
        const byFilename = name.toLowerCase().includes(needle);
        if (!byFilename && !canSubjectMatch) continue;
        // Admin-added corporate CAs in the SOURCE anchor dirs often have a filename
        // that doesn't contain the issuer name — match the cert SUBJECT too, via
        // openssl. Best-effort: absent/erroring openssl just falls back to filename
        // matching (no hard dependency, preserving the original behavior).
        const bySubject =
          !byFilename && canSubjectMatch ? await this.subjectMatches(full, needle) : false;
        if (!byFilename && !bySubject) continue;
        try {
          const raw = readFileSync(full, "utf8");
          if (!raw.includes("BEGIN CERTIFICATE")) continue;
          const pem = raw.endsWith("\n") ? raw : `${raw}\n`;
          if (seen.has(pem)) continue;
          seen.add(pem);
          out.push({ subject: `${name} (${dir})`, pem });
        } catch {
          // skip unreadable
        }
      }
    }
    return out;
  }

  /** Best-effort subject match via openssl; false when openssl is absent or errors. */
  private async subjectMatches(path: string, needle: string): Promise<boolean> {
    const res = await this.run(["openssl", "x509", "-in", path, "-noout", "-subject"]);
    if (res.spawnError || res.code !== 0) return false;
    return res.stdout.toLowerCase().includes(needle);
  }

  lockDownFileArgv(path: string): string[] {
    return ["chmod", "600", path];
  }

  symlinkDirArgv(linkPath: string, targetPath: string): string[] {
    return ["ln", "-sfn", targetPath, linkPath];
  }

  async cpuPhysicalCores(): Promise<number> {
    try {
      const info = readFileSync("/proc/cpuinfo", "utf8");
      const cores = countPhysicalCores(info);
      if (cores > 0) return cores;
    } catch {
      // not a /proc system
    }
    const res = await this.run(["nproc"]);
    const n = parseFirstInt(res.stdout);
    return n && n > 0 ? n : Math.max(1, cpus().length);
  }

  async totalRamGb(): Promise<number> {
    try {
      const info = readFileSync("/proc/meminfo", "utf8");
      const kb = parseMemTotalKb(info);
      if (kb && kb > 0) return Math.round(kb / 1024 / 1024);
    } catch {
      // fall through
    }
    return Math.round(totalmem() / 1024 ** 3);
  }

  async gpu(): Promise<GpuInfo> {
    const smi = await this.run([
      "nvidia-smi",
      "--query-gpu=memory.total,name",
      "--format=csv,noheader,nounits",
    ]);
    return parseNvidiaSmi(smi.spawnError ? "" : smi.stdout);
  }

  detectVdi(): VdiInfo {
    // Explicit declaration (AIH_VDI_KIND) + Horizon ViewClient_* + AIH_FORCE_VDI,
    // checked before the /scratch and XRDP heuristics.
    const fromEnv = vdiFromEnv(this.env);
    if (fromEnv) return fromEnv;
    if (existsSync("/scratch")) {
      return { isVdi: true, reason: "/scratch mount present", kind: "res" };
    }
    if (this.env.XRDP_SESSION) {
      return { isVdi: true, reason: "remote desktop session env (XRDP_SESSION)", kind: "rdp" };
    }
    if (this.env.SESSIONNAME && this.env.SESSIONNAME !== "Console") {
      return { isVdi: true, reason: `SESSIONNAME=${this.env.SESSIONNAME}`, kind: "generic" };
    }
    return { isVdi: false, reason: "no VDI markers" };
  }

  scratchDir(user: string): string {
    if (existsSync("/scratch")) return join("/scratch", `aih-${user}`);
    const base = this.env.XDG_RUNTIME_DIR ?? "/tmp";
    return join(base, `aih-scratch-${user}`);
  }

  shellProfilePaths(): string[] {
    const home = this.env.HOME ?? "";
    return [join(home, ".bashrc")];
  }

  envShell(): "posix" {
    return "posix";
  }

  // POSIX persistence is the shell-profile envblock, so no separate registry-style
  // exec is needed — the caller emits nothing when this is empty.
  persistentEnvArgv(): string[] {
    return [];
  }

  npmCliPath(): string | undefined {
    return posixNpmCliPath();
  }

  tlsProbeArgv(url: string): string[] {
    return posixTlsProbeArgv(url);
  }
}

// ---- parsers (pure; unit-tested against fixtures) -------------------------

/** Count distinct (physical id, core id) pairs in /proc/cpuinfo. */
export function countPhysicalCores(cpuinfo: string): number {
  const blocks = cpuinfo.split(/\n\s*\n/);
  const seen = new Set<string>();
  let sawTopology = false;
  for (const block of blocks) {
    const phys = block.match(/physical id\s*:\s*(\d+)/);
    const core = block.match(/core id\s*:\s*(\d+)/);
    if (phys && core) {
      sawTopology = true;
      seen.add(`${phys[1]}:${core[1]}`);
    }
  }
  if (sawTopology) return seen.size;
  // No topology info (e.g. VM): fall back to processor count.
  return (cpuinfo.match(/^processor\s*:/gm) ?? []).length;
}

/** Read MemTotal (kB) from /proc/meminfo. */
export function parseMemTotalKb(meminfo: string): number | undefined {
  const m = meminfo.match(/MemTotal:\s*(\d+)\s*kB/i);
  return m ? Number.parseInt(m[1] as string, 10) : undefined;
}
