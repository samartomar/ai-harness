import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeEccRuntime } from "../../src/ecc-profile/native-runtime-cli.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  defaultNativeMcpServers,
  verifiedRootAwareLauncherSubjectV1,
} from "../../src/mcp/default-native-runtime.js";
import { mcpApprovalSubject } from "../../src/mcp/policy.js";
import {
  ROOT_AWARE_LAUNCHER_IDS,
  type RootAwareLauncherId,
  rootAwareLauncherIdentityV1,
  rootAwareLauncherOptionsV1,
  rootAwareLauncherSubjectV1,
} from "../../src/mcp/root-aware-launcher-identity.js";
import type { StdioServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(env: NodeJS.ProcessEnv = {}): PlanContext {
  const root = mkdtempSync(join(tmpdir(), "aih-root-aware-identity-"));
  roots.push(root);
  const run = fakeRunner(() => ({ code: 1, stderr: "no process in this fixture" }));
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
  };
}

function launcher(id: RootAwareLauncherId, ctx = context()): StdioServer {
  const server = defaultNativeMcpServers(ctx)[id];
  if (server?.type !== "stdio") throw new Error(`expected the ${id} launcher`);
  return server;
}

function withOption(server: StdioServer, flag: string, value: string): StdioServer {
  const args = [...server.args];
  const index = args.indexOf(flag);
  if (index < 0) throw new Error(`the launcher has no ${flag}`);
  args[index + 1] = value;
  return { ...server, args };
}

describe("the portable identity of Core's root-aware MCP launchers", () => {
  it("covers exactly the launchers the runtime substitutes", () => {
    expect(Object.keys(defaultNativeMcpServers(context()))).toEqual([...ROOT_AWARE_LAUNCHER_IDS]);
  });

  it.each(ROOT_AWARE_LAUNCHER_IDS)(
    "verifies Core's own %s launcher and reports its portable subject",
    (id) => {
      const server = launcher(id);
      expect(verifiedRootAwareLauncherSubjectV1(id, server)).toBe(rootAwareLauncherSubjectV1(id));
      expect(rootAwareLauncherSubjectV1(id)).toMatch(/^mcp-server-sha256:[0-9a-f]{64}$/u);
      expect(rootAwareLauncherSubjectV1(id)).not.toBe(mcpApprovalSubject(server));
    },
  );

  it.each(ROOT_AWARE_LAUNCHER_IDS)("keeps every machine path out of the %s identity", (id) => {
    const server = launcher(id);
    const document = JSON.stringify(rootAwareLauncherIdentityV1(id));
    const paths = [server.command, ...server.args].filter((arg) => isAbsolute(arg));
    expect(paths.length).toBeGreaterThan(3);
    for (const path of paths) expect(document).not.toContain(JSON.stringify(path).slice(1, -1));
    const elsewhere = launcher(
      id,
      context({ HOME: join(tmpdir(), "another-home"), XDG_STATE_HOME: join(tmpdir(), "state") }),
    );
    expect(elsewhere.args).not.toEqual(server.args);
    expect(verifiedRootAwareLauncherSubjectV1(id, elsewhere)).toBe(rootAwareLauncherSubjectV1(id));
  });

  it("gives each launcher its own subject", () => {
    expect(new Set(ROOT_AWARE_LAUNCHER_IDS.map(rootAwareLauncherSubjectV1)).size).toBe(3);
  });

  describe("reports no identity for an entry that is not exactly Core's own launcher", () => {
    const tampered: [string, RootAwareLauncherId, (server: StdioServer) => StdioServer][] = [
      [
        "another package pin",
        "code-review-graph",
        (s) => withOption(s, "--package", "code-review-graph==2.3.8"),
      ],
      [
        "another dependency lock",
        "codebase-memory-mcp",
        (s) => withOption(s, "--dependency-lock-sha256", "0".repeat(64)),
      ],
      ["another lock root", "serena", (s) => withOption(s, "--lock-root", tmpdir())],
      [
        "another wrapper",
        "code-review-graph",
        (s) => ({ ...s, args: [join(tmpdir(), "ecc-runtime.js"), ...s.args.slice(1)] }),
      ],
      [
        "another wrapper mode",
        "code-review-graph",
        (s) => ({ ...s, args: [s.args[0] ?? "", "serena", ...s.args.slice(2)] }),
      ],
      ["another command", "serena", (s) => ({ ...s, command: "node" })],
      [
        "an extra flag",
        "code-review-graph",
        (s) => ({ ...s, args: [...s.args, "--tools", "all"] }),
      ],
      [
        "a repeated flag",
        "codebase-memory-mcp",
        (s) => ({ ...s, args: [...s.args, "--uv-cache", tmpdir()] }),
      ],
      [
        "a missing flag",
        "code-review-graph",
        (s) => ({ ...s, args: s.args.filter((_, i) => i < s.args.length - 2) }),
      ],
      ["a flag without a value", "serena", (s) => ({ ...s, args: [...s.args, "--verbose"] })],
      ["another fixed option", "serena", (s) => withOption(s, "--mode", "editing")],
      ["a relative path", "code-review-graph", (s) => withOption(s, "--state-root", "state")],
      ["an environment", "serena", (s) => ({ ...s, env: { SERENA_HOME: "$" + "{SERENA_HOME}" } })],
      ["another risk axis", "codebase-memory-mcp", (s) => ({ ...s, egress: "third-party" })],
      ["another transport", "serena", (s) => ({ ...s, type: "http" }) as unknown as StdioServer],
      ["an unknown field", "serena", (s) => ({ ...s, cwd: tmpdir() }) as StdioServer],
    ];
    it.each(tampered)("%s", (_label, id, tamper) => {
      const server = launcher(id);
      expect(verifiedRootAwareLauncherSubjectV1(id, server)).toBeDefined();
      expect(verifiedRootAwareLauncherSubjectV1(id, tamper(server))).toBeUndefined();
    });

    it("another server's launcher under this id", () => {
      expect(
        verifiedRootAwareLauncherSubjectV1("code-review-graph", launcher("codebase-memory-mcp")),
      ).toBeUndefined();
    });
  });

  it.each(ROOT_AWARE_LAUNCHER_IDS)(
    "names exactly the options Core's wrapper accepts for %s",
    async (id) => {
      const stdio = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      };
      const options = rootAwareLauncherOptionsV1(id).flatMap((flag) => [flag, "x"]);
      await expect(
        runNativeEccRuntime([id, ...options, "--unexpected", "x"], stdio),
      ).rejects.toThrow("invalid ECC runtime options (missing: none; unknown: --unexpected)");
    },
  );
});
