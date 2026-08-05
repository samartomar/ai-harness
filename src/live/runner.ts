import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  LiveResultError,
  LiveSpawnError,
  LiveStreamError,
  LiveTimeoutError,
  LiveUnavailableError,
} from "../errors.js";
import { redactText } from "../support/redact.js";

export const LIVE_CLIS = ["codex", "claude", "kimi"] as const;
export type LiveCli = (typeof LIVE_CLIS)[number];
export type LiveSafety = "read_only" | "non_read_only";

export const LIVE_PROGRESS_SCHEMA_VERSION = 1 as const;
export const MAX_LIVE_PROGRESS_EVENTS = 100;
export const MAX_LIVE_NATIVE_LINE_CHARS = 256 * 1024;
export const MAX_LIVE_FINAL_RESULT_CHARS = 32 * 1024;

export type LiveActivity =
  | "codex_turn"
  | "codex_item"
  | "claude_assistant"
  | "claude_stream"
  | "claude_result"
  | "kimi_assistant"
  | "native_stdout_unknown"
  | "native_stdout_malformed"
  | "native_stdout_line_capped"
  | "native_stderr";

export type LiveTerminalStatus = "completed" | "failed" | "timed_out" | "unavailable";

export type LiveProgressEvent =
  | {
      schemaVersion: 1;
      sequence: number;
      cli: LiveCli;
      safety: LiveSafety;
      type: "started";
    }
  | {
      schemaVersion: 1;
      sequence: number;
      cli: LiveCli;
      safety: LiveSafety;
      type: "activity";
      activity: LiveActivity;
    }
  | {
      schemaVersion: 1;
      sequence: number;
      cli: LiveCli;
      safety: LiveSafety;
      type: "output_capped";
    }
  | {
      schemaVersion: 1;
      sequence: number;
      cli: LiveCli;
      safety: LiveSafety;
      type: "terminal";
      status: LiveTerminalStatus;
    };

export interface LiveChild {
  pid?: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, listener: (...args: never[]) => void): this;
  once(event: string, listener: (...args: never[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type LiveSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => LiveChild;

export interface LiveProcessSeam {
  spawn: LiveSpawn;
  platform: NodeJS.Platform;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export interface LiveRunOptions {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  progress: (event: LiveProgressEvent) => void;
  deferCleanup: (cleanup: () => Promise<void>) => void;
  process?: LiveProcessSeam;
}

export interface LiveResult {
  schemaVersion: 1;
  cli: LiveCli;
  safety: LiveSafety;
  result: string;
}

export interface LiveLaunch {
  executable: string;
  args: string[];
  promptOnStdin: boolean;
  windowsVerbatimArguments?: boolean;
}

const defaultProcessSeam: LiveProcessSeam = {
  spawn: (executable, args, options) =>
    nodeSpawn(executable, [...args], options) as unknown as LiveChild,
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
};

export function safetyFor(cli: LiveCli): LiveSafety {
  return cli === "kimi" ? "non_read_only" : "read_only";
}

function executableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: {
    /** Reject a candidate (including its symlink target) below this root. */
    excludeRoot?: string;
    /** `execFile` callers that cannot safely execute Windows command shims. */
    windowsExeOnly?: boolean;
  } = {},
): string | undefined {
  const paths = platform === "win32" ? win32 : posix;
  const directories = pathValue(env).split(platform === "win32" ? ";" : ":");
  const lexicalExcludedRoot =
    options.excludeRoot === undefined ? undefined : paths.resolve(options.excludeRoot);
  const excludedRoot =
    options.excludeRoot === undefined
      ? undefined
      : realCanonicalPath(paths.resolve(options.excludeRoot), paths);
  // Ordinary live-tool discovery retains its lexical fallback below. Authority
  // discovery cannot: a failed realpath means a symlink/junction target is not
  // proven outside the governed checkout.
  if (options.excludeRoot !== undefined && excludedRoot === undefined) return undefined;
  const outside = (root: string, candidate: string): boolean => {
    const relative = paths.relative(root, candidate);
    return relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
  };
  const selectedCandidate = (candidate: string): string | undefined => {
    if (!paths.isAbsolute(candidate)) return undefined;
    if (excludedRoot === undefined)
      return executableFile(candidate, platform) ? candidate : undefined;
    // Do not treat a pathname rooted in the governed checkout as external just
    // because its final leaf happens to resolve elsewhere. Check the lexical
    // PATH entry first, then its one canonical target; return that exact target.
    if (lexicalExcludedRoot === undefined || !outside(lexicalExcludedRoot, candidate))
      return undefined;
    const canonicalCandidate = realCanonicalPath(candidate, paths);
    if (canonicalCandidate === undefined) return undefined;
    if (!outside(excludedRoot, canonicalCandidate)) return undefined;
    return executableFile(canonicalCandidate, platform) ? canonicalCandidate : undefined;
  };
  if (platform === "win32") {
    const suffixes: readonly (".exe" | ".cmd")[] = options.windowsExeOnly
      ? [".exe"]
      : [".exe", ".cmd"];
    for (const suffix of suffixes) {
      for (const directory of directories) {
        if (!paths.isAbsolute(directory)) continue;
        const candidate = paths.resolve(paths.join(directory, `${name}${suffix}`));
        const selected = selectedCandidate(candidate);
        if (selected !== undefined) return selected;
      }
    }
    return undefined;
  }
  for (const directory of directories) {
    if (!paths.isAbsolute(directory)) continue;
    const candidate = paths.resolve(paths.join(directory, name));
    const selected = selectedCandidate(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function realCanonicalPath(path: string, paths: typeof posix | typeof win32): string | undefined {
  try {
    return paths.resolve(realpathSync.native(path));
  } catch {
    return undefined;
  }
}

function isCommandShim(path: string): boolean {
  return /\.cmd$/i.test(path);
}

/** Quote one prevalidated fixed cmd.exe token; prompt text never reaches this path. */
export function quoteCmd(value: string): string {
  const unsafe = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === '"' ||
      character === "%" ||
      character === "!" ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
  if (value.length === 0 || unsafe) {
    throw new Error("fixed cmd.exe token is not safely representable");
  }
  return `"${value}"`;
}

function system32Executable(
  name: "cmd.exe" | "taskkill.exe",
  env: NodeJS.ProcessEnv,
): string | undefined {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) return undefined;
  const candidate = win32.resolve(win32.join(systemRoot, "System32", name));
  return executableFile(candidate, "win32") ? candidate : undefined;
}

function fixedArgs(cli: Exclude<LiveCli, "kimi">): string[] {
  if (cli === "codex") {
    return ["exec", "--sandbox", "read-only", "--ephemeral", "--json", "-"];
  }
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
  ];
}

export function launchFor(
  cli: LiveCli,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LiveLaunch {
  const binary = findOnPath(cli, env, platform);
  if (binary === undefined) throw new LiveUnavailableError(cli, safetyFor(cli));

  if (cli === "kimi") {
    if (platform === "win32" && isCommandShim(binary)) {
      throw new LiveUnavailableError(cli, safetyFor(cli));
    }
    return {
      executable: binary,
      args: ["--prompt", prompt, "--output-format", "stream-json"],
      promptOnStdin: false,
    };
  }

  const args = fixedArgs(cli);
  if (platform === "win32" && isCommandShim(binary)) {
    const command = [quoteCmd(binary), ...args.map(quoteCmd)].join(" ");
    const commandInterpreter = system32Executable("cmd.exe", env);
    if (commandInterpreter === undefined) throw new LiveUnavailableError(cli, safetyFor(cli));
    return {
      executable: commandInterpreter,
      args: ["/d", "/s", "/c", `"${command}"`],
      promptOnStdin: true,
      windowsVerbatimArguments: true,
    };
  }
  return { executable: binary, args, promptOnStdin: true };
}

interface InspectedLine {
  activity: LiveActivity;
  result?: string;
  terminalError?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Help/fixture-pinned terminal extraction; callers keep only the last candidate until process exit. */
export function extractFinalResult(cli: LiveCli, line: string): string | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;

  if (cli === "codex" && parsed.type === "item.completed") {
    const item = record(parsed.item);
    return item?.type === "agent_message" && typeof item.text === "string" ? item.text : undefined;
  }
  if (
    cli === "claude" &&
    parsed.type === "result" &&
    parsed.is_error !== true &&
    !(typeof parsed.subtype === "string" && parsed.subtype.startsWith("error")) &&
    typeof parsed.result === "string"
  ) {
    return parsed.result;
  }
  if (cli === "kimi" && parsed.role === "assistant" && typeof parsed.content === "string") {
    return parsed.content;
  }
  return undefined;
}

function inspectLine(cli: LiveCli, line: string): InspectedLine {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(line));
  } catch {
    return { activity: "native_stdout_malformed" };
  }
  if (parsed === undefined) return { activity: "native_stdout_unknown" };
  const result = extractFinalResult(cli, line);
  if (cli === "codex") {
    if (
      parsed.type === "turn.started" ||
      parsed.type === "turn.completed" ||
      parsed.type === "turn.failed"
    ) {
      return { activity: "codex_turn" };
    }
    if (
      parsed.type === "item.started" ||
      parsed.type === "item.updated" ||
      parsed.type === "item.completed"
    ) {
      return { activity: "codex_item", ...(result === undefined ? {} : { result }) };
    }
  }
  if (cli === "claude") {
    if (parsed.type === "assistant") return { activity: "claude_assistant" };
    if (parsed.type === "stream_event" || parsed.type === "system") {
      return { activity: "claude_stream" };
    }
    if (parsed.type === "result") {
      const terminalError =
        parsed.is_error === true ||
        (typeof parsed.subtype === "string" && parsed.subtype.startsWith("error"));
      return {
        activity: "claude_result",
        ...(result === undefined ? {} : { result }),
        ...(terminalError ? { terminalError: true } : {}),
      };
    }
  }
  if (cli === "kimi" && parsed.role === "assistant") {
    return { activity: "kimi_assistant", ...(result === undefined ? {} : { result }) };
  }
  return { activity: "native_stdout_unknown" };
}

function createProgress(cli: LiveCli, sink: (event: LiveProgressEvent) => void) {
  const safety = safetyFor(cli);
  let sequence = 0;
  let capped = false;
  let terminal = false;
  const common = () => ({
    schemaVersion: LIVE_PROGRESS_SCHEMA_VERSION,
    sequence: ++sequence,
    cli,
    safety,
  });
  return {
    started() {
      sink({ ...common(), type: "started" });
    },
    activity(activity: LiveActivity) {
      if (terminal) return;
      if (sequence < MAX_LIVE_PROGRESS_EVENTS - 2) {
        sink({ ...common(), type: "activity", activity });
      } else if (!capped && sequence < MAX_LIVE_PROGRESS_EVENTS - 1) {
        capped = true;
        sink({ ...common(), type: "output_capped" });
      }
    },
    terminal(status: LiveTerminalStatus) {
      if (terminal) return;
      terminal = true;
      sink({ ...common(), type: "terminal", status });
    },
  };
}

function boundedVisibleText(
  value: string,
  prompt: string,
  root: string,
  env: NodeJS.ProcessEnv,
): string {
  let text = redactText(value, env);
  if (prompt.length > 0) text = text.replaceAll(prompt, "[PROMPT REDACTED]");
  for (const rootVariant of new Set([
    root,
    root.replaceAll("\\", "/"),
    root.replaceAll("/", "\\"),
  ])) {
    if (rootVariant.length > 0) text = text.replaceAll(rootVariant, "<root>");
  }
  text = [...text]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
        ? character
        : "\uFFFD";
    })
    .join("");
  if (text.length <= MAX_LIVE_FINAL_RESULT_CHARS) return text;
  const prefix = text.slice(0, MAX_LIVE_FINAL_RESULT_CHARS - 1);
  const safePrefix = /[\ud800-\udbff]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
  return `${safePrefix}…`;
}

function waitForChild(child: LiveChild, alreadyClosed: () => boolean, timeoutMs: number) {
  if (alreadyClosed()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish as (...args: never[]) => void);
    child.once("error", finish as (...args: never[]) => void);
  });
}

async function terminateWindowsTree(
  child: LiveChild,
  seam: LiveProcessSeam,
  alreadyClosed: () => boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (child.pid === undefined || alreadyClosed()) return;
  let killer: LiveChild | undefined;
  try {
    const taskkill = system32Executable("taskkill.exe", env);
    if (taskkill === undefined) throw new Error("taskkill unavailable");
    killer = seam.spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let killerClosed = false;
    killer.once("close", (() => {
      killerClosed = true;
    }) as (...args: never[]) => void);
    await waitForChild(killer, () => killerClosed, 1_000);
  } catch {
    try {
      child.kill();
    } catch {
      // Cleanup is best-effort but bounded and never exposes native diagnostics.
    }
  }
  await waitForChild(child, alreadyClosed, 1_000);
}

async function terminatePosixTree(
  child: LiveChild,
  seam: LiveProcessSeam,
  alreadyClosed: () => boolean,
): Promise<void> {
  if (child.pid === undefined || alreadyClosed()) return;
  try {
    seam.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Continue to the bounded KILL fallback.
    }
  }
  await waitForChild(child, alreadyClosed, 750);
  if (alreadyClosed()) return;
  try {
    seam.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The cleanup boundary still settles after the bounded wait.
    }
  }
  await waitForChild(child, alreadyClosed, 750);
}

/** Run exactly one explicitly selected local CLI and return its one sanitized terminal result. */
export async function runLiveCli(cli: LiveCli, options: LiveRunOptions): Promise<LiveResult> {
  const seam = options.process ?? defaultProcessSeam;
  const progress = createProgress(cli, options.progress);
  progress.started();
  let launch: LiveLaunch;
  try {
    launch = launchFor(cli, options.prompt, options.env, seam.platform);
  } catch {
    progress.terminal("unavailable");
    throw new LiveUnavailableError(cli, safetyFor(cli));
  }

  let child: LiveChild;
  try {
    child = seam.spawn(launch.executable, launch.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
      detached: seam.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    progress.terminal("failed");
    throw new LiveSpawnError(cli, safetyFor(cli));
  }

  let childClosed = false;
  let cleanupPromise: Promise<void> | undefined;
  child.once("close", (() => {
    childClosed = true;
  }) as (...args: never[]) => void);
  const cleanup = (): Promise<void> => {
    cleanupPromise ??=
      seam.platform === "win32"
        ? terminateWindowsTree(child, seam, () => childClosed, options.env).catch(() => {})
        : terminatePosixTree(child, seam, () => childClosed).catch(() => {});
    return cleanupPromise;
  };
  options.deferCleanup(cleanup);

  return new Promise<LiveResult>((resolve, reject) => {
    let state: "running" | "settling" | "settled" = "running";
    let finalCandidate: string | undefined;
    let terminalError = false;
    let stdoutEnded = false;
    let pending = "";
    let droppingLongLine = false;
    const decoder = new StringDecoder("utf8");

    const consumeLine = (line: string): void => {
      const inspected = inspectLine(cli, line.endsWith("\r") ? line.slice(0, -1) : line);
      progress.activity(inspected.activity);
      if (inspected.terminalError === true) terminalError = true;
      if (inspected.result !== undefined) finalCandidate = inspected.result;
    };
    const consumeText = (text: string): void => {
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          if (pending.length > MAX_LIVE_NATIVE_LINE_CHARS) {
            pending = "";
            droppingLongLine = true;
            progress.activity("native_stdout_line_capped");
          }
          return;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (droppingLongLine) {
          droppingLongLine = false;
          continue;
        }
        if (line.length > MAX_LIVE_NATIVE_LINE_CHARS) {
          progress.activity("native_stdout_line_capped");
          continue;
        }
        consumeLine(line);
      }
    };
    const finishStdout = (): void => {
      if (stdoutEnded) return;
      stdoutEnded = true;
      consumeText(decoder.end());
      if (!droppingLongLine && pending.length > 0) consumeLine(pending);
      pending = "";
    };

    const settleFailure = async (
      error: Error,
      status: Exclude<LiveTerminalStatus, "completed" | "unavailable">,
    ): Promise<void> => {
      if (state !== "running") return;
      state = "settling";
      clearTimeout(timer);
      await cleanup();
      if (state !== "settling") return;
      state = "settled";
      progress.terminal(status);
      reject(error);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (state === "running") consumeText(decoder.write(Buffer.from(chunk)));
    });
    child.stdout?.once("end", finishStdout);
    child.stdout?.once("error", () => {
      void settleFailure(new LiveStreamError(cli, safetyFor(cli)), "failed");
    });
    child.stderr?.on("data", () => {
      if (state === "running") progress.activity("native_stderr");
    });
    child.stderr?.once("error", () => {
      void settleFailure(new LiveStreamError(cli, safetyFor(cli)), "failed");
    });
    child.stdin?.once("error", () => {
      if (state === "running") {
        void settleFailure(new LiveStreamError(cli, safetyFor(cli)), "failed");
      }
    });

    child.once("error", (() => {
      void settleFailure(new LiveSpawnError(cli, safetyFor(cli)), "failed");
    }) as (...args: never[]) => void);
    child.once("close", ((code: number | null) => {
      if (state !== "running") return;
      clearTimeout(timer);
      finishStdout();
      state = "settled";
      if (
        code !== 0 ||
        terminalError ||
        finalCandidate === undefined ||
        finalCandidate.length === 0
      ) {
        progress.terminal("failed");
        reject(new LiveResultError(cli, safetyFor(cli)));
        return;
      }
      const result = boundedVisibleText(finalCandidate, options.prompt, options.cwd, options.env);
      progress.terminal("completed");
      resolve({
        schemaVersion: 1,
        cli,
        safety: safetyFor(cli),
        result,
      });
    }) as (...args: never[]) => void);

    const timer = setTimeout(() => {
      void settleFailure(new LiveTimeoutError(cli, safetyFor(cli)), "timed_out");
    }, options.timeoutMs);

    if (launch.promptOnStdin) child.stdin?.end(options.prompt);
    else child.stdin?.end();
  });
}
