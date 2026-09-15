import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import type { Runner } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  createMarkItDownOperation,
  MARKITDOWN_RUNTIME_PIN,
  managedMarkItDownCliInvocation,
} from "../../src/tools/markitdown-runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(run: Runner): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-markitdown-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-markitdown-state-")));
  roots.push(root, state);
  const tools = join(state, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, process.platform === "win32" ? "uv.exe" : "uv"), "fixture uv", {
    mode: 0o755,
  });
  const env: NodeJS.ProcessEnv = {
    PATH: `${tools}${delimiter}${process.env.PATH ?? ""}`,
    HOME: state,
    USERPROFILE: state,
    LOCALAPPDATA: state,
    XDG_STATE_HOME: state,
    API_KEY: "must-not-reach-markitdown",
    HTTPS_PROXY: "http://proxy.example:8443",
    https_proxy: "http://proxy.example:8443",
    SSL_CERT_FILE: "C:\\corp\\ca.pem",
    REQUESTS_CA_BUNDLE: "C:\\corp\\ca.pem",
  };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({
      platform: process.platform === "win32" ? "windows" : "linux",
      run,
      env,
    }),
    options: { acceptTokenOptimizerLicense: true, tokenOptimizerProfile: "quiet" },
  };
}

function input(ctx: PlanContext) {
  return {
    id: "markitdown" as const,
    ctx,
    selected: true,
    acceptTokenOptimizerLicense: true,
    tokenOptimizerProfile: "quiet" as const,
    layout: defaultNativeRuntimeLayout(ctx),
  };
}

describe("MarkItDown runtime", () => {
  it("pins the published MIT converter release and only ordinary local document extras", () => {
    expect(MARKITDOWN_RUNTIME_PIN).toEqual({
      version: "0.1.7",
      package: "markitdown[docx,outlook,pdf,pptx,xls,xlsx]==0.1.7",
      sourceTag: "v0.1.7",
      sourceCommit: "fd239d5d2be43d9b68329730206b9312c7d5a388",
      wheelSha256: "4eca912c87c6aa6897284a7f4bf6769a23bccf8544530f5d8b175fbe3797c916",
      license: "MIT",
    });
  });

  it("syncs the pinned runtime and converts a bounded local HTML fixture through both official entrypoints", async () => {
    const calls: Array<{ argv: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = [];
    const ctx = fixture(async (argv, options) => {
      calls.push({ argv, env: options?.env, cwd: options?.cwd });
      if (argv.includes("sync")) {
        const runtime = options?.env?.UV_PROJECT_ENVIRONMENT;
        if (runtime === undefined) throw new Error("MarkItDown fixture sync lacked runtime root");
        const bin = join(runtime, process.platform === "win32" ? "Scripts" : "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          join(bin, process.platform === "win32" ? "markitdown.exe" : "markitdown"),
          "fixture",
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      const source = argv.at(-1);
      if (typeof source !== "string")
        throw new Error("MarkItDown fixture invocation lacked source");
      expect(readFileSync(source, "utf8")).toContain("AIH MarkItDown smoke");
      return { code: 0, stdout: "# AIH MarkItDown smoke\n\nBounded conversion.\n", stderr: "" };
    });

    const result = await createMarkItDownOperation(ctx, ctx.run)(input(ctx));

    expect(result).toMatchObject({
      state: "verified",
      changed: true,
      ownedPaths: [],
    });
    expect(result.detail).toContain("MarkItDown CLI 0.1.7");
    expect(result.detail).toContain("official CLI and");
    expect(result.detail).toContain("<input-file>");
    const sync = calls.find((call) => call.argv.includes("sync"));
    const directConversions = calls.filter((call) =>
      call.argv.some((argument) =>
        argument.endsWith(process.platform === "win32" ? "markitdown.exe" : "/markitdown"),
      ),
    );
    const moduleConversions = calls.filter(
      (call) => call.argv.includes("-m") && call.argv.includes("markitdown"),
    );
    expect(sync?.argv).toEqual(
      expect.arrayContaining(["sync", "--locked", "--no-python-downloads", "--no-config"]),
    );
    expect(sync?.env?.UV_OFFLINE).toBeUndefined();
    expect(sync?.env?.HTTPS_PROXY).toBe("http://proxy.example:8443");
    expect(sync?.env?.https_proxy).toBe("http://proxy.example:8443");
    expect(sync?.env?.SSL_CERT_FILE).toBe("C:\\corp\\ca.pem");
    expect(sync?.env?.REQUESTS_CA_BUNDLE).toBe("C:\\corp\\ca.pem");
    expect(directConversions).toHaveLength(1);
    expect(moduleConversions).toHaveLength(1);
    for (const call of [...directConversions, ...moduleConversions]) {
      expect(call.env?.UV_OFFLINE).toBe("1");
      expect(call.env?.UV_NO_ENV_FILE).toBe("1");
      expect(call.env?.API_KEY).toBeUndefined();
      expect(call.env?.HTTPS_PROXY).toBeUndefined();
      expect(call.env?.SSL_CERT_FILE).toBeUndefined();
      expect(call.cwd).not.toBe(ctx.root);
    }
    expect(existsSync(join(input(ctx).layout.projectStateRoot, "markitdown-smoke.html"))).toBe(
      false,
    );
  });

  it("fails before spawning when the packaged dependency root overlaps the project", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    });
    const operationInput = input(ctx);

    await expect(
      createMarkItDownOperation(
        ctx,
        ctx.run,
      )({
        ...operationInput,
        layout: { ...operationInput.layout, markitdownLockRoot: ctx.root },
      }),
    ).rejects.toThrow("MarkItDown runtime lock root must be disjoint from project and state roots");
    expect(calls).toEqual([]);
  });

  it("rejects a changed packaged lock before it can provision or execute", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    });
    const operationInput = input(ctx);
    const alteredLock = realpathSync(mkdtempSync(join(tmpdir(), "aih-markitdown-altered-lock-")));
    roots.push(alteredLock);
    cpSync(operationInput.layout.markitdownLockRoot, alteredLock, { recursive: true });
    writeFileSync(join(alteredLock, "pyproject.toml"), '[project]\nname = "changed"\n');

    await expect(
      createMarkItDownOperation(
        ctx,
        ctx.run,
      )({
        ...operationInput,
        layout: { ...operationInput.layout, markitdownLockRoot: alteredLock },
      }),
    ).rejects.toThrow("MarkItDown runtime pyproject.toml failed authentication");
    expect(calls).toEqual([]);
  });

  it("reports a direct, project-independent offline CLI invocation", () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    const source = join(ctx.root, "O'Brien.html");
    writeFileSync(source, "<p>example</p>");

    const invocation = managedMarkItDownCliInvocation(ctx, source);

    expect(invocation.argv.at(-1)).toBe(source);
    expect(invocation.env.UV_OFFLINE).toBe("1");
    expect(invocation.env.UV_NO_ENV_FILE).toBe("1");
    expect(invocation.cwd).not.toBe(ctx.root);
    expect(invocation.displayCommand).toContain("markitdown");
    if (process.platform === "win32") {
      expect(invocation.displayShell).toBe("PowerShell");
      expect(invocation.displayCommand).toMatch(/^& '/u);
      expect(invocation.displayCommand).toContain("O''Brien.html");
    }
    expect(invocation.pythonModuleArgv).toEqual(
      expect.arrayContaining(["-m", "markitdown", source]),
    );
  });
});
