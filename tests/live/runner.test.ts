import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractFinalResult,
  findOnPath,
  type LiveChild,
  type LiveProcessSeam,
  launchFor,
  MAX_LIVE_FINAL_RESULT_CHARS,
  MAX_LIVE_PROGRESS_EVENTS,
  quoteCmd,
  runLiveCli,
} from "../../src/live/runner.js";

interface SpawnCall {
  executable: string;
  args: readonly string[];
  options: SpawnOptions;
}

class FakeChild extends EventEmitter {
  readonly pid = 321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-live-"));
  roots.push(root);
  return root;
}

function install(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "");
  chmodSync(path, 0o755);
  return path;
}

function nativeName(cli: "codex" | "claude" | "kimi", platform: NodeJS.Platform): string {
  return platform === "win32" ? `${cli}.exe` : cli;
}

function successfulSeam(
  platform: NodeJS.Platform,
  stdout: string,
  stderr = "",
): { seam: LiveProcessSeam; calls: SpawnCall[]; child: FakeChild } {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const seam: LiveProcessSeam = {
    platform,
    kill: () => {},
    spawn: (executable, args, options) => {
      calls.push({ executable, args, options });
      setImmediate(() => {
        child.stdout.end(stdout);
        child.stderr.end(stderr);
        setImmediate(() => child.emit("close", 0));
      });
      return child as unknown as LiveChild;
    },
  };
  return { seam, calls, child };
}

function terminalLine(cli: "codex" | "claude" | "kimi", result: string): string {
  if (cli === "codex") {
    return JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: result },
    });
  }
  if (cli === "claude") return JSON.stringify({ type: "result", result });
  return JSON.stringify({ role: "assistant", content: result });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live launch contract", () => {
  it("pins core read-only Codex and Claude invocations without claiming clean-room isolation", () => {
    const root = fixtureRoot();
    const env = { PATH: root };
    install(root, nativeName("codex", process.platform));
    install(root, nativeName("claude", process.platform));
    const prompt = ' leading\r\n\tUnicode Ω %PATH% ^ "quoted" \n';

    expect(launchFor("codex", prompt, env, process.platform)).toMatchObject({
      args: ["exec", "--sandbox", "read-only", "--ephemeral", "--json", "-"],
      promptOnStdin: true,
    });
    expect(launchFor("claude", prompt, env, process.platform)).toMatchObject({
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--permission-mode",
        "plan",
        "--tools",
        "Read,Glob,Grep",
      ],
      promptOnStdin: true,
    });
    expect(launchFor("codex", prompt, env, process.platform).args).not.toContain(prompt);
    expect(launchFor("claude", prompt, env, process.platform).args).not.toContain(prompt);
    expect(launchFor("codex", prompt, env, process.platform).args).not.toContain(
      "--ignore-user-config",
    );
    expect(launchFor("claude", prompt, env, process.platform).args).not.toContain("--safe-mode");
  });

  it("uses Kimi's exact direct argv prompt transport and labels it non-read-only at result time", async () => {
    const root = fixtureRoot();
    const executable = install(root, nativeName("kimi", process.platform));
    const prompt = ' \r\n\tΩ %PATH% ^ "quotes" \n\n';
    const env = { PATH: root };
    const launch = launchFor("kimi", prompt, env, process.platform);
    expect(launch).toEqual({
      executable,
      args: ["--prompt", prompt, "--output-format", "stream-json"],
      promptOnStdin: false,
    });

    const { seam } = successfulSeam(process.platform, `${terminalLine("kimi", "done")}\n`);
    const progress: unknown[] = [];
    const result = await runLiveCli("kimi", {
      prompt,
      cwd: root,
      timeoutMs: 1_000,
      env,
      progress: (event) => progress.push(event),
      deferCleanup: () => {},
      process: seam,
    });
    expect(result).toMatchObject({ cli: "kimi", safety: "non_read_only", result: "done" });
    expect(progress).toEqual(
      expect.arrayContaining([expect.objectContaining({ safety: "non_read_only" })]),
    );
  });

  it.runIf(process.platform === "win32")(
    "prefers a native Windows executable and uses the validated System32 cmd shim otherwise",
    () => {
      const root = fixtureRoot();
      const systemRoot = join(root, "Windows");
      const system32 = join(systemRoot, "System32");
      mkdirSync(system32, { recursive: true });
      const commandInterpreter = install(system32, "cmd.exe");
      const exe = install(root, "codex.exe");
      install(root, "codex.cmd");
      const prompt = "%SECRET% ^ never in command";
      const env = { PATH: root, SystemRoot: systemRoot, ComSpec: "untrusted-cmd.exe" };
      const native = launchFor("codex", prompt, env, "win32");
      expect(native.executable).toBe(exe);
      expect(native.promptOnStdin).toBe(true);

      rmSync(exe);
      const shim = launchFor("codex", prompt, env, "win32");
      expect(shim.executable).toBe(commandInterpreter);
      expect(shim.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(shim.args[3]).toMatch(/^"".*""$/);
      expect(shim.args.join(" ")).not.toContain(prompt);
      expect(shim.promptOnStdin).toBe(true);
      expect(shim.windowsVerbatimArguments).toBe(true);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects Kimi when a Windows command shim is the only transport",
    () => {
      const root = fixtureRoot();
      install(root, "kimi.cmd");
      expect(() => launchFor("kimi", "prompt", { PATH: root }, "win32")).toThrow(
        "selected live CLI is unavailable",
      );
    },
  );

  it("quotes representable fixed cmd tokens and rejects expansion-sensitive values", () => {
    expect(quoteCmd("a caret ^ value")).toBe('"a caret ^ value"');
    expect(() => quoteCmd("a %USERPROFILE% value")).toThrow("not safely representable");
    expect(() => quoteCmd("a !delayed! value")).toThrow("not safely representable");
    expect(() => quoteCmd('a "quoted" value')).toThrow("not safely representable");
  });

  it("skips empty and relative PATH entries and returns the validated absolute candidate", () => {
    const root = fixtureRoot();
    const executable = install(root, nativeName("codex", process.platform));
    const separator = process.platform === "win32" ? ";" : ":";
    expect(findOnPath("codex", { PATH: `${separator}.${separator}relative` })).toBeUndefined();
    expect(findOnPath("codex", { PATH: root })).toBe(executable);
  });

  it("skips a non-executable POSIX decoy and selects the later executable", () => {
    if (process.platform === "win32") return;
    const decoyRoot = fixtureRoot();
    const realRoot = fixtureRoot();
    const decoy = install(decoyRoot, "codex");
    chmodSync(decoy, 0o644);
    const executable = install(realRoot, "codex");
    expect(findOnPath("codex", { PATH: `${decoyRoot}:${realRoot}` }, "linux")).toBe(executable);
  });

  it("executes a temporary fixed cmd fixture through absolute System32 cmd.exe", async () => {
    if (process.platform !== "win32") return;
    const root = fixtureRoot();
    const shim = install(root, "codex.cmd");
    writeFileSync(
      shim,
      '@echo off\r\necho {"type":"item.completed","item":{"type":"agent_message","text":"fixture-ok"}}\r\n',
    );
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined) throw new Error("SystemRoot is required on Windows");
    const result = await runLiveCli("codex", {
      prompt: "%PROMPT% ^ remains stdin-only",
      cwd: root,
      timeoutMs: 5_000,
      env: { PATH: root, SystemRoot: systemRoot },
      progress: () => {},
      deferCleanup: () => {},
    });
    expect(result).toMatchObject({
      cli: "codex",
      safety: "read_only",
      result: "fixture-ok",
    });
  }, 10_000);
});

describe("live stream/result contract", () => {
  it("uses only help-pinned terminal shapes and never treats Claude assistant blocks as final", () => {
    expect(
      extractFinalResult(
        "codex",
        '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      ),
    ).toBe("done");
    expect(
      extractFinalResult("codex", '{"type":"item.completed","item":{"type":"reasoning"}}'),
    ).toBe(undefined);
    expect(
      extractFinalResult("claude", '{"type":"assistant","message":"progress"}'),
    ).toBeUndefined();
    expect(extractFinalResult("claude", '{"type":"result","result":"done"}')).toBe("done");
    expect(
      extractFinalResult(
        "claude",
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"failed"}',
      ),
    ).toBeUndefined();
    expect(extractFinalResult("kimi", '{"role":"assistant","content":"done"}')).toBe("done");
  });

  it("treats a terminal Claude error result as failure even after a prior result candidate", async () => {
    const root = fixtureRoot();
    install(root, nativeName("claude", process.platform));
    const stdout = [
      terminalLine("claude", "not-final"),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "native error text",
      }),
      "",
    ].join("\n");
    const { seam } = successfulSeam(process.platform, stdout);

    await expect(
      runLiveCli("claude", {
        prompt: "prompt",
        cwd: root,
        timeoutMs: 1_000,
        env: { PATH: root },
        progress: () => {},
        deferCleanup: () => {},
        process: seam,
      }),
    ).rejects.toMatchObject({
      code: "AIH_LIVE_RESULT",
      cli: "claude",
      safety: "read_only",
    });
  });

  it.each(["codex", "claude"] as const)(
    "preserves prompt bytes through %s stdin without adding a newline",
    async (cli) => {
      const root = fixtureRoot();
      install(root, nativeName(cli, process.platform));
      const prompt = ' leading\r\n\tΩ %PATH% ^ "quotes" \n\n';
      const { seam, child } = successfulSeam(process.platform, `${terminalLine(cli, "done")}\n`);
      let received = "";
      child.stdin.setEncoding("utf8");
      child.stdin.on("data", (chunk: string) => {
        received += chunk;
      });

      await runLiveCli(cli, {
        prompt,
        cwd: root,
        timeoutMs: 1_000,
        env: { PATH: root },
        progress: () => {},
        deferCleanup: () => {},
        process: seam,
      });
      expect(received).toBe(prompt);
    },
  );

  it("caps monotonic schema-owned events, emits one terminal phase, and never echoes stderr", async () => {
    const root = fixtureRoot();
    install(root, nativeName("codex", process.platform));
    const unknown = `${Array.from({ length: 150 }, () => '{"unknown":"raw"}').join("\n")}\n`;
    const rawStderr = "SECRET native stderr C:\\private\\argv --flag\n";
    const { seam } = successfulSeam(
      process.platform,
      `${unknown}${terminalLine("codex", "done")}\n`,
      rawStderr,
    );
    const events: Array<Record<string, unknown>> = [];

    await runLiveCli("codex", {
      prompt: "prompt",
      cwd: root,
      timeoutMs: 1_000,
      env: { PATH: root },
      progress: (event) => events.push(event),
      deferCleanup: () => {},
      process: seam,
    });

    expect(events.length).toBeLessThanOrEqual(MAX_LIVE_PROGRESS_EVENTS);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.filter((event) => event.type === "terminal")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "output_capped" }));
    expect(JSON.stringify(events)).not.toContain("SECRET");
    expect(JSON.stringify(events)).not.toContain("private");
    expect(
      events.every((event) =>
        ["started", "activity", "output_capped", "terminal"].includes(String(event.type)),
      ),
    ).toBe(true);
  });

  it("redacts prompt/root/secret-like text and caps the one final result", async () => {
    const root = fixtureRoot();
    install(root, nativeName("claude", process.platform));
    const prompt = "private prompt";
    const nativeResult = `${prompt} ${root} ghp_${"a".repeat(40)} ${"x".repeat(
      MAX_LIVE_FINAL_RESULT_CHARS + 100,
    )}`;
    const { seam } = successfulSeam(process.platform, `${terminalLine("claude", nativeResult)}\n`);

    const result = await runLiveCli("claude", {
      prompt,
      cwd: root,
      timeoutMs: 1_000,
      env: { PATH: root, HOME: root },
      progress: () => {},
      deferCleanup: () => {},
      process: seam,
    });
    expect(result.result).not.toContain(prompt);
    expect(result.result).not.toContain(root);
    expect(result.result).not.toContain(`ghp_${"a".repeat(40)}`);
    expect(result.result.length).toBeLessThanOrEqual(MAX_LIVE_FINAL_RESULT_CHARS);
  });

  it("uses stable unavailable and spawn errors with one terminal phase", async () => {
    const root = fixtureRoot();
    const unavailableEvents: Array<Record<string, unknown>> = [];
    await expect(
      runLiveCli("codex", {
        prompt: "prompt",
        cwd: root,
        timeoutMs: 1_000,
        env: { PATH: "" },
        progress: (event) => unavailableEvents.push(event),
        deferCleanup: () => {},
      }),
    ).rejects.toMatchObject({ code: "AIH_LIVE_UNAVAILABLE" });
    expect(unavailableEvents.filter((event) => event.type === "terminal")).toEqual([
      expect.objectContaining({ status: "unavailable" }),
    ]);
    expect(unavailableEvents[0]).toMatchObject({ type: "started", safety: "read_only" });

    install(root, nativeName("codex", process.platform));
    const spawnEvents: Array<Record<string, unknown>> = [];
    const seam: LiveProcessSeam = {
      platform: process.platform,
      kill: () => {},
      spawn: () => {
        throw new Error("raw executable path and argv");
      },
    };
    await expect(
      runLiveCli("codex", {
        prompt: "prompt",
        cwd: root,
        timeoutMs: 1_000,
        env: { PATH: root },
        progress: (event) => spawnEvents.push(event),
        deferCleanup: () => {},
        process: seam,
      }),
    ).rejects.toMatchObject({ code: "AIH_LIVE_SPAWN" });
    expect(spawnEvents.filter((event) => event.type === "terminal")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(JSON.stringify(spawnEvents)).not.toContain("executable");
    expect(JSON.stringify(spawnEvents)).not.toContain("argv");
  });

  it.runIf(process.platform !== "win32")(
    "settles stream failures through registered process-tree cleanup",
    async () => {
      const root = fixtureRoot();
      install(root, "codex");
      const child = new FakeChild();
      const signals: NodeJS.Signals[] = [];
      const cleanups: Array<() => Promise<void>> = [];
      const events: Array<Record<string, unknown>> = [];
      const seam: LiveProcessSeam = {
        platform: "linux",
        spawn: () => {
          setImmediate(() => child.stdout.emit("error", new Error("raw stream failure")));
          return child as unknown as LiveChild;
        },
        kill: (_pid, signal) => {
          signals.push(signal);
          child.emit("close", null, signal);
        },
      };

      await expect(
        runLiveCli("codex", {
          prompt: "prompt",
          cwd: root,
          timeoutMs: 1_000,
          env: { PATH: root },
          progress: (event) => events.push(event),
          deferCleanup: (cleanup) => cleanups.push(cleanup),
          process: seam,
        }),
      ).rejects.toMatchObject({ code: "AIH_LIVE_STREAM" });
      expect(cleanups).toHaveLength(1);
      await expect(cleanups[0]?.()).resolves.toBeUndefined();
      expect(signals).toEqual(["SIGTERM"]);
      expect(events.filter((event) => event.type === "terminal")).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]);
      expect(JSON.stringify(events)).not.toContain("raw stream failure");
    },
  );

  it.runIf(process.platform !== "win32")(
    "times out, terminates the POSIX process group with TERM then KILL, and settles once",
    async () => {
      const root = fixtureRoot();
      install(root, "codex");
      const child = new FakeChild();
      const signals: NodeJS.Signals[] = [];
      const events: Array<Record<string, unknown>> = [];
      const seam: LiveProcessSeam = {
        platform: "linux",
        spawn: () => child as unknown as LiveChild,
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") child.emit("close", null, signal);
        },
      };

      await expect(
        runLiveCli("codex", {
          prompt: "prompt",
          cwd: root,
          timeoutMs: 5,
          env: { PATH: root },
          progress: (event) => events.push(event),
          deferCleanup: () => {},
          process: seam,
        }),
      ).rejects.toMatchObject({ code: "AIH_LIVE_TIMEOUT" });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(events.filter((event) => event.type === "terminal")).toEqual([
        expect.objectContaining({ status: "timed_out" }),
      ]);
    },
  );

  it("settles the original bounded failure when cleanup rejects", async () => {
    const root = fixtureRoot();
    install(root, nativeName("kimi", process.platform));
    const env: NodeJS.ProcessEnv = { PATH: root };
    let taskkill: string | undefined;
    if (process.platform === "win32") {
      const systemRoot = join(root, "Windows");
      const system32 = join(systemRoot, "System32");
      mkdirSync(system32, { recursive: true });
      taskkill = install(system32, "taskkill.exe");
      env.SystemRoot = systemRoot;
    }
    let rejectWait = false;
    class RejectingCleanupChild extends FakeChild {
      override once(event: string | symbol, listener: Parameters<EventEmitter["once"]>[1]): this {
        if (rejectWait && event === "close") throw new Error("raw cleanup rejection");
        return super.once(event, listener);
      }

      override kill(): boolean {
        throw new Error("raw child cleanup rejection");
      }
    }
    const child = new RejectingCleanupChild();
    const seam: LiveProcessSeam = {
      platform: process.platform,
      spawn: (executable) => {
        if (taskkill !== undefined && executable === taskkill) {
          rejectWait = true;
          throw new Error("raw taskkill cleanup rejection");
        }
        return child as unknown as LiveChild;
      },
      kill: () => {
        rejectWait = true;
        throw new Error("raw group cleanup rejection");
      },
    };

    await expect(
      runLiveCli("kimi", {
        prompt: "prompt",
        cwd: root,
        timeoutMs: 5,
        env,
        progress: () => {},
        deferCleanup: () => {},
        process: seam,
      }),
    ).rejects.toMatchObject({
      code: "AIH_LIVE_TIMEOUT",
      message: expect.stringContaining("cli=kimi; safety=non_read_only"),
    });
  });

  it("uses bounded absolute System32 taskkill tree cleanup on timeout", async () => {
    if (process.platform !== "win32") return;
    const root = fixtureRoot();
    install(root, "codex.exe");
    const systemRoot = join(root, "Windows");
    const system32 = join(systemRoot, "System32");
    mkdirSync(system32, { recursive: true });
    const taskkill = install(system32, "taskkill.exe");
    const main = new FakeChild();
    const killer = new FakeChild();
    const calls: SpawnCall[] = [];
    const seam: LiveProcessSeam = {
      platform: "win32",
      kill: () => {},
      spawn: (executable, args, options) => {
        calls.push({ executable, args, options });
        if (executable === taskkill) {
          setImmediate(() => {
            killer.emit("close", 0);
            main.emit("close", null, "SIGTERM");
          });
          return killer as unknown as LiveChild;
        }
        return main as unknown as LiveChild;
      },
    };

    await expect(
      runLiveCli("codex", {
        prompt: "prompt",
        cwd: root,
        timeoutMs: 5,
        env: { PATH: root, SystemRoot: systemRoot },
        progress: () => {},
        deferCleanup: () => {},
        process: seam,
      }),
    ).rejects.toMatchObject({ code: "AIH_LIVE_TIMEOUT" });
    expect(calls[1]).toMatchObject({
      executable: taskkill,
      args: ["/PID", "321", "/T", "/F"],
      options: { shell: false, windowsHide: true, stdio: "ignore" },
    });
  });
});
