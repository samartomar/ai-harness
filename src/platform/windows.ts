import { cpus } from "node:os";
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
import { parseCertLines, parseFirstInt, parseNvidiaSmi } from "./parse.js";

/** Build a non-interactive PowerShell 7 (`pwsh`) invocation for a script string. */
function pwsh(script: string): string[] {
  return ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Build a Windows PowerShell 5.1 (`powershell.exe`) invocation — the fallback when
 * PowerShell 7 is not installed. It ships with every supported Windows and exposes
 * the same `Cert:` drive, so trust-store enumeration still works on stock fleets.
 */
function winPowershell(script: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Windows host adapter. This is the only module that invokes PowerShell/icacls,
 * always through the injected {@link Runner}. Verified on real Windows; parsing
 * is unit-tested against captured PowerShell output fixtures.
 */
export class WindowsAdapter implements HostAdapter {
  readonly platform = "windows" as const;
  readonly verified = true;

  constructor(
    private readonly run: Runner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async trustStoreCerts(pattern: string): Promise<CertEntry[]> {
    const like = `*${safeCaPattern(pattern)}*`;
    const script = [
      `$p = '${like}'`,
      "Get-ChildItem Cert:\\CurrentUser\\Root, Cert:\\LocalMachine\\Root -ErrorAction SilentlyContinue |",
      "  Where-Object { $_.Subject -like $p } |",
      '  ForEach-Object { [System.Convert]::ToBase64String($_.RawData) + "`t" + $_.Subject }',
    ].join("\n");
    let res = await this.run(pwsh(script));
    // PowerShell 7 (pwsh) is not on many managed Windows images — fall back to the
    // built-in Windows PowerShell 5.1 so CA bootstrap doesn't silently find nothing.
    if (res.spawnError) res = await this.run(winPowershell(script));
    if (res.spawnError) return [];
    return parseCertLines(res.stdout);
  }

  lockDownFileArgv(path: string): string[] {
    const user = this.env.USERNAME ?? this.env.USER ?? "%USERNAME%";
    return ["icacls", path, "/inheritance:r", "/grant:r", `${user}:(R)`];
  }

  symlinkDirArgv(linkPath: string, targetPath: string): string[] {
    // Directory junction — works without administrator/Developer-Mode rights.
    return ["cmd", "/c", "mklink", "/J", linkPath, targetPath];
  }

  async cpuPhysicalCores(): Promise<number> {
    const res = await this.run(
      pwsh("(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum"),
    );
    const n = parseFirstInt(res.stdout);
    if (n && n > 0) return n;
    return Math.max(1, Math.floor(cpus().length / 2));
  }

  async totalRamGb(): Promise<number> {
    const res = await this.run(
      pwsh(
        "[math]::Round((Get-CimInstance Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum).Sum/1GB)",
      ),
    );
    const n = parseFirstInt(res.stdout);
    return n && n > 0 ? n : 0;
  }

  async gpu(): Promise<GpuInfo> {
    const res = await this.run([
      "nvidia-smi",
      "--query-gpu=memory.total,name",
      "--format=csv,noheader,nounits",
    ]);
    return parseNvidiaSmi(res.spawnError ? "" : res.stdout);
  }

  detectVdi(): VdiInfo {
    // Explicit declaration (AIH_VDI_KIND, incl. WorkSpaces) + Horizon ViewClient_*
    // + AIH_FORCE_VDI — all honored before the SESSIONNAME/CLIENTNAME heuristics.
    const fromEnv = vdiFromEnv(this.env);
    if (fromEnv) return fromEnv;
    const session = this.env.SESSIONNAME;
    const clientName = this.env.CLIENTNAME;
    if (session && /^ICA/i.test(session)) {
      return { isVdi: true, reason: `Citrix session (SESSIONNAME=${session})`, kind: "citrix" };
    }
    if (session && session !== "Console") {
      return { isVdi: true, reason: `remote session (SESSIONNAME=${session})`, kind: "rdp" };
    }
    if (clientName) {
      return { isVdi: true, reason: `remote client (CLIENTNAME=${clientName})`, kind: "rdp" };
    }
    return { isVdi: false, reason: "no VDI markers (console session)" };
  }

  scratchDir(user: string): string {
    const base = this.env.TEMP ?? this.env.LOCALAPPDATA ?? "C:\\Windows\\Temp";
    return join(base, `aih-scratch-${user}`);
  }

  shellProfilePaths(): string[] {
    const home = this.env.USERPROFILE ?? this.env.HOME ?? "";
    return [join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")];
  }

  envShell(): "powershell" {
    return "powershell";
  }
}
