import { describe, expect, it } from "vitest";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { DarwinAdapter } from "../../src/platform/darwin.js";

type Handler = Parameters<typeof fakeRunner>[0];
const mk = (handler: Handler, env: NodeJS.ProcessEnv = {}): DarwinAdapter =>
  new DarwinAdapter(fakeRunner(handler) as Runner, env);

describe("DarwinAdapter trust store", () => {
  it("queries the per-user login keychain alongside the system keychains", async () => {
    const queried: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] !== "security") return undefined;
      const line = argv.join(" ");
      queried.push(line);
      // Return a cert only for the login keychain to prove it is consulted.
      return line.includes("login.keychain-db")
        ? { stdout: "-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n" }
        : undefined;
    });
    const a = new DarwinAdapter(run, { HOME: "/Users/sam" });
    const certs = await a.trustStoreCerts("Corp");
    // path.join uses the host separator, so normalize before matching the macOS path.
    const norm = (s: string) => s.replace(/\\/g, "/");
    expect(
      queried.some((q) => norm(q).includes("/Users/sam/Library/Keychains/login.keychain-db")),
    ).toBe(true);
    expect(certs.length).toBeGreaterThan(0);
  });

  it("consults only the system keychains when HOME is unset", async () => {
    const queried: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "security") queried.push(argv.join(" "));
      return undefined;
    });
    const a = new DarwinAdapter(run, {});
    await a.trustStoreCerts("Corp");
    expect(queried.some((q) => q.includes("login.keychain-db"))).toBe(false);
    expect(queried.some((q) => q.includes("System.keychain"))).toBe(true);
  });
});

describe("DarwinAdapter hardware + host facts", () => {
  it("reads physical cores from sysctl, falls back when the call fails", async () => {
    const a = mk((argv) =>
      argv.join(" ").includes("hw.physicalcpu") ? { stdout: "10\n" } : undefined,
    );
    expect(await a.cpuPhysicalCores()).toBe(10);
    expect(await mk(() => ({ spawnError: true, code: 127 })).cpuPhysicalCores()).toBeGreaterThan(0);
  });

  it("converts hw.memsize bytes to GB, falls back when absent", async () => {
    const bytes = String(32 * 1024 ** 3);
    const a = mk((argv) => (argv.join(" ").includes("hw.memsize") ? { stdout: bytes } : undefined));
    expect(await a.totalRamGb()).toBe(32);
    expect(await mk(() => ({ spawnError: true, code: 127 })).totalRamGb()).toBeGreaterThan(0);
  });

  it("detects Apple Silicon (mps, unified memory) via hw.optional.arm64", async () => {
    const a = mk((argv) => {
      const s = argv.join(" ");
      if (s.includes("arm64")) return { stdout: "1\n" };
      if (s.includes("hw.memsize")) return { stdout: String(24 * 1024 ** 3) };
      return undefined;
    });
    expect(await a.gpu()).toMatchObject({ vendor: "apple", backend: "mps", vramGb: 24 });
  });

  it("falls back to nvidia-smi on a non-Apple-Silicon Mac", async () => {
    const a = mk((argv) => {
      const s = argv.join(" ");
      if (s.includes("arm64")) return { stdout: "0\n" };
      if (argv[0] === "nvidia-smi") return { stdout: "8192, RTX A2000\n" };
      return undefined;
    });
    expect(await a.gpu()).toMatchObject({ vendor: "nvidia", vramGb: 8 });
  });

  it("reports no GPU on an Intel Mac without nvidia-smi", async () => {
    const a = mk((argv) =>
      argv.join(" ").includes("arm64") ? { stdout: "0\n" } : { spawnError: true },
    );
    expect((await a.gpu()).vendor).toBe("none");
  });

  it("honors an explicit AIH_FORCE_VDI declaration, else reports native macOS", () => {
    expect(mk(() => undefined, { AIH_FORCE_VDI: "1" }).detectVdi().isVdi).toBe(true);
    expect(mk(() => undefined, {}).detectVdi().isVdi).toBe(false);
  });

  it("scratchDir honors TMPDIR else /tmp; profile is ~/.zshrc; posix shell", () => {
    // path.join uses the host separator, so normalize before matching macOS paths.
    const norm = (s: string) => s.replace(/\\/g, "/");
    expect(norm(mk(() => undefined, { TMPDIR: "/fast" }).scratchDir("sam"))).toBe(
      "/fast/aih-scratch-sam",
    );
    expect(norm(mk(() => undefined, {}).scratchDir("sam"))).toBe("/tmp/aih-scratch-sam");
    expect(norm(mk(() => undefined, { HOME: "/Users/sam" }).shellProfilePaths()[0] ?? "")).toBe(
      "/Users/sam/.zshrc",
    );
    expect(mk(() => undefined, {}).envShell()).toBe("posix");
  });

  it("lockDownFileArgv uses chmod 600; symlinkDirArgv uses ln -sfn", () => {
    const a = mk(() => undefined, {});
    expect(a.lockDownFileArgv("/x/pem")).toEqual(["chmod", "600", "/x/pem"]);
    expect(a.symlinkDirArgv("/link", "/target")).toEqual(["ln", "-sfn", "/target", "/link"]);
  });
});
