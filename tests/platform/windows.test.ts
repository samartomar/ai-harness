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
});
