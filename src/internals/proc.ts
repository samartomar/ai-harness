import { execFile } from "node:child_process";
import { hermeticGitEnv, isGitExecutable } from "./git-env.js";

/**
 * The single external-process seam for the whole harness. PowerShell, nvidia-smi,
 * curl, gitleaks, docker — every subprocess goes through a {@link Runner}. Tests
 * inject a fake so no unit test ever spawns a real process or touches the network.
 */
export interface RunResult {
  /** Process exit code; null when terminated by signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the executable could not be found / spawned (ENOENT, timeout). */
  spawnError?: boolean;
  /** True when captured output exceeded the configured bound and is incomplete. */
  truncated?: boolean;
}

export interface RunOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Abort the child without requiring callers to own process handles. */
  signal?: AbortSignal;
  /** Optional bounded-output seam for callers and focused tests. */
  maxBufferBytes?: number;
}

export type Runner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

/** Error shape that node's exec callbacks actually produce at runtime. */
type ProcError =
  | (Error & { code?: number | string; killed?: boolean; signal?: string | null })
  | null;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Default runner backed by `child_process.execFile`. Never rejects on non-zero
 * exit — it resolves a {@link RunResult} so callers branch on `code`/`spawnError`
 * instead of try/catch. `argv[0]` is the executable; remaining items are args
 * (no shell, so no quoting/injection surface).
 */
export const defaultRunner: Runner = (argv, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolve({ code: 1, stdout: "", stderr: "empty argv", spawnError: true });
      return;
    }
    const maxBufferBytes = opts.maxBufferBytes ?? MAX_BUFFER;
    // Every production git spawn funnels through here, so the worktree-commit
    // leak is closed once, centrally: git resolves its repo from an inherited
    // GIT_DIR/GIT_INDEX_FILE BEFORE `cwd`/`-C`, so a spawn under a git hook
    // would otherwise escape into the caller's repository (see ./git-env.ts).
    const baseEnv = opts.env ?? process.env;
    let capturedStdout = "";
    let capturedStderr = "";
    let settled = false;
    let removeAbortListener: () => void = () => undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resolve(result);
    };
    if (opts.signal?.aborted) {
      finish({ code: 1, stdout: "", stderr: "process aborted", spawnError: true });
      return;
    }
    const capture = (chunk: string | Buffer): string =>
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          env: isGitExecutable(cmd) ? hermeticGitEnv(baseEnv) : baseEnv,
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: maxBufferBytes,
          windowsHide: true,
        },
        (err: ProcError, stdout, stderr) => {
          const stdoutText = stdout && stdout.length > 0 ? stdout : capturedStdout;
          const stderrText = stderr && stderr.length > 0 ? stderr : capturedStderr;
          const errno = err?.code;
          if (errno === "ENOENT") {
            finish({
              code: 127,
              stdout: "",
              stderr: String(err?.message ?? "not found"),
              spawnError: true,
            });
            return;
          }
          if (errno === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            const outputDetail = `process output exceeded ${maxBufferBytes} bytes; captured output is incomplete`;
            const trimmedStderr = stderrText.trim();
            finish({
              code: typeof errno === "number" ? errno : 1,
              stdout: stdoutText,
              stderr: trimmedStderr.length > 0 ? `${trimmedStderr}\n${outputDetail}` : outputDetail,
              truncated: true,
            });
            return;
          }
          const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
          if (err?.killed) {
            const timeoutDetail = `process timed out after ${timeoutMs}ms`;
            const trimmedStderr = stderrText.trim();
            finish({
              code: typeof errno === "number" ? errno : 1,
              stdout: stdoutText,
              stderr:
                trimmedStderr.length > 0 ? `${trimmedStderr}\n${timeoutDetail}` : timeoutDetail,
              spawnError: true,
            });
            return;
          }
          const code = typeof errno === "number" ? errno : err ? 1 : 0;
          finish({ code, stdout: stdoutText, stderr: stderrText });
        },
      );
    } catch {
      finish({
        code: 1,
        stdout: "",
        stderr: "process could not start",
        spawnError: true,
      });
      return;
    }
    const abort = (): void => {
      child.kill();
      finish({
        code: 1,
        stdout: capturedStdout,
        stderr: "process aborted",
        spawnError: true,
      });
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => opts.signal?.removeEventListener("abort", abort);
    if (opts.signal?.aborted) {
      abort();
      return;
    }
    child.stdout?.on("data", (chunk: string | Buffer) => {
      capturedStdout += capture(chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      capturedStderr += capture(chunk);
    });
    child.stdin?.on("error", () => {
      child.kill();
      finish({
        code: 1,
        stdout: capturedStdout,
        stderr: "process stdin write failed",
        spawnError: true,
      });
    });
    try {
      child.stdin?.end(opts.input);
    } catch {
      child.kill();
      finish({
        code: 1,
        stdout: capturedStdout,
        stderr: "process stdin write failed",
        spawnError: true,
      });
    }
  });

/**
 * Build a fake runner for tests. The handler maps an argv to a partial result;
 * returning `undefined` yields a clean exit-0 with empty output.
 */
export function fakeRunner(
  handler: (argv: string[], opts?: RunOptions) => Partial<RunResult> | undefined,
): Runner {
  return async (argv, opts) => {
    const r = handler(argv, opts) ?? {};
    return { code: 0, stdout: "", stderr: "", ...r };
  };
}

/** A runner that fails as if no executable exists — for "tool absent" test paths. */
export const missingToolRunner: Runner = async () => ({
  code: 127,
  stdout: "",
  stderr: "not found",
  spawnError: true,
});
