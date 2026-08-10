import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { containedPath, inspectContainedRelativePath } from "./contained-path.js";
import { readRegularFileWithStats, retryTransient } from "./fsxn.js";

export type OwnedFileRead =
  | { state: "absent" }
  | { state: "present"; bytes: Buffer; mode: number }
  | { state: "unreadable"; detail: string };

export type OwnedFileAction = "assert" | "write" | "remove";

export type OwnedFileExpectation = { absent: true } | { sha256: string; mode?: number };

export interface OwnedFileStep {
  action?: OwnedFileAction;
  path: string;
  mode: number;
  contents?: Buffer;
  expect: OwnedFileExpectation;
  prior?: Buffer;
  priorMode?: number;
  announce?: () => void;
}

export interface OwnedFilePolicy {
  label: string;
  maxFileBytes: number;
  contentDirectoryMode: number;
  stateDirectoryMode: number;
  statePaths: ReadonlySet<string>;
  assertOwnedPath(path: string, ownState: boolean): void;
  assertResolvedSegments(segments: readonly string[], requested: string, ownState: boolean): void;
  assertAction?(path: string, action: OwnedFileAction, ownState: boolean): void;
}

export interface OwnedFileTransactionDeps {
  rename?: (from: string, to: string) => void;
  beforeEffects?: () => void;
  afterEffects?: () => void;
}

const MAX_STEPS = 100_000;
const MAX_TOTAL_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const SAFE_LABEL = /^[\x20-\x7e]{1,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UNSAFE_PATH_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const STEP_KEYS = new Set([
  "action",
  "path",
  "mode",
  "contents",
  "expect",
  "prior",
  "priorMode",
  "announce",
]);
const DEP_KEYS = new Set(["rename", "beforeEffects", "afterEffects"]);

interface SnapshotPolicy extends OwnedFilePolicy {
  statePaths: ReadonlySet<string>;
}

interface SnapshotDeps {
  rename?: (from: string, to: string) => void;
  beforeEffects?: () => void;
  afterEffects?: () => void;
}

const nativeRealpath = (realpathSync as unknown as { native?: (path: string) => string }).native;

function safeText(value: string): string {
  const bounded = [...value].slice(0, 512).join("");
  return bounded.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
}

function ownData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("invalid owned file transaction steps");
  }
  return descriptor.value;
}

function optionalOwnData(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("invalid owned file transaction steps");
  }
  return descriptor.value;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validMode(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 0o777;
}

function validPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 1_024 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes(":") ||
    UNSAFE_PATH_TEXT.test(path)
  ) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function snapshotExpectation(value: unknown): OwnedFileExpectation {
  if (!plainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("invalid owned file transaction steps");
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length === 1 && names[0] === "absent" && ownData(value, "absent") === true) {
    return { absent: true };
  }
  if (
    (names.length === 1 || names.length === 2) &&
    names.includes("sha256") &&
    names.every((name) => name === "sha256" || name === "mode")
  ) {
    const digest = ownData(value, "sha256");
    const hasMode = names.includes("mode");
    const mode = optionalOwnData(value, "mode");
    if (typeof digest === "string" && SHA256.test(digest) && (!hasMode || validMode(mode))) {
      return { sha256: digest, ...(hasMode ? { mode: mode as number } : {}) };
    }
  }
  throw new Error("invalid owned file transaction steps");
}

function snapshotDeps(value: unknown): SnapshotDeps {
  if (!plainObject(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("owned file transaction dependencies are invalid");
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !DEP_KEYS.has(name))) {
    throw new Error("owned file transaction dependencies are invalid");
  }
  const read = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("owned file transaction dependencies are invalid");
    }
    return descriptor.value;
  };
  const rename = read("rename");
  const beforeEffects = read("beforeEffects");
  const afterEffects = read("afterEffects");
  if (
    (rename !== undefined && typeof rename !== "function") ||
    (beforeEffects !== undefined && typeof beforeEffects !== "function") ||
    (afterEffects !== undefined && typeof afterEffects !== "function")
  ) {
    throw new Error("owned file transaction dependencies are invalid");
  }
  return {
    ...(rename === undefined ? {} : { rename: rename as (from: string, to: string) => void }),
    ...(beforeEffects === undefined ? {} : { beforeEffects: beforeEffects as () => void }),
    ...(afterEffects === undefined ? {} : { afterEffects: afterEffects as () => void }),
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotSteps(input: readonly OwnedFileStep[], policy: SnapshotPolicy): OwnedFileStep[] {
  if (
    isProxy(input) ||
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    Object.getOwnPropertySymbols(input).length !== 0 ||
    input.length > MAX_STEPS
  ) {
    throw new Error("invalid owned file transaction steps");
  }
  const names = Object.getOwnPropertyNames(input);
  if (
    names.length !== input.length + 1 ||
    !names.includes("length") ||
    names.some((name) => name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name))
  ) {
    throw new Error("invalid owned file transaction steps");
  }

  let totalBytes = 0;
  const snapshots: OwnedFileStep[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const candidate = ownData(input, String(index));
    if (!plainObject(candidate) || Object.getOwnPropertySymbols(candidate).length !== 0) {
      throw new Error("invalid owned file transaction steps");
    }
    const keys = Object.getOwnPropertyNames(candidate);
    if (keys.some((key) => !STEP_KEYS.has(key))) {
      throw new Error("invalid owned file transaction steps");
    }
    const path = ownData(candidate, "path");
    const mode = ownData(candidate, "mode");
    const expect = snapshotExpectation(ownData(candidate, "expect"));
    const rawAction = optionalOwnData(candidate, "action");
    const rawContents = optionalOwnData(candidate, "contents");
    const rawPrior = optionalOwnData(candidate, "prior");
    const priorMode = optionalOwnData(candidate, "priorMode");
    const announce = optionalOwnData(candidate, "announce");
    const action =
      rawAction === undefined ? (rawContents === undefined ? "remove" : "write") : rawAction;
    if (
      !validPath(path) ||
      !validMode(mode) ||
      (action !== "assert" && action !== "write" && action !== "remove") ||
      (rawContents !== undefined && !Buffer.isBuffer(rawContents)) ||
      (rawPrior !== undefined && !Buffer.isBuffer(rawPrior)) ||
      (priorMode !== undefined && !validMode(priorMode)) ||
      (announce !== undefined && typeof announce !== "function")
    ) {
      throw new Error("invalid owned file transaction steps");
    }
    const contents = rawContents === undefined ? undefined : Buffer.from(rawContents);
    const prior = rawPrior === undefined ? undefined : Buffer.from(rawPrior);
    if (
      (contents !== undefined && contents.byteLength > policy.maxFileBytes) ||
      (prior !== undefined && prior.byteLength > policy.maxFileBytes)
    ) {
      throw new Error("invalid owned file transaction steps");
    }
    totalBytes += (contents?.byteLength ?? 0) + (prior?.byteLength ?? 0);
    if (totalBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
      throw new Error("invalid owned file transaction steps");
    }
    const mutation = action !== "assert";
    if (
      (action === "assert" &&
        (contents !== undefined || prior !== undefined || priorMode !== undefined)) ||
      (action === "write" && contents === undefined) ||
      (action === "remove" && contents !== undefined) ||
      ("absent" in expect && (prior !== undefined || priorMode !== undefined)) ||
      ("sha256" in expect &&
        mutation &&
        (prior === undefined ||
          sha256(prior) !== expect.sha256 ||
          (expect.mode !== undefined && priorMode !== expect.mode)))
    ) {
      throw new Error("invalid owned file transaction steps");
    }
    const ownState = policy.statePaths.has(path);
    policy.assertOwnedPath(path, ownState);
    policy.assertAction?.(path, "assert", ownState);
    if (action !== "assert") {
      policy.assertAction?.(path, action, ownState);
      policy.assertAction?.(path, prior === undefined ? "remove" : "write", ownState);
    }
    snapshots.push({
      action,
      path,
      mode,
      ...(contents === undefined ? {} : { contents }),
      expect,
      ...(prior === undefined ? {} : { prior }),
      ...(priorMode === undefined ? {} : { priorMode }),
      ...(announce === undefined ? {} : { announce: announce as () => void }),
    });
  }
  return snapshots;
}

function snapshotPolicy(policy: OwnedFilePolicy): SnapshotPolicy {
  if (isProxy(policy)) {
    throw new Error("invalid owned file transaction policy");
  }
  const label = SAFE_LABEL.test(policy.label) ? policy.label : "owned file transaction";
  const actionDescriptor = Object.getOwnPropertyDescriptor(policy, "assertAction");
  const inheritedAction = actionDescriptor === undefined && "assertAction" in policy;
  const assertAction =
    actionDescriptor === undefined
      ? undefined
      : "value" in actionDescriptor && actionDescriptor.enumerable
        ? actionDescriptor.value
        : null;
  if (
    inheritedAction ||
    !Number.isSafeInteger(policy.maxFileBytes) ||
    policy.maxFileBytes < 0 ||
    !validMode(policy.contentDirectoryMode) ||
    !validMode(policy.stateDirectoryMode) ||
    !(policy.statePaths instanceof Set) ||
    typeof policy.assertOwnedPath !== "function" ||
    typeof policy.assertResolvedSegments !== "function" ||
    (assertAction !== undefined && typeof assertAction !== "function")
  ) {
    throw new Error("invalid owned file transaction policy");
  }
  return {
    label,
    maxFileBytes: policy.maxFileBytes,
    contentDirectoryMode: policy.contentDirectoryMode,
    stateDirectoryMode: policy.stateDirectoryMode,
    statePaths: new Set(policy.statePaths),
    assertOwnedPath: policy.assertOwnedPath,
    assertResolvedSegments: policy.assertResolvedSegments,
    ...(assertAction === undefined
      ? {}
      : { assertAction: assertAction as OwnedFilePolicy["assertAction"] }),
  };
}

function lstatOrAbsent(path: string, label: string): Stats | undefined {
  try {
    return retryTransient(() => lstatSync(path));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`${label} path is inaccessible: ${safeText(path)} (${code ?? "unknown"})`);
  }
}

export function resolveOwnedFileRoot(root: string, label: string): string {
  const safeLabel = SAFE_LABEL.test(label) ? label : "owned file transaction";
  if (typeof nativeRealpath !== "function") {
    throw new Error(
      `${safeLabel} requires fs.realpathSync.native; the JS implementation does not resolve filesystem aliases and would defeat the reserved-path guard`,
    );
  }
  if (!isAbsolute(root)) throw new Error(`${safeLabel} root must be an absolute path`);
  const stats = lstatOrAbsent(root, safeLabel);
  if (stats === undefined) {
    throw new Error(`${safeLabel} root is not a directory: ${safeText(root)}`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${safeLabel} root must be a real directory: ${safeText(root)}`);
  }
  return nativeRealpath(root);
}

export class OwnedFileTransaction {
  private readonly root: string;
  private readonly policy: SnapshotPolicy;
  private readonly rename?: (from: string, to: string) => void;
  private readonly beforeEffects?: () => void;
  private readonly afterEffects?: () => void;

  constructor(root: string, policy: OwnedFilePolicy, deps: OwnedFileTransactionDeps = {}) {
    const safeDeps = snapshotDeps(deps);
    this.policy = snapshotPolicy(policy);
    this.root = resolveOwnedFileRoot(root, this.policy.label);
    this.rename = safeDeps.rename;
    this.beforeEffects = safeDeps.beforeEffects;
    this.afterEffects = safeDeps.afterEffects;
  }

  private ownState(path: string): boolean {
    return this.policy.statePaths.has(path);
  }

  private assertAction(path: string, action: OwnedFileAction): void {
    this.policy.assertAction?.(path, action, this.ownState(path));
  }

  private assertSafeParents(path: string): void {
    const ownState = this.ownState(path);
    this.policy.assertOwnedPath(path, ownState);
    const segments = path.split("/");
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      const isLeaf = index === segments.length - 1;
      current = resolve(current, segments[index] as string);
      const stats = lstatOrAbsent(current, this.policy.label);
      if (stats === undefined) return;
      if (stats.isSymbolicLink()) {
        throw new Error(
          isLeaf
            ? `refusing a symlinked ${this.policy.label} destination: ${safeText(path)}`
            : `refusing a symlinked ${this.policy.label} destination parent: ${safeText(path)}`,
        );
      }
      if (!isLeaf && !stats.isDirectory()) {
        throw new Error(
          `${this.policy.label} destination parent is not a directory: ${safeText(path)}`,
        );
      }
      if (typeof nativeRealpath !== "function") {
        throw new Error(`invalid ${this.policy.label} filesystem boundary`);
      }
      const canonical = nativeRealpath(current);
      if (!containedPath(this.root, canonical)) {
        throw new Error(`${this.policy.label} destination escapes its root: ${safeText(path)}`);
      }
      const resolvedSegments = relative(this.root, canonical)
        .split(/[\\/]/)
        .filter((segment) => segment.length > 0);
      this.policy.assertResolvedSegments(resolvedSegments, path, ownState);
      current = canonical;
    }
  }

  inspect(path: string): OwnedFileRead {
    try {
      if (!validPath(path)) throw new Error(`invalid ${this.policy.label} destination path`);
      this.assertAction(path, "assert");
      this.assertSafeParents(path);
      const inspected = inspectContainedRelativePath(this.root, path);
      if (inspected.state === "absent") return { state: "absent" };
      if (inspected.state === "unsafe") {
        return {
          state: "unreadable",
          detail:
            inspected.reason === "symlink"
              ? `${this.policy.label} destination is a symlink: ${safeText(path)}`
              : `${this.policy.label} destination is unsafe (${inspected.reason}): ${safeText(path)}`,
        };
      }
      if (inspected.kind !== "file") {
        return {
          state: "unreadable",
          detail: `${this.policy.label} destination is not a regular file: ${safeText(path)}`,
        };
      }
      const opened = readRegularFileWithStats(inspected.realPath, {
        maxBytes: this.policy.maxFileBytes,
      });
      if (opened === undefined || opened.stats.nlink > 1) {
        return {
          state: "unreadable",
          detail: `${this.policy.label} destination is not a bounded unambiguous regular file: ${safeText(path)}`,
        };
      }
      return {
        state: "present",
        bytes: Buffer.from(opened.contents),
        mode: opened.stats.mode & 0o777,
      };
    } catch (error) {
      return { state: "unreadable", detail: (error as Error).message };
    }
  }

  read(path: string): Buffer | undefined {
    const live = this.inspect(path);
    if (live.state === "unreadable") throw new Error(`refusing ${live.detail}`);
    return live.state === "absent" ? undefined : Buffer.from(live.bytes);
  }

  private prepareDirectory(path: string): string {
    const ownState = this.ownState(path);
    const segments = path.split("/");
    let current = this.root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      current = join(current, segments[index] as string);
      const stats = lstatOrAbsent(current, this.policy.label);
      if (stats === undefined) {
        mkdirSync(current, {
          recursive: false,
          mode: ownState ? this.policy.stateDirectoryMode : this.policy.contentDirectoryMode,
        });
      } else if (stats.isSymbolicLink()) {
        throw new Error(
          `refusing a symlinked ${this.policy.label} destination parent: ${safeText(path)}`,
        );
      } else if (!stats.isDirectory()) {
        throw new Error(
          `${this.policy.label} destination parent is not a directory: ${safeText(path)}`,
        );
      }
      if (typeof nativeRealpath !== "function") {
        throw new Error(`invalid ${this.policy.label} filesystem boundary`);
      }
      const canonical = nativeRealpath(current);
      if (!containedPath(this.root, canonical)) {
        throw new Error(`${this.policy.label} destination escapes its root: ${safeText(path)}`);
      }
      const resolvedSegments = relative(this.root, canonical)
        .split(/[\\/]/)
        .filter((segment) => segment.length > 0);
      this.policy.assertResolvedSegments(resolvedSegments, path, ownState);
      current = canonical;
    }
    return current;
  }

  writeAtomic(path: string, contents: Buffer, mode: number): void {
    if (!validPath(path) || !Buffer.isBuffer(contents) || !validMode(mode)) {
      throw new Error(`invalid ${this.policy.label} write`);
    }
    this.assertAction(path, "write");
    const snapshot = Buffer.from(contents);
    if (snapshot.byteLength > this.policy.maxFileBytes) {
      throw new Error(`invalid ${this.policy.label} write`);
    }
    this.assertSafeParents(path);
    const directory = this.prepareDirectory(path);
    const target = join(this.root, ...path.split("/"));
    if (lstatOrAbsent(target, this.policy.label)?.isSymbolicLink() === true) {
      throw new Error(
        `refusing to write through a symlinked ${this.policy.label} destination: ${safeText(path)}`,
      );
    }
    const temporary = join(directory, `.aih-owned-file.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, snapshot, { flag: "wx", mode });
      chmodSync(temporary, mode);
      const commit =
        this.rename ?? ((from: string, to: string) => retryTransient(() => renameSync(from, to)));
      commit(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  remove(path: string): void {
    if (!validPath(path)) throw new Error(`invalid ${this.policy.label} removal`);
    this.assertAction(path, "remove");
    this.assertSafeParents(path);
    const target = join(this.root, ...path.split("/"));
    const stats = lstatOrAbsent(target, this.policy.label);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new Error(
        `refusing to remove a symlinked ${this.policy.label} destination: ${safeText(path)}`,
      );
    }
    rmSync(target, { force: true });
  }

  private assertExpected(step: OwnedFileStep): void {
    const live = this.inspect(step.path);
    if (live.state === "unreadable") {
      throw new Error(
        `${this.policy.label} destination became unreadable before commit: ${safeText(step.path)}`,
      );
    }
    const unchanged =
      "absent" in step.expect
        ? live.state === "absent"
        : live.state === "present" &&
          sha256(live.bytes) === step.expect.sha256 &&
          (step.expect.mode === undefined || live.mode === step.expect.mode);
    if (!unchanged) {
      throw new Error(
        `${this.policy.label} destination changed before commit: ${safeText(step.path)}`,
      );
    }
  }

  commit(input: readonly OwnedFileStep[]): void {
    const steps = snapshotSteps(input, this.policy);
    for (const step of steps) this.assertSafeParents(step.path);
    const applied: OwnedFileStep[] = [];
    try {
      this.beforeEffects?.();
      for (const step of steps) {
        step.announce?.();
        this.assertExpected(step);
        if (step.action === "assert") continue;
        if (step.action === "remove") this.remove(step.path);
        else this.writeAtomic(step.path, step.contents as Buffer, step.mode);
        applied.push(step);
      }
      this.afterEffects?.();
    } catch (error) {
      const unrestored = this.rollback(applied);
      if (unrestored.length === 0) throw error;
      const original =
        error instanceof Error ? error.message : `invalid ${this.policy.label} failure`;
      throw new Error(
        `${original}; rollback did not restore ${unrestored.map(safeText).join(", ")}`,
      );
    }
  }

  private rollback(applied: readonly OwnedFileStep[]): string[] {
    const unrestored: string[] = [];
    for (const step of [...applied].reverse()) {
      try {
        const live = this.inspect(step.path);
        const asLeft =
          step.action === "remove"
            ? live.state === "absent"
            : live.state === "present" &&
              step.contents !== undefined &&
              sha256(live.bytes) === sha256(step.contents) &&
              (process.platform === "win32" || live.mode === step.mode);
        if (!asLeft) {
          unrestored.push(step.path);
          continue;
        }
        if (step.prior === undefined) {
          this.remove(step.path);
          continue;
        }
        this.writeAtomic(step.path, step.prior, step.priorMode ?? step.mode);
      } catch {
        unrestored.push(step.path);
      }
    }
    return unrestored;
  }
}
