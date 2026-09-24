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

const LAUNCHER_OPTIONS = [
  "--package",
  "--dependency-lock-sha256",
  "--lock-root",
  "--project",
  "--state-root",
] as const;

const REACTIVATE =
  "run `aih developer-tools <root> --activate-headroom --accept-headroom-egress --apply`";

export interface HeadroomLauncherIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
  readonly spawnProcess?: typeof spawn;
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

function proxyTransparentMcp(
  child: ChildProcessWithoutNullStreams,
  io: HeadroomLauncherIo,
): Promise<number> {
  io.stdin.pipe(child.stdin);
  child.stdout.on("data", (chunk) => io.stdout.write(chunk));
  child.stderr.on("data", (chunk) => io.stderr.write(chunk));
  return new Promise<number>((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
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
      windowsHide: true,
    },
  ) as ChildProcessWithoutNullStreams;
  return proxyTransparentMcp(child, io);
}
