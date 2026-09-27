import { type ChildProcess, spawnSync } from "node:child_process";
import { win32 } from "node:path";

/**
 * Spawn option that makes a child the leader of its own process group on
 * POSIX, so the whole tree can be signalled; Windows trees are found by
 * `taskkill /T` instead.
 */
export function processTreeDetached(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function taskkill(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
    throw new Error("cannot end the process tree: SystemRoot is not an absolute path");
  }
  return win32.join(systemRoot, "System32", "taskkill.exe");
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH: every member of the group has already exited.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Force-end a tree synchronously; used where no event loop turn remains. */
export function killProcessTreeSync(
  pid: number,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    const result = spawnSync(taskkill(env), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error !== undefined) throw result.error;
    return;
  }
  signalGroup(pid, "SIGKILL");
}

function exitedWithin(exited: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((settle) => {
    const timer = setTimeout(() => settle(false), ms);
    exited.then(
      () => {
        clearTimeout(timer);
        settle(true);
      },
      () => {
        clearTimeout(timer);
        settle(true);
      },
    );
  });
}

/**
 * End `child` and every descendant, then verify the root exited. POSIX gets
 * SIGTERM, a bounded wait, then SIGKILL for the whole group; Windows gets
 * `taskkill /T /F`. A tree that survives is an error, never a silent success.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  exited: Promise<unknown>,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform !== "win32") {
    signalGroup(pid, "SIGTERM");
    await exitedWithin(exited, 1_000);
  }
  killProcessTreeSync(pid, env, platform);
  if (!(await exitedWithin(exited, 5_000))) {
    throw new Error(`process tree ${pid} did not exit after it was terminated`);
  }
}
