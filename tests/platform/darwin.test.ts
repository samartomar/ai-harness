import { describe, expect, it, vi } from "vitest";
import {
  macLaunchAgentPlist,
  NODE_EXTRA_CA_CERTS,
  NODE_USE_SYSTEM_CA,
  nodeTrustEnvVars,
  nodeTrustPersistenceActions,
} from "../../src/certs/node-env.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner, type Runner, type RunOptions } from "../../src/internals/proc.js";
import { DarwinAdapter } from "../../src/platform/darwin.js";

type Handler = Parameters<typeof fakeRunner>[0];
const mk = (handler: Handler, env: NodeJS.ProcessEnv = {}): DarwinAdapter =>
  new DarwinAdapter(fakeRunner(handler) as Runner, env);

function persistenceCtx(env: NodeJS.ProcessEnv = { HOME: "/Users/R&D" }): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: "/repo",
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: new DarwinAdapter(run, env),
    env,
    options: {},
  };
}

const pem = (body: string): string =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
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

  it("retains only user, admin, and SystemRoot certificates proven trusted", async () => {
    const userTrusted = pem("QQ==");
    const adminTrusted = pem("Qg==");
    const systemTrusted = pem("Qw==");
    const importedUntrusted = pem("RA==");
    const findCalls: string[][] = [];
    const verifyCalls: Array<{ argv: string[]; opts: RunOptions | undefined }> = [];
    const a = mk(
      (argv, opts) => {
        if (argv[0] !== "security") return undefined;
        if (argv[1] === "find-certificate") {
          findCalls.push(argv);
          const keychain = argv.at(-1) ?? "";
          if (keychain.includes("login.keychain-db")) {
            return { stdout: `${userTrusted}${importedUntrusted}` };
          }
          if (keychain.includes("SystemRootCertificates")) {
            return { stdout: systemTrusted };
          }
          return { stdout: `${adminTrusted}${userTrusted}` };
        }
        if (argv[1] === "verify-cert") {
          verifyCalls.push({ argv, opts });
          return { code: opts?.input === importedUntrusted ? 1 : 0 };
        }
        return undefined;
      },
      { HOME: "/Users/example" },
    );

    const certs = await a.trustStoreRoots();

    expect(certs.map((cert) => cert.pem)).toEqual([userTrusted, adminTrusted, systemTrusted]);
    expect(findCalls).toHaveLength(3);
    expect(findCalls.every((argv) => !argv.includes("-c"))).toBe(true);
    expect(verifyCalls).toHaveLength(4);
    expect(
      verifyCalls.every(({ argv }) =>
        argv.join(" ").includes("security verify-cert -c /dev/stdin -l -L -q"),
      ),
    ).toBe(true);
    expect(verifyCalls.every(({ opts }) => opts?.maxBufferBytes === 4096)).toBe(true);
  });
});
it("fails closed when aggregate root verification time is exhausted", async () => {
  const first = pem("QQ==");
  const second = pem("Qg==");
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValue(60_000);
  const verifyCalls: RunOptions[] = [];
  const a = mk((argv, opts) => {
    if (argv[0] !== "security") return undefined;
    if (argv[1] === "find-certificate") return { code: 0, stdout: `${first}${second}` };
    if (argv[1] === "verify-cert") {
      if (opts !== undefined) verifyCalls.push(opts);
      return { code: 0 };
    }
    return undefined;
  });

  expect(await a.trustStoreRoots()).toEqual([]);
  expect(verifyCalls).toHaveLength(1);
  expect(verifyCalls[0]?.timeoutMs).toBe(20_000);
  now.mockRestore();
});

describe("macOS Node trust persistence", () => {
  it("escapes every interpolated plist value and uses literal ProgramArguments", () => {
    const plist = macLaunchAgentPlist(
      "dev.aih.env.node-extra-ca-certs",
      "NODE_EXTRA_CA_CERTS",
      `/Users/R&D/<certs>/"quoted"/'bundle'.pem`,
    );

    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;certs&gt;");
    expect(plist).toContain("&quot;quoted&quot;");
    expect(plist).toContain("&apos;bundle&apos;");
    expect(plist).toContain("<string>/bin/launchctl</string>");
    expect(plist).toContain("<string>setenv</string>");
    expect(plist).not.toContain("/bin/sh");
  });

  it("plans sorted idempotent LaunchAgents plus direct launchctl argv", () => {
    const ctx = persistenceCtx();
    const actions = nodeTrustPersistenceActions(ctx, nodeTrustEnvVars("/Users/R&D/certs/ca.pem"));
    const plists = actions.filter((action) => action.kind === "write");
    const launchctl = actions.filter((action) => action.kind === "exec");

    expect(plists.map((action) => action.path)).toEqual([
      "/Users/R&D/Library/LaunchAgents/dev.aih.env.node-extra-ca-certs.plist",
      "/Users/R&D/Library/LaunchAgents/dev.aih.env.node-use-system-ca.plist",
    ]);
    expect(plists.every((action) => action.external === true)).toBe(true);
    expect(plists.map((action) => action.contents)).toEqual(
      [...plists.map((action) => action.contents)].sort(),
    );
    expect(launchctl.map((action) => action.argv)).toEqual([
      ["/bin/launchctl", "setenv", "NODE_EXTRA_CA_CERTS", "/Users/R&D/certs/ca.pem"],
      ["/bin/launchctl", "setenv", "NODE_USE_SYSTEM_CA", "1"],
    ]);
  });

  it("preserves a validated Windows HOME path style for LaunchAgent paths", () => {
    const home = "C:\\Users\\example";
    const actions = nodeTrustPersistenceActions(persistenceCtx({ HOME: home }), nodeTrustEnvVars());
    const plists = actions.filter((action) => action.kind === "write");

    expect(plists.map((action) => action.path)).toEqual([
      `${home}\\Library\\LaunchAgents\\dev.aih.env.node-extra-ca-certs.plist`,
      `${home}\\Library\\LaunchAgents\\dev.aih.env.node-use-system-ca.plist`,
    ]);
  });

  it("enables selected launchd trust before neutralizing the unselected value", () => {
    const actions = nodeTrustPersistenceActions(
      persistenceCtx({
        HOME: "/Users/example",
        NODE_EXTRA_CA_CERTS: "/Users/example/stale-exact.pem",
        Node_Extra_Ca_Certs: "/Users/example/stale-mixed.pem",
      }),
      nodeTrustEnvVars(),
    );
    const plists = actions.filter((action) => action.kind === "write");
    const launchctl = actions.filter((action) => action.kind === "exec");

    expect(plists).toHaveLength(2);
    expect(
      plists.find((action) => action.path.includes("node-extra-ca-certs"))?.contents,
    ).toContain("<string>unsetenv</string>");
    expect(
      plists.find((action) => action.path.includes("node-extra-ca-certs"))?.contents,
    ).not.toContain("stale-exact.pem");
    expect(launchctl.map((action) => action.argv)).toEqual([
      ["/bin/launchctl", "setenv", "NODE_USE_SYSTEM_CA", "1"],
      ["/bin/launchctl", "unsetenv", "NODE_EXTRA_CA_CERTS"],
    ]);
    expect(launchctl.every((action) => action.requiresPriorExecSuccess)).toBe(true);
  });

  it("preserves prior launchd trust when enabling the selected value fails", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: argv[1] === "setenv" ? 5 : 0 };
    });
    const planned = nodeTrustPersistenceActions(
      persistenceCtx({ HOME: "/Users/example" }),
      nodeTrustEnvVars(),
    ).filter((action) => action.kind === "exec");

    await executePlan(plan("macOS trust persistence", ...planned), {
      ...persistenceCtx({ HOME: "/Users/example" }),
      apply: true,
      run,
    });

    expect(calls).toEqual([["/bin/launchctl", "setenv", NODE_USE_SYSTEM_CA, "1"]]);
  });

  it("enables selected launchd trust before a failed stale-value clear", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { code: argv[1] === "unsetenv" ? 5 : 0 };
    });
    const planned = nodeTrustPersistenceActions(
      persistenceCtx({ HOME: "/Users/example" }),
      nodeTrustEnvVars(),
    ).filter((action) => action.kind === "exec");

    await executePlan(plan("macOS trust persistence", ...planned), {
      ...persistenceCtx({ HOME: "/Users/example" }),
      apply: true,
      run,
    });

    expect(calls).toEqual([
      ["/bin/launchctl", "setenv", NODE_USE_SYSTEM_CA, "1"],
      ["/bin/launchctl", "unsetenv", NODE_EXTRA_CA_CERTS],
    ]);
  });

  it("fails closed on unsafe labels, keys, homes, and non-normalized CA paths", () => {
    expect(() => macLaunchAgentPlist("dev.aih.env../escape", "NODE_USE_SYSTEM_CA", "1")).toThrow();
    expect(() => macLaunchAgentPlist("dev.aih.env.node-use-system-ca", "NODE<USE", "1")).toThrow();
    expect(() =>
      nodeTrustPersistenceActions(persistenceCtx({ HOME: "relative/home" }), nodeTrustEnvVars()),
    ).toThrow();
    expect(() =>
      nodeTrustPersistenceActions(
        persistenceCtx(),
        nodeTrustEnvVars("/Users/example/../escape.pem"),
      ),
    ).toThrow();
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
