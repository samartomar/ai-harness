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
import { parseFirstInt, parseNvidiaSmi, parsePemBlocks } from "./parse.js";

/**
 * macOS host adapter (implemented, fixture-tested, not smoke-tested on this box).
 * Uses `security` for trust-store export and `sysctl` for hardware facts.
 */
export class DarwinAdapter implements HostAdapter {
  readonly platform = "darwin" as const;
  readonly verified = false;

  constructor(
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async trustStoreCerts(pattern: string): Promise<CertEntry[]> {
    const p = safeCaPattern(pattern);
    const keychains = [
      "/Library/Keychains/System.keychain",
      "/System/Library/Keychains/SystemRootCertificates.keychain",
    ];
    const found: CertEntry[] = [];
    for (const kc of keychains) {
      const res = await this.run(["security", "find-certificate", "-a", "-p", "-c", p, kc]);
      if (!res.spawnError && res.stdout.includes("BEGIN CERTIFICATE")) {
        found.push(...parsePemBlocks(res.stdout, `${p} (${kc})`));
      }
    }
    return found;
  }

  lockDownFileArgv(path: string): string[] {
    return ["chmod", "600", path];
  }

  symlinkDirArgv(linkPath: string, targetPath: string): string[] {
    return ["ln", "-sfn", targetPath, linkPath];
  }

  async cpuPhysicalCores(): Promise<number> {
    const res = await this.run(["sysctl", "-n", "hw.physicalcpu"]);
    const n = parseFirstInt(res.stdout);
    return n && n > 0 ? n : Math.max(1, cpus().length);
  }

  async totalRamGb(): Promise<number> {
    const res = await this.run(["sysctl", "-n", "hw.memsize"]);
    const bytes = parseFirstInt(res.stdout);
    if (bytes && bytes > 0) return Math.round(bytes / 1024 ** 3);
    return Math.round(totalmem() / 1024 ** 3);
  }

  async gpu(): Promise<GpuInfo> {
    const arm = await this.run(["sysctl", "-n", "hw.optional.arm64"]);
    if (parseFirstInt(arm.stdout) === 1) {
      const ram = await this.totalRamGb();
      return {
        vendor: "apple",
        backend: "mps",
        vramGb: ram,
        name: "Apple Silicon (unified memory)",
      };
    }
    const smi = await this.run([
      "nvidia-smi",
      "--query-gpu=memory.total,name",
      "--format=csv,noheader,nounits",
    ]);
    return parseNvidiaSmi(smi.spawnError ? "" : smi.stdout);
  }

  detectVdi(): VdiInfo {
    if (this.env.AIH_FORCE_VDI === "1") {
      return { isVdi: true, reason: "AIH_FORCE_VDI=1", kind: "generic" };
    }
    return { isVdi: false, reason: "no VDI markers (native macOS)" };
  }

  scratchDir(user: string): string {
    const base = this.env.TMPDIR ?? "/tmp";
    return join(base, `aih-scratch-${user}`);
  }

  shellProfilePaths(): string[] {
    const home = this.env.HOME ?? "";
    return [join(home, ".zshrc")];
  }

  envShell(): "posix" {
    return "posix";
  }
}
