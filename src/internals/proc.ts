import { execFile } from "node:child_process";

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
}

export interface RunOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
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
    let capturedStdout = "";
    let capturedStderr = "";
    const capture = (chunk: string | Buffer): string =>
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (err: ProcError, stdout, stderr) => {
        const stdoutText = stdout && stdout.length > 0 ? stdout : capturedStdout;
        const stderrText = stderr && stderr.length > 0 ? stderr : capturedStderr;
        const errno = err?.code;
        if (errno === "ENOENT") {
          resolve({
            code: 127,
            stdout: "",
            stderr: String(err?.message ?? "not found"),
            spawnError: true,
          });
          return;
        }
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (err?.killed) {
          const timeoutDetail = `process timed out after ${timeoutMs}ms`;
          const trimmedStderr = stderrText.trim();
          resolve({
            code: typeof errno === "number" ? errno : 1,
            stdout: stdoutText,
            stderr: trimmedStderr.length > 0 ? `${trimmedStderr}\n${timeoutDetail}` : timeoutDetail,
            spawnError: true,
          });
          return;
        }
        const code = typeof errno === "number" ? errno : err ? 1 : 0;
        resolve({ code, stdout: stdoutText, stderr: stderrText });
      },
    );
    child.stdout?.on("data", (chunk: string | Buffer) => {
      capturedStdout += capture(chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      capturedStderr += capture(chunk);
    });
    child.stdin?.end(opts.input);
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
