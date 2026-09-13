import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecAction, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { OPENCODE_SANDBOX_PROFILE, openCodeSandboxActions } from "../../src/sandbox/opencode.js";

let root: string;
let outside: string;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const identity = (path: string) => {
  const stat = lstatSync(path);
  return {
    kind: stat.isDirectory() ? "directory" : "file",
    dev: String(stat.dev),
    ino: String(stat.ino),
  };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-opencode-root-"));
  outside = mkdtempSync(join(tmpdir(), "aih-opencode-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function context(options: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: { cli: ["opencode"], ...options },
  };
}

describe("OpenCode Linux sandbox profile", () => {
  it("persists root-owned policy, non-secret bindings, and explicit exposure controls", () => {
    const policy = join(outside, "policy.json");
    const hidden = join(outside, "private");
    const readOnly = join(outside, "protected");
    writeFileSync(policy, "{}");
    mkdirSync(hidden);
    mkdirSync(readOnly);
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    const actions = openCodeSandboxActions(
      context(
        {
          binding: [
            "AIH_OPENCODE_NONCE=fixture-nonce",
            "PATH=/fixture/bin:/usr/bin",
            "OPENCODE_DISABLE_MODELS_FETCH=1",
            "OPENCODE_DISABLE_AUTOUPDATE=true",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS=1",
            "OPENCODE_DISABLE_LSP_DOWNLOAD=true",
          ],
          hidePath: [hidden],
          readOnlyPath: [readOnly],
          clientArg: ["run", "harmless fixture request"],
          bwrapExecutable: seccomp,
          opencodeExecutable: opencode,
          seccompExecutable: seccomp,
        },
        { AIH_ORG_POLICY: policy },
      ),
    );
    const profile = actions.find(
      (action): action is WriteAction =>
        action.kind === "write" && action.path === OPENCODE_SANDBOX_PROFILE,
    );
    expect(profile?.json).toMatchObject({
      schemaVersion: 1,
      client: "opencode",
      root,
      policy,
      policySha256: sha256("{}"),
      bwrapExecutable: seccomp,
      opencodeExecutable: opencode,
      seccompExecutable: seccomp,
      environment: {
        AIH_OPENCODE_NONCE: "fixture-nonce",
        PATH: "/fixture/bin:/usr/bin",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      },
      hiddenPaths: [hidden],
      readOnlyPaths: [readOnly],
      pathIdentities: { [hidden]: identity(hidden), [readOnly]: identity(readOnly) },
      clientArgs: ["run", "harmless fixture request"],
    });
  });

  it("refuses secret-bearing bindings", () => {
    const policy = join(outside, "policy.json");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "{}");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    expect(() =>
      openCodeSandboxActions(
        context(
          {
            binding: ["API_TOKEN=do-not-persist"],
            bwrapExecutable: seccomp,
            opencodeExecutable: opencode,
            seccompExecutable: seccomp,
          },
          { AIH_ORG_POLICY: policy },
        ),
      ),
    ).toThrow(/refuses (?:secret-bearing|unsafe environment) name/);
  });

  it("refuses non-boolean OpenCode offline bindings and other OpenCode configuration", () => {
    const policy = join(outside, "policy.json");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "{}");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    for (const binding of [
      "OPENCODE_DISABLE_MODELS_FETCH=yes",
      "OPENCODE_CONFIG=/tmp/untrusted.json",
      "OPENCODE_PERMISSION=allow",
    ]) {
      expect(() =>
        openCodeSandboxActions(
          context(
            {
              binding: [binding],
              bwrapExecutable: seccomp,
              opencodeExecutable: opencode,
              seccompExecutable: seccomp,
            },
            { AIH_ORG_POLICY: policy },
          ),
        ),
      ).toThrow(/refuses unsafe environment name/);
    }
  });

  it("refuses process-hook bindings and hidden/required path overlap", () => {
    const policy = join(outside, "policy.json");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "{}");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    expect(() =>
      openCodeSandboxActions(
        context(
          {
            binding: ["NODE_OPTIONS=--require=hook.js"],
            bwrapExecutable: seccomp,
            opencodeExecutable: opencode,
            seccompExecutable: seccomp,
          },
          { AIH_ORG_POLICY: policy },
        ),
      ),
    ).toThrow(/unsafe environment name/);
    expect(() =>
      openCodeSandboxActions(
        context(
          {
            binding: ["AIH_NONCE=value"],
            hidePath: [outside],
            bwrapExecutable: seccomp,
            opencodeExecutable: opencode,
            seccompExecutable: seccomp,
          },
          { AIH_ORG_POLICY: policy },
        ),
      ),
    ).toThrow(/overlapping hidden and required path/);
    for (const ancestor of [dirname(root), parse(root).root]) {
      expect(() =>
        openCodeSandboxActions(
          context(
            {
              readOnlyPath: [ancestor],
              bwrapExecutable: seccomp,
              opencodeExecutable: opencode,
              seccompExecutable: seccomp,
            },
            { AIH_ORG_POLICY: policy },
          ),
        ),
      ).toThrow(/exposure path cannot contain the project root/);
    }
  });

  it("restarts with the profile's root, policy, environment, and bwrap controls", () => {
    const policy = join(outside, "policy.json");
    const hidden = join(outside, "private.txt");
    const readOnly = join(outside, "protected");
    writeFileSync(policy, "{}");
    writeFileSync(hidden, "private");
    mkdirSync(readOnly);
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    writeFileSync(join(root, "opencode.json"), "{}");
    writeFileSync(join(root, ".aih-config.json"), "{}");
    const profilePath = join(root, OPENCODE_SANDBOX_PROFILE);
    mkdirSync(join(root, ".aih", "sandbox", "opencode-home"), { recursive: true });
    writeFileSync(
      profilePath,
      JSON.stringify({
        schemaVersion: 1,
        client: "opencode",
        root,
        policy,
        policySha256: sha256("{}"),
        bwrapExecutable: seccomp,
        bwrapSha256: sha256("binary"),
        opencodeExecutable: opencode,
        opencodeSha256: sha256("binary"),
        seccompExecutable: seccomp,
        seccompSha256: sha256("binary"),
        environment: {
          AIH_OPENCODE_NONCE: "fixture-nonce",
          PATH: "/fixture/bin:/usr/bin",
        },
        hiddenPaths: [hidden],
        readOnlyPaths: [readOnly],
        pathIdentities: { [hidden]: identity(hidden), [readOnly]: identity(readOnly) },
        clientArgs: ["run", "request"],
      }),
    );
    const [action] = openCodeSandboxActions(context({ launch: true }));
    const launch = action as ExecAction;
    expect(launch.kind).toBe("exec");
    expect(launch.cwd).toBe(root);
    expect(launch.timeoutMs).toBe(120_000);
    expect(launch.argv.slice(0, 2)).toEqual([seccomp, "--die-with-parent"]);
    expect(launch.argv).toEqual(expect.arrayContaining(["--bind", root, root]));
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        join(root, "opencode.json"),
        join(root, "opencode.json"),
      ]),
    );
    expect(launch.argv).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        join(root, ".aih"),
        join(root, ".aih"),
        "--bind",
        join(root, ".aih", "sandbox", "opencode-home"),
        join(root, ".aih", "sandbox", "opencode-home"),
      ]),
    );
    expect(launch.argv).toEqual(expect.arrayContaining(["--ro-bind", "/dev/null", hidden]));
    expect(launch.argv).toEqual(expect.arrayContaining(["--ro-bind", readOnly, readOnly]));
    expect(launch.argv).toEqual(expect.arrayContaining(["--setenv", "AIH_ORG_POLICY", policy]));
    expect(launch.argv).toEqual(
      expect.arrayContaining(["--setenv", "AIH_OPENCODE_NONCE", "fixture-nonce"]),
    );
    expect(launch.argv.slice(-4)).toEqual([seccomp, opencode, "run", "request"]);
  });

  it("rejects a profile copied from another root", () => {
    mkdirSync(join(root, ".aih", "sandbox"), { recursive: true });
    writeFileSync(
      join(root, OPENCODE_SANDBOX_PROFILE),
      JSON.stringify({
        schemaVersion: 1,
        client: "opencode",
        root: outside,
        policy: join(outside, "policy.json"),
        policySha256: sha256("{}"),
        bwrapExecutable: join(outside, "apply-seccomp"),
        bwrapSha256: sha256("binary"),
        opencodeExecutable: join(outside, "opencode"),
        opencodeSha256: sha256("binary"),
        seccompExecutable: join(outside, "apply-seccomp"),
        seccompSha256: sha256("binary"),
        environment: {},
        hiddenPaths: [],
        readOnlyPaths: [],
        pathIdentities: {},
        clientArgs: [],
      }),
    );
    expect(() => openCodeSandboxActions(context({ launch: true }))).toThrow(/does not belong/);
  });

  it("rejects an executable changed after setup", () => {
    const policy = join(outside, "policy.json");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "{}");
    writeFileSync(opencode, "changed");
    writeFileSync(seccomp, "binary");
    writeFileSync(join(root, "opencode.json"), "{}");
    writeFileSync(join(root, ".aih-config.json"), "{}");
    mkdirSync(join(root, ".aih", "sandbox"), { recursive: true });
    writeFileSync(
      join(root, OPENCODE_SANDBOX_PROFILE),
      JSON.stringify({
        schemaVersion: 1,
        client: "opencode",
        root,
        policy,
        policySha256: sha256("{}"),
        bwrapExecutable: seccomp,
        bwrapSha256: sha256("binary"),
        opencodeExecutable: opencode,
        opencodeSha256: sha256("original"),
        seccompExecutable: seccomp,
        seccompSha256: sha256("binary"),
        environment: {},
        hiddenPaths: [],
        readOnlyPaths: [],
        pathIdentities: {},
        clientArgs: ["run", "fixture"],
      }),
    );
    expect(() => openCodeSandboxActions(context({ launch: true }))).toThrow(
      /changed after sandbox setup/,
    );
  });

  it("rejects a policy changed after setup", () => {
    const policy = join(outside, "policy.json");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "original");
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    writeFileSync(join(root, "opencode.json"), "{}");
    writeFileSync(join(root, ".aih-config.json"), "{}");
    mkdirSync(join(root, ".aih", "sandbox", "opencode-home"), { recursive: true });
    writeFileSync(
      join(root, OPENCODE_SANDBOX_PROFILE),
      JSON.stringify({
        schemaVersion: 1,
        client: "opencode",
        root,
        policy,
        policySha256: sha256("original"),
        bwrapExecutable: seccomp,
        bwrapSha256: sha256("binary"),
        opencodeExecutable: opencode,
        opencodeSha256: sha256("binary"),
        seccompExecutable: seccomp,
        seccompSha256: sha256("binary"),
        environment: {},
        hiddenPaths: [],
        readOnlyPaths: [],
        pathIdentities: {},
        clientArgs: ["run", "fixture"],
      }),
    );
    writeFileSync(policy, "revoked");
    expect(() => openCodeSandboxActions(context({ launch: true }))).toThrow(
      /policy changed after setup/,
    );
  });

  it("rejects a configured path replaced after setup", () => {
    const policy = join(outside, "policy.json");
    const hidden = join(outside, "private");
    const opencode = join(outside, "opencode");
    const seccomp = join(outside, "apply-seccomp");
    writeFileSync(policy, "{}");
    mkdirSync(hidden);
    writeFileSync(opencode, "binary");
    writeFileSync(seccomp, "binary");
    writeFileSync(join(root, "opencode.json"), "{}");
    writeFileSync(join(root, ".aih-config.json"), "{}");
    mkdirSync(join(root, ".aih", "sandbox", "opencode-home"), { recursive: true });
    writeFileSync(
      join(root, OPENCODE_SANDBOX_PROFILE),
      JSON.stringify({
        schemaVersion: 1,
        client: "opencode",
        root,
        policy,
        policySha256: sha256("{}"),
        bwrapExecutable: seccomp,
        bwrapSha256: sha256("binary"),
        opencodeExecutable: opencode,
        opencodeSha256: sha256("binary"),
        seccompExecutable: seccomp,
        seccompSha256: sha256("binary"),
        environment: {},
        hiddenPaths: [hidden],
        readOnlyPaths: [],
        pathIdentities: { [hidden]: identity(hidden) },
        clientArgs: ["run", "fixture"],
      }),
    );
    rmSync(hidden, { recursive: true });
    mkdirSync(hidden);
    expect(() => openCodeSandboxActions(context({ launch: true }))).toThrow(
      /path changed after setup/,
    );
  });
});
