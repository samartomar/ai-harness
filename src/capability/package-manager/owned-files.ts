import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isProxy } from "node:util/types";
import {
  type OwnedFilePolicy,
  type OwnedFileRead,
  OwnedFileTransaction,
  resolveOwnedFileRoot,
} from "../../internals/owned-file-transaction.js";
import type { DeepReadonly } from "../package-graph/build.js";
import {
  CAPABILITY_PACKAGE_INTENT_PATH,
  MAX_CAPABILITY_PACKAGE_INTENT_BYTES,
  parseCapabilityPackageIntentBytes,
} from "./intent.js";
import {
  type CapabilityPackageLifecycleInput,
  type CapabilityPackageLifecycleResult,
  planCapabilityPackageLifecycle,
} from "./lifecycle.js";
import {
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
  MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES,
  parseCapabilityPackageOwnershipReceipt,
} from "./receipt.js";

const LABEL = "capability package state";
const INTENT_MODE = 0o644;
const RECEIPT_MODE = 0o600;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 300_000;
const MAX_INPUT_BUFFER_BYTES = Math.max(
  MAX_CAPABILITY_PACKAGE_INTENT_BYTES,
  MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES,
);
const STATE_PATHS = new Set([
  CAPABILITY_PACKAGE_INTENT_PATH,
  CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
]);

export type CapabilityPackageOwnedFileExpectation =
  | Readonly<{ absent: true }>
  | Readonly<{ sha256: string; mode: number }>;

export interface CapabilityPackageOwnedFileStep {
  readonly action: "assert" | "write" | "remove";
  readonly path: string;
  readonly mode: number;
  readonly expect: CapabilityPackageOwnedFileExpectation;
  readonly contents?: Buffer;
  readonly prior?: Buffer;
  readonly priorMode?: number;
}

export interface CapabilityPackageOwnedFilesPlan {
  readonly lifecycle: DeepReadonly<CapabilityPackageLifecycleResult>;
  readonly steps: readonly Readonly<CapabilityPackageOwnedFileStep>[];
}

interface SnapshotInput {
  root: string;
  lifecycleInput: CapabilityPackageLifecycleInput;
}

interface StateTarget {
  path: string;
  desired?: Buffer;
  mode: number;
  live: LiveState;
}

type LiveState = Exclude<OwnedFileRead, { state: "unreadable" }>;

function invalidInput(): never {
  throw new Error("capability package owned-files input is invalid");
}

function unsafeState(): never {
  throw new Error("capability package state is unsafe");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function guardedClone(input: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  let bufferBytes = 0;
  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) invalidInput();
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) invalidInput();
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || active.has(value)) invalidInput();
    if (Buffer.isBuffer(value)) {
      bufferBytes += value.byteLength;
      if (
        Object.getPrototypeOf(value) !== Buffer.prototype ||
        value.byteLength > MAX_INPUT_BUFFER_BYTES ||
        bufferBytes > MAX_INPUT_BUFFER_BYTES
      ) {
        invalidInput();
      }
      return Buffer.from(value);
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1
        ) {
          invalidInput();
        }
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            invalidInput();
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      const prototype = Object.getPrototypeOf(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        invalidInput();
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          invalidInput();
        }
        result[name] = clone(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  return clone(input, 0);
}

function snapshotInput(input: unknown): SnapshotInput {
  const cloned = guardedClone(input);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) invalidInput();
  const names = Object.keys(cloned);
  if (names.length !== 2 || !names.includes("root") || !names.includes("lifecycleInput")) {
    invalidInput();
  }
  const candidate = cloned as Record<string, unknown>;
  if (
    typeof candidate.root !== "string" ||
    !isAbsolute(candidate.root) ||
    candidate.lifecycleInput === null ||
    typeof candidate.lifecycleInput !== "object" ||
    Array.isArray(candidate.lifecycleInput)
  ) {
    invalidInput();
  }
  return candidate as unknown as SnapshotInput;
}

const POLICY: OwnedFilePolicy = {
  label: LABEL,
  maxFileBytes: Math.max(
    MAX_CAPABILITY_PACKAGE_INTENT_BYTES,
    MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES,
  ),
  contentDirectoryMode: 0o700,
  stateDirectoryMode: 0o700,
  statePaths: STATE_PATHS,
  assertOwnedPath(path, ownState) {
    if (!ownState || !STATE_PATHS.has(path)) unsafeState();
  },
  assertResolvedSegments(segments, requested, ownState) {
    if (!ownState || !STATE_PATHS.has(requested)) unsafeState();
    const expected = requested.split("/");
    if (segments.length > expected.length) unsafeState();
    for (const [index, segment] of segments.entries()) {
      if (segment !== expected[index]) unsafeState();
    }
  },
};

function transaction(root: string): OwnedFileTransaction {
  try {
    return new OwnedFileTransaction(resolveOwnedFileRoot(root, LABEL), POLICY);
  } catch {
    invalidInput();
  }
}

function inspect(transaction: OwnedFileTransaction, path: string): LiveState {
  const state = transaction.inspect(path);
  if (state.state === "unreadable") unsafeState();
  return state.state === "present"
    ? { state: "present", bytes: Buffer.from(state.bytes), mode: state.mode }
    : { state: "absent" };
}

function receiptFromLive(live: LiveState): unknown {
  if (live.state === "absent") return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(live.bytes);
    return parseCapabilityPackageOwnershipReceipt(text);
  } catch {
    return Object.freeze({ invalid: true });
  }
}

function invalidIntentLifecycle(
  _input: CapabilityPackageLifecycleInput,
): DeepReadonly<CapabilityPackageLifecycleResult> {
  return Object.freeze({
    schemaVersion: 1,
    status: "refused",
    changes: Object.freeze({ add: [], update: [], remove: [], unchanged: [] }),
    refusals: Object.freeze([
      Object.freeze({ stage: "intent" as const, code: "invalid-intent" as const }),
    ]),
  });
}

function mismatchLifecycle(): DeepReadonly<CapabilityPackageLifecycleResult> {
  return Object.freeze({
    schemaVersion: 1,
    status: "refused",
    changes: Object.freeze({ add: [], update: [], remove: [], unchanged: [] }),
    refusals: Object.freeze([
      Object.freeze({ stage: "operation" as const, code: "current-state-mismatch" as const }),
    ]),
  });
}

function desiredIntent(
  input: CapabilityPackageLifecycleInput,
  lifecycle: DeepReadonly<CapabilityPackageLifecycleResult>,
): Buffer | undefined {
  if (lifecycle.status === "refused") return undefined;
  if (input.operation === "remove") {
    return lifecycle.desiredIntent === undefined
      ? undefined
      : Buffer.from(lifecycle.desiredIntent.bytes);
  }
  return Buffer.from(input.intentBytes);
}

function desiredReceipt(
  lifecycle: DeepReadonly<CapabilityPackageLifecycleResult>,
): Buffer | undefined {
  return lifecycle.status === "ready" && lifecycle.desiredReceipt !== undefined
    ? Buffer.from(lifecycle.desiredReceipt.serialized, "utf8")
    : undefined;
}

function targetMatches(target: StateTarget): boolean {
  if (target.desired === undefined) return target.live.state === "absent";
  return (
    target.live.state === "present" &&
    target.live.mode === target.mode &&
    target.live.bytes.equals(target.desired)
  );
}

function publicBuffer(source: Buffer | undefined): (() => Buffer) | undefined {
  if (source === undefined) return undefined;
  const snapshot = Buffer.from(source);
  return () => Buffer.from(snapshot);
}

function stepFor(target: StateTarget): Readonly<CapabilityPackageOwnedFileStep> {
  const action =
    target.desired === undefined
      ? target.live.state === "absent"
        ? "assert"
        : "remove"
      : targetMatches(target)
        ? "assert"
        : "write";
  const expect = Object.freeze(
    target.live.state === "absent"
      ? { absent: true as const }
      : { sha256: sha256(target.live.bytes), mode: target.live.mode },
  );
  const contents = publicBuffer(action === "write" ? target.desired : undefined);
  const prior = publicBuffer(target.live.state === "present" ? target.live.bytes : undefined);
  const step: CapabilityPackageOwnedFileStep = {
    action,
    path: target.path,
    mode: target.mode,
    expect,
  };
  if (contents !== undefined) {
    Object.defineProperty(step, "contents", {
      enumerable: true,
      get: contents,
    });
  }
  if (prior !== undefined) {
    Object.defineProperties(step, {
      prior: { enumerable: true, get: prior },
      priorMode: {
        enumerable: true,
        value: target.live.state === "present" ? target.live.mode : undefined,
      },
    });
  }
  return Object.freeze(step);
}

function planResult(
  lifecycle: DeepReadonly<CapabilityPackageLifecycleResult>,
  steps: readonly Readonly<CapabilityPackageOwnedFileStep>[],
): DeepReadonly<CapabilityPackageOwnedFilesPlan> {
  return Object.freeze({ lifecycle, steps: Object.freeze([...steps]) });
}

/**
 * Plan exact package-manager metadata state only. This does not commit state and makes no claim
 * that package members are installed, configured, adopted, or owned.
 */
export function planCapabilityPackageOwnedFiles(
  input: unknown,
): DeepReadonly<CapabilityPackageOwnedFilesPlan> {
  const snapshot = snapshotInput(input);
  const files = transaction(snapshot.root);
  const liveIntent = inspect(files, CAPABILITY_PACKAGE_INTENT_PATH);
  const liveReceipt = inspect(files, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH);

  let parsedLiveIntent: ReturnType<typeof parseCapabilityPackageIntentBytes> | undefined;
  if (liveIntent.state === "present") {
    try {
      parsedLiveIntent = parseCapabilityPackageIntentBytes(liveIntent.bytes);
    } catch {
      return planResult(invalidIntentLifecycle(snapshot.lifecycleInput), []);
    }
  }
  const currentReceipt = receiptFromLive(liveReceipt);
  if (
    liveReceipt.state === "present" &&
    currentReceipt !== undefined &&
    "invalid" in (currentReceipt as Record<string, unknown>)
  ) {
    const lifecycle = planCapabilityPackageLifecycle({
      ...snapshot.lifecycleInput,
      currentReceipt,
    } as CapabilityPackageLifecycleInput);
    return planResult(lifecycle, []);
  }
  if (
    currentReceipt !== undefined &&
    (parsedLiveIntent === undefined ||
      (currentReceipt as { manifest: { sha256: string } }).manifest.sha256 !==
        parsedLiveIntent.sourceSha256)
  ) {
    return planResult(mismatchLifecycle(), []);
  }

  const lifecycle = planCapabilityPackageLifecycle({
    ...snapshot.lifecycleInput,
    currentReceipt,
  } as CapabilityPackageLifecycleInput);
  if (lifecycle.status === "refused") return planResult(lifecycle, []);

  const intent: StateTarget = {
    path: CAPABILITY_PACKAGE_INTENT_PATH,
    desired: desiredIntent(snapshot.lifecycleInput, lifecycle),
    mode: INTENT_MODE,
    live: liveIntent,
  };
  const receipt: StateTarget = {
    path: CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH,
    desired: desiredReceipt(lifecycle),
    mode: RECEIPT_MODE,
    live: liveReceipt,
  };
  if (targetMatches(intent) && targetMatches(receipt)) return planResult(lifecycle, []);
  const targets =
    intent.desired === undefined && receipt.desired === undefined
      ? [receipt, intent]
      : [intent, receipt];
  return planResult(lifecycle, targets.map(stepFor));
}
