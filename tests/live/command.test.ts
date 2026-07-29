import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  LIVE_PROCESS_OPTION,
  command as liveCommand,
  readLivePromptFile,
} from "../../src/live/index.js";
import type { LiveChild, LiveProcessSeam } from "../../src/live/runner.js";
import { buildProgram } from "../../src/program.js";

class FakeChild extends EventEmitter {
  readonly pid = 456;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-live-command-"));
  roots.push(root);
  return root;
}

function install(root: string, cli: "codex" | "claude" | "kimi"): string {
  const executable = join(root, process.platform === "win32" ? `${cli}.exe` : cli);
  writeFileSync(executable, "");
  chmodSync(executable, 0o755);
  return executable;
}

function command(argv: string[]): Command {
  return new Command("live")
    .argument("[root]")
    .option("--json")
    .option("--posture <posture>", "", "vibe")
    .option("--root <dir>")
    .option("--support-out <dir>")
    .option("--no-log")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--cli <cli>", "", (value: string, previous: string[]) => [...previous, value], [])
    .option("--prompt-file <file>")
    .option("--timeout <seconds>", "", "120")
    .option("--allow-kimi-non-read-only")
    .parse(argv, { from: "user" });
}

function successfulSeam(
  cli: "codex" | "kimi",
  final: string,
): { seam: LiveProcessSeam; calls: string[]; child: FakeChild } {
  const calls: string[] = [];
  const child = new FakeChild();
  const seam: LiveProcessSeam = {
    platform: process.platform,
    kill: () => {},
    spawn: (executable) => {
      calls.push(executable);
      setImmediate(() => {
        const line =
          cli === "codex"
            ? JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: final },
              })
            : JSON.stringify({ role: "assistant", content: final });
        child.stdout.end(`${line}\n`);
        child.stderr.end("raw native stderr must stay hidden");
        setImmediate(() => child.emit("close", 0));
      });
      return child as unknown as LiveChild;
    },
  };
  return { seam, calls, child };
}

async function run(
  root: string,
  argv: string[],
  seam: LiveProcessSeam,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCapability(liveCommand, command(argv), {
    env: { PATH: root, AIH_LOG: "0", SystemRoot: process.env.SystemRoot },
    run: fakeRunner(() => undefined),
    optionOverrides: { [LIVE_PROCESS_OPTION]: seam },
    write: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("aih live command adapter", () => {
  it("is a canonical read-only CommandSpec with optional positional root and no cwd/default path", () => {
    const live = buildProgram().commands.find((candidate) => candidate.name() === "live");
    expect(liveCommand.readOnly).toBe(true);
    expect(live?.registeredArguments.map((argument) => argument.name())).toEqual(["root"]);
    expect(live?.options.map((option) => option.flags)).not.toContain("--cwd <dir>");
    expect(live?.options.find((option) => option.flags === "--cli <cli>")?.description).toContain(
      "codex/claude read_only; kimi non_read_only",
    );
    expect(
      live?.options.find((option) => option.flags === "--allow-kimi-non-read-only")?.description,
    ).toContain("Kimi non_read_only");
    const surface = JSON.stringify(
      live?.options.map((option) => ({ flags: option.flags, defaultValue: option.defaultValue })),
    );
    expect(surface).not.toMatch(/[A-Za-z]:\\/);
    expect(surface).not.toMatch(/\/(?:home|Users)\//);
  });

  it("requires exactly one explicit CLI selection and never falls through to process launch", async () => {
    const root = fixtureRoot();
    const prompt = join(root, "prompt.txt");
    writeFileSync(prompt, "inspect only");
    let spawnCount = 0;
    const seam: LiveProcessSeam = {
      platform: process.platform,
      kill: () => {},
      spawn: () => {
        spawnCount++;
        throw new Error("must not launch");
      },
    };

    for (const selection of [
      [],
      ["--cli", "codex", "--cli", "claude"],
      ["--cli", "codex,claude"],
    ]) {
      const result = await run(
        root,
        ["--json", "--prompt-file", prompt, "--root", root, ...selection],
        seam,
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("AIH_LIVE_INPUT");
    }
    expect(spawnCount).toBe(0);
  });

  it("requires Kimi consent before prompt read, resolution, or spawn", async () => {
    const root = fixtureRoot();
    const missingPrompt = join(root, "does-not-exist.txt");
    let spawnCount = 0;
    const seam: LiveProcessSeam = {
      platform: process.platform,
      kill: () => {},
      spawn: () => {
        spawnCount++;
        throw new Error("must not launch");
      },
    };
    const result = await run(
      root,
      ["--json", "--cli", "kimi", "--prompt-file", missingPrompt, "--root", root],
      seam,
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      error: {
        code: "AIH_LIVE_CONSENT",
        message: "Kimi requires --allow-kimi-non-read-only; cli=kimi; safety=non_read_only",
      },
    });
    expect(spawnCount).toBe(0);
  });

  async function expectSuccessfulCommand(
    cli: "codex" | "kimi",
    consent: boolean,
    safety: "read_only" | "non_read_only",
  ): Promise<void> {
    const root = fixtureRoot();
    install(root, cli);
    const promptPath = join(root, "prompt.txt");
    const prompt = ' leading\r\n\tΩ %PATH% ^ "quotes" \n\n';
    writeFileSync(promptPath, prompt);
    const { seam, calls, child } = successfulSeam(cli, "final answer");
    let stdin = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      stdin += chunk;
    });
    const argv = [
      "--json",
      "--cli",
      cli,
      "--prompt-file",
      promptPath,
      "--root",
      root,
      ...(consent ? ["--allow-kimi-non-read-only"] : []),
    ];

    const result = await run(root, argv, seam);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.capability).toBe("live");
    expect(envelope.digests).toHaveLength(1);
    expect(envelope.digests[0].data).toEqual({
      schemaVersion: 1,
      cli,
      safety,
      result: "final answer",
    });
    expect(result.stdout).not.toContain("raw native stderr");
    expect(result.stderr).not.toContain("raw native stderr");
    const events = result.stderr
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
    expect(events.every((event) => event.safety === safety)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(stdin).toBe(cli === "codex" ? prompt : "");
  }

  it("streams codex progress on stderr and emits exactly one standard digest on stdout", async () => {
    await expectSuccessfulCommand("codex", false, "read_only");
  });

  it("streams kimi progress on stderr and emits exactly one standard digest on stdout", async () => {
    await expectSuccessfulCommand("kimi", true, "non_read_only");
  });

  it("labels Kimi non_read_only in the human success view", async () => {
    const root = fixtureRoot();
    install(root, "kimi");
    const promptPath = join(root, "prompt.txt");
    writeFileSync(promptPath, "prompt");
    const { seam } = successfulSeam("kimi", "final answer");
    const result = await run(
      root,
      ["--cli", "kimi", "--prompt-file", promptPath, "--root", root, "--allow-kimi-non-read-only"],
      seam,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("CLI: kimi");
    expect(result.stdout).toContain("Safety: non_read_only");
  });

  it.each([
    ["spawn", "AIH_LIVE_SPAWN"],
    ["result", "AIH_LIVE_RESULT"],
    ["timeout", "AIH_LIVE_TIMEOUT"],
  ] as const)(
    "labels Kimi %s failures non_read_only in human and JSON final views",
    async (kind, code) => {
      const execute = async (json: boolean) => {
        const root = fixtureRoot();
        install(root, "kimi");
        const promptPath = join(root, "prompt.txt");
        writeFileSync(promptPath, "prompt");
        const main = new FakeChild();
        const killer = new FakeChild();
        let launchCount = 0;
        let markSpawned: (() => void) | undefined;
        const spawned = new Promise<void>((resolve) => {
          markSpawned = resolve;
        });
        const seam: LiveProcessSeam = {
          platform: process.platform,
          kill: () => {
            main.emit("close", null, "SIGTERM");
          },
          spawn: (executable) => {
            if (/taskkill\.exe$/i.test(executable)) {
              queueMicrotask(() => {
                killer.emit("close", 0);
                main.emit("close", null, "SIGTERM");
              });
              return killer as unknown as LiveChild;
            }
            launchCount++;
            markSpawned?.();
            if (kind === "spawn") throw new Error("raw spawn failure");
            if (kind === "result") {
              setImmediate(() => {
                main.stdout.end('{"type":"not-a-result"}\n');
                main.stderr.end();
                setImmediate(() => main.emit("close", 0));
              });
            }
            return main as unknown as LiveChild;
          },
        };
        const argv = [
          ...(json ? ["--json"] : []),
          "--cli",
          "kimi",
          "--prompt-file",
          promptPath,
          "--root",
          root,
          "--allow-kimi-non-read-only",
          ...(kind === "timeout" ? ["--timeout", "5"] : []),
        ];
        const pending = run(root, argv, seam);
        if (kind === "timeout") {
          await spawned;
          await vi.advanceTimersByTimeAsync(5_000);
        }
        const result = await pending;
        expect(launchCount).toBe(1);
        return result;
      };

      if (kind === "timeout") vi.useFakeTimers();
      try {
        for (const json of [false, true]) {
          const result = await execute(json);
          expect(result.code).toBe(1);
          const final = json ? JSON.parse(result.stdout).error : result.stdout;
          expect(json ? final.code : result.stdout).toContain(code);
          expect(json ? final.message : result.stdout).toContain("cli=kimi");
          expect(json ? final.message : result.stdout).toContain("safety=non_read_only");
          expect(result.stdout).not.toContain("raw spawn failure");
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["codex", "claude"] as const)(
    "labels %s runtime errors read_only in the final view",
    async (cli) => {
      const root = fixtureRoot();
      install(root, cli);
      const promptPath = join(root, "prompt.txt");
      writeFileSync(promptPath, "prompt");
      const seam: LiveProcessSeam = {
        platform: process.platform,
        kill: () => {},
        spawn: () => {
          throw new Error("raw spawn failure");
        },
      };
      const result = await run(
        root,
        ["--json", "--cli", cli, "--prompt-file", promptPath, "--root", root],
        seam,
      );
      const message = JSON.parse(result.stdout).error.message;
      expect(message).toContain(`cli=${cli}`);
      expect(message).toContain("safety=read_only");
    },
  );

  it("rejects denied prompt files before read or spawn", async () => {
    const root = fixtureRoot();
    install(root, "kimi");
    let fileCallCount = 0;
    const deniedFileSeam = {
      lstat: () => {
        fileCallCount++;
        throw new Error("must not stat");
      },
      open: () => {
        fileCallCount++;
        throw new Error("must not open");
      },
      fstat: () => {
        fileCallCount++;
        throw new Error("must not fstat");
      },
      read: () => {
        fileCallCount++;
        throw new Error("must not read");
      },
      close: () => {
        fileCallCount++;
      },
    };
    let spawnCount = 0;
    const seam: LiveProcessSeam = {
      platform: process.platform,
      kill: () => {},
      spawn: () => {
        spawnCount++;
        throw new Error("must not launch");
      },
    };
    for (const denied of [join(root, ".env"), join(root, "secrets", "prompt.txt")]) {
      expect(() => readLivePromptFile(root, denied, deniedFileSeam)).toThrow(
        expect.objectContaining({ code: "AIH_LIVE_INPUT" }),
      );
      const result = await run(
        root,
        [
          "--json",
          "--cli",
          "kimi",
          "--prompt-file",
          denied,
          "--root",
          root,
          "--allow-kimi-non-read-only",
        ],
        seam,
      );
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: "AIH_LIVE_INPUT",
        message: expect.stringContaining("safety=non_read_only"),
      });
    }
    expect(fileCallCount).toBe(0);
    expect(spawnCount).toBe(0);
  });

  it("accepts timeout bounds 5 and 3600 and rejects 4 and 3601 before spawn", async () => {
    for (const seconds of ["4", "3601"]) {
      const root = fixtureRoot();
      let spawnCount = 0;
      const seam: LiveProcessSeam = {
        platform: process.platform,
        kill: () => {},
        spawn: () => {
          spawnCount++;
          throw new Error("must not launch");
        },
      };
      const result = await run(
        root,
        [
          "--json",
          "--cli",
          "codex",
          "--prompt-file",
          join(root, "missing.txt"),
          "--root",
          root,
          "--timeout",
          seconds,
        ],
        seam,
      );
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("AIH_LIVE_INPUT");
      expect(spawnCount).toBe(0);
    }

    for (const seconds of ["5", "3600"]) {
      const root = fixtureRoot();
      install(root, "codex");
      const promptPath = join(root, "prompt.txt");
      writeFileSync(promptPath, "prompt");
      const { seam } = successfulSeam("codex", "done");
      const result = await run(
        root,
        [
          "--json",
          "--cli",
          "codex",
          "--prompt-file",
          promptPath,
          "--root",
          root,
          "--timeout",
          seconds,
        ],
        seam,
      );
      expect(result.code).toBe(0);
    }
  });

  it.each(["codex", "claude"] as const)(
    "rejects Kimi acknowledgement with %s before prompt read or spawn",
    async (cli) => {
      const root = fixtureRoot();
      let spawnCount = 0;
      const seam: LiveProcessSeam = {
        platform: process.platform,
        kill: () => {},
        spawn: () => {
          spawnCount++;
          throw new Error("must not launch");
        },
      };
      const result = await run(
        root,
        [
          "--json",
          "--cli",
          cli,
          "--prompt-file",
          join(root, "missing.txt"),
          "--root",
          root,
          "--allow-kimi-non-read-only",
        ],
        seam,
      );
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: "AIH_LIVE_INPUT",
        message: expect.stringContaining(`cli=${cli}; safety=read_only`),
      });
      expect(spawnCount).toBe(0);
    },
  );

  it("reads strict UTF-8 prompt files without normalizing any decoded character", () => {
    const root = fixtureRoot();
    const promptPath = join(root, "prompt.txt");
    const prompt = '\uFEFF leading\r\n\tΩ %PATH% ^ "quotes" \n\n';
    writeFileSync(promptPath, Buffer.from(prompt, "utf8"));
    expect(readLivePromptFile(root, promptPath)).toBe(prompt);

    const invalid = join(root, "invalid.txt");
    writeFileSync(invalid, Buffer.from([0xc3, 0x28]));
    expect(() => readLivePromptFile(root, invalid)).toThrow("live input is invalid");
    expect(() => readLivePromptFile(root, "-")).toThrow("live input is invalid");
  });

  it("fails closed when the prompt file changes after opening", () => {
    const root = fixtureRoot();
    const promptPath = join(root, "prompt.txt");
    writeFileSync(promptPath, "prompt");
    let fstatCount = 0;
    expect(() =>
      readLivePromptFile(root, promptPath, {
        lstat: lstatSync,
        open: openSync,
        fstat: (descriptor) => {
          const stats = fstatSync(descriptor);
          fstatCount++;
          return fstatCount === 2 ? ({ ...stats, mtimeMs: stats.mtimeMs + 1 } as Stats) : stats;
        },
        read: readSync,
        close: closeSync,
      }),
    ).toThrow(expect.objectContaining({ code: "AIH_LIVE_INPUT" }));
    expect(fstatCount).toBe(2);
  });
});
