import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { findOnPath } from "../live/runner.js";
import {
  authenticateHeadroomRuntimeRoot,
  HEADROOM_DEPENDENCY_LOCK_SHA256,
  HEADROOM_RUNTIME_PIN,
  headroomLayoutFor,
  headroomPlatform,
  isolatedHeadroomEnvironment,
} from "./headroom.js";
import { readHeadroomReceipt } from "./headroom-receipt.js";
import { killProcessTreeSync, processTreeDetached, terminateProcessTree } from "./process-tree.js";

const LAUNCHER_OPTIONS = [
  "--package",
  "--dependency-lock-sha256",
  "--lock-root",
  "--project",
  "--state-root",
] as const;

/** How long the server may take to exit on its own after its client closes stdin. */
const HEADROOM_EXIT_GRACE_MS = 3_000;
const PARENT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const REACTIVATE =
  "run `aih developer-tools <root> --activate-headroom --accept-headroom-egress --apply`";

export interface HeadroomLauncherIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess?: typeof spawn;
  readonly exitGraceMs?: number;
}

function contains(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function options(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Headroom launcher arguments must be explicit option/value pairs");
    }
    if (values.has(key)) throw new Error(`duplicate Headroom launcher option: ${key}`);
    values.set(key, value);
  }
  const unknown = [...values.keys()].filter(
    (key) => !(LAUNCHER_OPTIONS as readonly string[]).includes(key),
  );
  const missing = LAUNCHER_OPTIONS.filter((key) => !values.has(key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `invalid Headroom launcher options (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
  return values;
}

function realDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const stats = lstatSync(value, { throwIfNoEntry: false });
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an existing real directory`);
  }
  return realpathSync(value);
}

/** Reject a missing or redirected state root without creating anything. */
function activatedStateRoot(value: string, project: string): string {
  if (!isAbsolute(value)) throw new Error("Headroom state root must be absolute");
  const destination = resolve(value);
  if (contains(project, destination) || contains(destination, project)) {
    throw new Error("Headroom state root must remain outside and disjoint from the project");
  }
  let cursor = parse(destination).root;
  for (const segment of relative(cursor, destination)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const stats = lstatSync(cursor, { throwIfNoEntry: false });
    if (stats === undefined) {
      throw new Error(`Headroom is not activated for this worktree; ${REACTIVATE}`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Headroom state root has a non-directory or linked path segment");
    }
  }
  return destination;
}

/**
 * Proxy stdio to `uv run … headroom mcp serve` and own its whole tree: uv
 * waits on python, and neither is guaranteed to exit on stdin EOF, so when
 * the client closes stdin (or this launcher is signalled or exits) the tree is
 * ended rather than left holding the activated state open.
 */
async function proxyTransparentMcp(
  child: ChildProcessWithoutNullStreams,
  io: HeadroomLauncherIo,
): Promise<number> {
  const exited = new Promise<number>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
  let terminating: Promise<void> | undefined;
  const terminate = () => {
    terminating ??= terminateProcessTree(child, exited, io.env);
    return terminating;
  };
  let grace: NodeJS.Timeout | undefined;
  const onClientClosed = () => {
    grace ??= setTimeout(() => {
      terminate().catch(() => undefined);
    }, io.exitGraceMs ?? HEADROOM_EXIT_GRACE_MS);
  };
  const onParentExit = () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killProcessTreeSync(child.pid, io.env);
    }
  };
  const onParentSignal = (signal: NodeJS.Signals) => {
    onParentExit();
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
  };
  process.once("exit", onParentExit);
  for (const signal of PARENT_SIGNALS) process.once(signal, onParentSignal);
  io.stdin.once("end", onClientClosed);
  io.stdin.once("close", onClientClosed);
  io.stdin.pipe(child.stdin);
  // A write racing the server's exit is expected; the exit code reports the outcome.
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => io.stdout.write(chunk));
  child.stderr.on("data", (chunk) => io.stderr.write(chunk));
  try {
    const code = await exited;
    if (terminating !== undefined) await terminating;
    else if (processTreeDetached()) await terminate();
    return code;
  } finally {
    if (grace !== undefined) clearTimeout(grace);
    process.off("exit", onParentExit);
    for (const signal of PARENT_SIGNALS) process.off(signal, onParentSignal);
    io.stdin.off("end", onClientClosed);
    io.stdin.off("close", onClientClosed);
  }
}

/**
 * The generated `headroom` launcher mode. It starts `headroom mcp serve` only
 * for an explicitly activated worktree whose receipt matches this Core's pins,
 * from the authenticated lock, offline, with a credential-free environment.
 */
export async function runHeadroomMcpLauncher(
  args: readonly string[],
  io: HeadroomLauncherIo,
): Promise<number> {
  const values = options(args);
  if (values.get("--package") !== HEADROOM_RUNTIME_PIN.package) {
    throw new Error("Headroom package pin is not accepted");
  }
  if (values.get("--dependency-lock-sha256") !== HEADROOM_DEPENDENCY_LOCK_SHA256) {
    throw new Error("Headroom dependency lock is not accepted");
  }
  const platform = headroomPlatform(process.platform, process.arch);
  if (platform === undefined) {
    throw new Error(
      `Headroom ${HEADROOM_RUNTIME_PIN.version} has no pinned wheel closure for ${process.platform}-${process.arch}`,
    );
  }
  const project = realDirectory(values.get("--project") ?? "", "Headroom project");
  const stateRoot = activatedStateRoot(values.get("--state-root") ?? "", project);
  const lockRoot = authenticateHeadroomRuntimeRoot(values.get("--lock-root") ?? "", project, [
    stateRoot,
  ]);
  const layout = headroomLayoutFor(project, lockRoot, stateRoot);
  const receipt = readHeadroomReceipt(layout);
  if (receipt.state === "absent") {
    throw new Error(`Headroom is not activated for this worktree; ${REACTIVATE}`);
  }
  if (receipt.state === "invalid") {
    throw new Error(`Headroom activation receipt is invalid (${receipt.reason}); ${REACTIVATE}`);
  }
  if (receipt.state === "stale") {
    throw new Error(`Headroom activation is stale (${receipt.reason}); re-activate: ${REACTIVATE}`);
  }
  if (receipt.receipt.pin.platform !== platform) {
    throw new Error(`Headroom was activated for ${receipt.receipt.pin.platform}; ${REACTIVATE}`);
  }
  const environment = lstatSync(layout.environment, { throwIfNoEntry: false });
  if (environment === undefined || environment.isSymbolicLink() || !environment.isDirectory()) {
    throw new Error(`Headroom runtime environment is missing; ${REACTIVATE}`);
  }
  const workspace = realDirectory(layout.workspace, "Headroom workspace");
  const uv = findOnPath("uv", io.env, process.platform, {
    excludeRoot: project,
    windowsExeOnly: true,
  });
  if (uv === undefined) {
    throw new Error("uv must resolve to an absolute executable outside the target project");
  }
  const child = (io.spawnProcess ?? spawn)(
    uv,
    [
      "--project",
      lockRoot,
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "--no-config",
      "python",
      "-m",
      "headroom.cli",
      "mcp",
      "serve",
    ],
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedHeadroomEnvironment(io.env, layout, "runtime"),
      detached: processTreeDetached(),
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  return proxyTransparentMcp(child, io);
}
