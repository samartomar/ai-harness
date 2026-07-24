import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { Runner } from "../internals/proc.js";
import {
  type CertEntry,
  dedupeCertEntries,
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

const CA_BUNDLE_PATHS = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

const MAX_ROOT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ROOT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ROOT_FILE_ENTRIES = 512;
const MAX_ROOT_TOTAL_ENTRIES = 1024;
const MAX_ROOT_DIRECTORY_ENTRIES = 1024;
const ROOT_FILE_NAME = /^(?:[0-9a-f]{8}\.\d+|.+\.(?:crt|pem|cer))$/i;

type RootFileRead =
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "missing" }
  | { kind: "invalid" };

type RootDirectoryRead =
  | { kind: "ok"; names: string[]; entries: number }
  | { kind: "missing" }
  | { kind: "invalid" };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function readRootFile(path: string, maxBytes: number): RootFileRead {
  let fd: number | undefined;
  let pathWasStat = false;
  let result: RootFileRead = { kind: "invalid" };
  try {
    const pathStat = statSync(path);
    pathWasStat = true;
    if (
      pathStat.isFile() &&
      Number.isSafeInteger(pathStat.size) &&
      pathStat.size >= 0 &&
      pathStat.size <= maxBytes
    ) {
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      const before = fstatSync(fd);
      if (
        before.isFile() &&
        before.size === pathStat.size &&
        before.dev === pathStat.dev &&
        before.ino === pathStat.ino &&
        before.mtimeMs === pathStat.mtimeMs &&
        before.ctimeMs === pathStat.ctimeMs
      ) {
        const buffer = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < before.size) {
          const read = readSync(fd, buffer, offset, before.size - offset, null);
          if (read <= 0) break;
          offset += read;
        }
        const after = fstatSync(fd);
        if (
          offset === before.size &&
          after.size === before.size &&
          after.dev === before.dev &&
          after.ino === before.ino &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs
        ) {
          result = { kind: "ok", text: buffer.toString("utf8"), bytes: before.size };
        }
      }
    }
  } catch (error) {
    result =
      !pathWasStat && fd === undefined && errorCode(error) === "ENOENT"
        ? { kind: "missing" }
        : result;
  }
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      result = { kind: "invalid" };
    }
  }
  return result;
}

function rootDirectoryNames(path: string, maxEntries: number): RootDirectoryRead {
  let directory: ReturnType<typeof opendirSync> | undefined;
  let result: RootDirectoryRead = { kind: "invalid" };
  try {
    directory = opendirSync(path);
    const names: string[] = [];
    let entries = 0;
    let overflow = false;
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > maxEntries) {
        overflow = true;
        break;
      }
      if (ROOT_FILE_NAME.test(entry.name)) names.push(entry.name);
    }
    if (!overflow) result = { kind: "ok", names: names.sort(), entries };
  } catch (error) {
    result =
      directory === undefined && errorCode(error) === "ENOENT" ? { kind: "missing" } : result;
  }
  if (directory !== undefined) {
    try {
      directory.closeSync();
    } catch {
      result = { kind: "invalid" };
    }
  }
  return result;
}

function boundedPemBlocks(
  text: string,
  subject: string,
  maxEntries: number,
): CertEntry[] | undefined {
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const roots: CertEntry[] = [];
  let from = 0;
  for (let start = text.indexOf(begin, from); start >= 0; start = text.indexOf(begin, from)) {
    const endAt = text.indexOf(end, start + begin.length);
    if (endAt < 0 || roots.length === maxEntries) return undefined;
    roots.push({ subject, pem: `${text.slice(start, endAt + end.length).trim()}\n` });
    from = endAt + end.length;
  }
  return roots;
}

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
    /** Override consolidated system CA bundles (tests); defaults to standard paths. */
    private readonly caBundlePaths: readonly string[] = CA_BUNDLE_PATHS,
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

  async trustStoreRoots(): Promise<CertEntry[]> {
    let totalBytes = 0;
    let totalEntries = 0;
    for (const bundlePath of this.caBundlePaths) {
      const source = readRootFile(
        bundlePath,
        Math.min(MAX_ROOT_FILE_BYTES, MAX_ROOT_TOTAL_BYTES - totalBytes),
      );
      if (source.kind === "missing") continue;
      if (source.kind !== "ok") return [];
      totalBytes += source.bytes;
      if (totalBytes > MAX_ROOT_TOTAL_BYTES) return [];
      const roots = boundedPemBlocks(
        source.text,
        bundlePath,
        Math.min(MAX_ROOT_FILE_ENTRIES, MAX_ROOT_TOTAL_ENTRIES - totalEntries),
      );
      if (roots === undefined) return [];
      totalEntries += roots.length;
      if (totalEntries > MAX_ROOT_TOTAL_ENTRIES) return [];
      if (roots.length > 0) return dedupeCertEntries(roots);
    }

    const roots: CertEntry[] = [];
    let directoryEntries = 0;
    for (const dir of this.anchorDirs) {
      const inventory = rootDirectoryNames(dir, MAX_ROOT_DIRECTORY_ENTRIES - directoryEntries);
      if (inventory.kind === "missing") continue;
      if (inventory.kind !== "ok") return [];
      directoryEntries += inventory.entries;

      for (const name of inventory.names) {
        const source = readRootFile(
          join(dir, name),
          Math.min(MAX_ROOT_FILE_BYTES, MAX_ROOT_TOTAL_BYTES - totalBytes),
        );
        if (source.kind !== "ok") return [];
        totalBytes += source.bytes;
        if (totalBytes > MAX_ROOT_TOTAL_BYTES) return [];
        const subject = `${name} (${dir})`;
        const entries = boundedPemBlocks(
          source.text,
          subject,
          Math.min(MAX_ROOT_FILE_ENTRIES, MAX_ROOT_TOTAL_ENTRIES - totalEntries),
        );
        if (entries === undefined) return [];
        totalEntries += entries.length;
        if (totalEntries > MAX_ROOT_TOTAL_ENTRIES) return [];
        roots.push(...entries);
      }
    }
    return dedupeCertEntries(roots);
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
