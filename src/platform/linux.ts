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
} from "./base.js";
import { parseFirstInt, parseNvidiaSmi } from "./parse.js";

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
  readonly verified = false;

  constructor(
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async trustStoreCerts(pattern: string): Promise<CertEntry[]> {
    const p = safeCaPattern(pattern).toLowerCase();
    const out: CertEntry[] = [];
    for (const dir of ANCHOR_DIRS) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/\.(crt|pem|cer)$/i.test(name)) continue;
        if (!name.toLowerCase().includes(p)) continue;
        try {
          const pem = readFileSync(join(dir, name), "utf8");
          if (pem.includes("BEGIN CERTIFICATE")) {
            out.push({ subject: `${name} (${dir})`, pem: pem.endsWith("\n") ? pem : `${pem}\n` });
          }
        } catch {
          // skip unreadable
        }
      }
    }
    return out;
  }

  lockDownFileArgv(path: string): string[] {
    return ["chmod", "600", path];
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
    if (existsSync("/scratch")) {
      return { isVdi: true, reason: "/scratch mount present", kind: "res" };
    }
    if (this.env.XRDP_SESSION || this.env.AIH_FORCE_VDI === "1") {
      return { isVdi: true, reason: "remote desktop session env", kind: "rdp" };
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
