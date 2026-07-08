import { describe, expect, it } from "vitest";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import { WindowsAdapter } from "../../src/platform/windows.js";

type Handler = (argv: string[]) => Partial<RunResult> | undefined;

function adapter(handler: Handler, env: NodeJS.ProcessEnv = {}): WindowsAdapter {
  return new WindowsAdapter(fakeRunner(handler), env);
}

describe("WindowsAdapter", () => {
  it("extracts certs from PowerShell base64 output", async () => {
    const a = adapter((argv) =>
      argv[0] === "pwsh" ? { stdout: `${"Q".repeat(80)}\tCN=Zscaler\n` } : undefined,
    );
    const certs = await a.trustStoreCerts("Zscaler");
    expect(certs).toHaveLength(1);
    expect(certs[0]?.pem).toContain("BEGIN CERTIFICATE");
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is absent (AIH-CERTS-001)", async () => {
    const a = adapter((argv) => {
      if (argv[0] === "pwsh") return { spawnError: true, code: 127 }; // no PowerShell 7
      if (argv[0] === "powershell.exe") return { stdout: `${"Q".repeat(80)}\tCN=Zscaler\n` };
      return undefined;
    });
    const certs = await a.trustStoreCerts("Zscaler");
    expect(certs).toHaveLength(1); // recovered via the built-in Windows PowerShell
  });

  it("returns no certs only when NEITHER pwsh nor powershell.exe is available", async () => {
    const a = adapter(() => ({ spawnError: true, code: 127 }));
    expect(await a.trustStoreCerts("Zscaler")).toHaveLength(0);
  });

  it("persists env via setx DIRECTLY — no cmd wrapper that would re-parse the value", () => {
    const a = adapter(() => undefined);
    // A CA path under a legal `R&D` folder: `&`/`%`/`^` are valid path characters. Routing
    // this through `cmd /c setx` would let cmd split on `&` — corrupting the persisted path
    // to `C:\R` and executing `D\certs\ca.pem` as a command. Direct setx.exe spawn (execFile,
    // no shell) keeps the whole path as one literal argv element.
    const argv = a.persistentEnvArgv("NODE_EXTRA_CA_CERTS", "C:\\R&D\\certs\\ca%1.pem");
    expect(argv).toEqual(["setx", "NODE_EXTRA_CA_CERTS", "C:\\R&D\\certs\\ca%1.pem"]);
    expect(argv[0]).not.toBe("cmd");
  });

  it("parses physical cores and total RAM", async () => {
    const a = adapter((argv) => {
      const s = argv.join(" ");
      if (s.includes("NumberOfCores")) return { stdout: "8\n" };
      if (s.includes("Capacity")) return { stdout: "32\n" };
      return undefined;
    });
    expect(await a.cpuPhysicalCores()).toBe(8);
    expect(await a.totalRamGb()).toBe(32);
  });

  it("falls back to Windows PowerShell for physical RAM when pwsh is absent", async () => {
    const a = adapter((argv) => {
      const s = argv.join(" ");
      if (argv[0] === "pwsh" && s.includes("Capacity")) return { spawnError: true, code: 127 };
      if (argv[0] === "powershell.exe" && s.includes("Capacity")) return { stdout: "64\n" };
      return undefined;
    });
    expect(await a.totalRamGb()).toBe(64);
  });

  it("never reports zero RAM when the Windows RAM probe cannot run", async () => {
    const a = adapter((argv) => {
      if (argv[0] === "pwsh" || argv[0] === "powershell.exe") {
        return { spawnError: true, code: 127 };
      }
      return undefined;
    });
    expect(await a.totalRamGb()).toBeGreaterThan(0);
  });

  it("detects an NVIDIA GPU via nvidia-smi", async () => {
    const a = adapter((argv) =>
      argv[0] === "nvidia-smi" ? { stdout: "12288, RTX 4070\n" } : undefined,
    );
    expect(await a.gpu()).toMatchObject({ vendor: "nvidia", vramGb: 12 });
  });

  it("falls back to none when nvidia-smi is absent", async () => {
    const a = adapter(() => ({ spawnError: true, code: 127 }));
    expect((await a.gpu()).vendor).toBe("none");
  });

  it("classifies Citrix, RDP and console sessions", () => {
    expect(adapter(() => undefined, { SESSIONNAME: "ICA-tcp#0" }).detectVdi()).toMatchObject({
      isVdi: true,
      kind: "citrix",
    });
    expect(adapter(() => undefined, { SESSIONNAME: "RDP-Tcp#1" }).detectVdi()).toMatchObject({
      isVdi: true,
      kind: "rdp",
    });
    expect(adapter(() => undefined, { SESSIONNAME: "Console" }).detectVdi().isVdi).toBe(false);
  });

  it("honors explicit declarations and Horizon markers (wires the workspaces kind)", () => {
    // Fleet imaging can pin the platform — the only reliable way to flag Amazon
    // WorkSpaces, which exposes no dependable session env marker.
    expect(adapter(() => undefined, { AIH_VDI_KIND: "workspaces" }).detectVdi()).toMatchObject({
      isVdi: true,
      kind: "workspaces",
    });
    // AIH_FORCE_VDI is now honored on Windows (it was silently ignored before).
    expect(adapter(() => undefined, { AIH_FORCE_VDI: "1" }).detectVdi()).toMatchObject({
      isVdi: true,
      kind: "generic",
    });
    // VMware/Omnissa Horizon exports ViewClient_* into the session.
    expect(
      adapter(() => undefined, { ViewClient_Machine_Name: "vdihost01" }).detectVdi(),
    ).toMatchObject({ isVdi: true, kind: "generic" });
    // An unrecognized AIH_VDI_KIND is ignored — falls through to the console default.
    expect(adapter(() => undefined, { AIH_VDI_KIND: "bogus" }).detectVdi().isVdi).toBe(false);
  });

  it("builds an icacls lockdown argv for the current user", () => {
    const a = adapter(() => undefined, { USERNAME: "samar" });
    expect(a.lockDownFileArgv("C:/x/ca.pem")).toEqual([
      "icacls",
      "C:/x/ca.pem",
      "/inheritance:r",
      "/grant:r",
      "samar:(R)",
    ]);
  });

  it("builds a directory junction argv", () => {
    const a = adapter(() => undefined);
    expect(a.symlinkDirArgv("C:/link", "C:/target")).toEqual([
      "cmd",
      "/c",
      "mklink",
      "/J",
      "C:/link",
      "C:/target",
    ]);
  });
});
