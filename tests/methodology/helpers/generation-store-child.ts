import { existsSync, lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import * as generationStoreModule from "../../../src/methodology/generation-store.js";
import {
  type ActivationRecord,
  ActivationRecordSchema,
  type ApplyProjectionResult,
  type CleanProjectionResult,
  type RecoveryProjectionResult,
} from "../../../src/methodology/generation-store-contract.js";
import {
  createOrOpenOwnedStore,
  openStoreForInspection,
  readStoreRecord,
} from "../../../src/methodology/generation-store-fs.js";
import {
  acquireStoreLock,
  type LockRuntime,
  releaseStoreLock,
} from "../../../src/methodology/generation-store-lock.js";
import { binaryPayloadFixture, binaryPlannedFixture } from "../generation-store-fixtures.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_HOLD_MILLISECONDS = 30_000;
const TRANSACTION_ID = "e".repeat(64);
const LOCK_TOKEN = "c".repeat(64);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const APPLY_FAULT_POINTS = [
  "after-journal-prepared",
  "after-stage-created",
  "after-stage-verified",
  "after-generation-reserved",
  "after-generation-content",
  "after-receipt-written",
  "before-activation-rename",
  "after-activation-rename",
  "after-journal-committed",
] as const;
const CLEAN_FAULT_POINTS = [
  "after-clean-journal-prepared",
  "before-clean-quarantine",
  "after-clean-quarantine",
  "during-clean-delete",
  "after-clean-delete",
] as const;

type ApplyFaultPoint = (typeof APPLY_FAULT_POINTS)[number];
type ApplyRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type CleanFaultPoint = (typeof CLEAN_FAULT_POINTS)[number];
type CleanRuntime = Readonly<{
  onFaultPoint: (point: CleanFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
type ChildRequest =
  | Readonly<{
      action: "apply";
      projectRoot: string;
      expectedActiveDigest: string | null;
    }>
  | Readonly<{ action: "recover" | "read-activation"; projectRoot: string }>
  | Readonly<{ action: "hold-lock"; projectRoot: string; holdMilliseconds: number }>
  | Readonly<{
      action: "crash-at";
      projectRoot: string;
      expectedActiveDigest: string | null;
      faultPoint: ApplyFaultPoint;
    }>
  | Readonly<{
      action: "clean-crash-at";
      projectRoot: string;
      generationDigest: string;
      faultPoint: CleanFaultPoint;
    }>;

type ApplyProjectionFunction = (value: unknown) => ApplyProjectionResult;
type ApplyProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: ApplyRuntime,
) => ApplyProjectionResult;
type CleanProjectionWithRuntimeFunction = (
  value: unknown,
  runtime: CleanRuntime,
) => CleanProjectionResult;
type RecoverProjectionFunction = (value: unknown) => RecoveryProjectionResult;

function fail(message: string): never {
  throw new Error(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireClosedKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    fail("child request fields are not closed");
  }
}

function requireProjectRoot(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    fail("child project root must be absolute");
  }
  let canonicalProject: string;
  let canonicalTemporaryRoot: string;
  try {
    canonicalProject = realpathSync(value);
    canonicalTemporaryRoot = realpathSync(tmpdir());
  } catch {
    fail("child project root is inaccessible");
  }
  const fromTemporaryRoot = relative(canonicalTemporaryRoot, canonicalProject);
  if (
    fromTemporaryRoot === "" ||
    fromTemporaryRoot === ".." ||
    fromTemporaryRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromTemporaryRoot)
  ) {
    fail("child project root must remain below the OS temporary directory");
  }
  return canonicalProject;
}

function optionalDigest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("child expected activation digest is invalid");
  }
  return value;
}

function parseRequest(value: unknown): ChildRequest {
  if (!isPlainRecord(value) || typeof value.action !== "string") {
    fail("child request must be a closed record");
  }
  const projectRoot = requireProjectRoot(value.projectRoot);
  switch (value.action) {
    case "apply":
      requireClosedKeys(value, ["action", "projectRoot", "expectedActiveDigest"]);
      return Object.freeze({
        action: value.action,
        projectRoot,
        expectedActiveDigest: optionalDigest(value.expectedActiveDigest),
      });
    case "recover":
    case "read-activation":
      requireClosedKeys(value, ["action", "projectRoot"]);
      return Object.freeze({ action: value.action, projectRoot });
    case "hold-lock": {
      requireClosedKeys(value, ["action", "projectRoot", "holdMilliseconds"]);
      const holdMilliseconds = value.holdMilliseconds;
      if (
        typeof holdMilliseconds !== "number" ||
        !Number.isInteger(holdMilliseconds) ||
        holdMilliseconds < 0 ||
        holdMilliseconds > MAX_HOLD_MILLISECONDS
      ) {
        fail("child lock hold duration is invalid");
      }
      return Object.freeze({ action: value.action, projectRoot, holdMilliseconds });
    }
    case "crash-at": {
      requireClosedKeys(value, ["action", "projectRoot", "expectedActiveDigest", "faultPoint"]);
      if (
        typeof value.faultPoint !== "string" ||
        !APPLY_FAULT_POINTS.includes(value.faultPoint as ApplyFaultPoint)
      ) {
        fail("child fault point is invalid");
      }
      return Object.freeze({
        action: value.action,
        projectRoot,
        expectedActiveDigest: optionalDigest(value.expectedActiveDigest),
        faultPoint: value.faultPoint as ApplyFaultPoint,
      });
    }
    case "clean-crash-at": {
      requireClosedKeys(value, ["action", "projectRoot", "generationDigest", "faultPoint"]);
      if (
        typeof value.generationDigest !== "string" ||
        !DIGEST_PATTERN.test(value.generationDigest)
      ) {
        fail("child generation digest is invalid");
      }
      if (
        typeof value.faultPoint !== "string" ||
        !CLEAN_FAULT_POINTS.includes(value.faultPoint as CleanFaultPoint)
      ) {
        fail("child clean fault point is invalid");
      }
      return Object.freeze({
        action: value.action,
        projectRoot,
        generationDigest: value.generationDigest,
        faultPoint: value.faultPoint as CleanFaultPoint,
      });
    }
    default:
      fail("child action is invalid");
  }
}

function readRequest(requestPathValue: string | undefined): ChildRequest {
  if (requestPathValue === undefined || !isAbsolute(requestPathValue)) {
    fail("child request path must be absolute");
  }
  const requestPath = resolve(requestPathValue);
  let stats: ReturnType<typeof lstatSync>;
  let canonicalRequest: string;
  try {
    stats = lstatSync(requestPath);
    canonicalRequest = realpathSync(requestPath);
  } catch {
    fail("child request file is inaccessible");
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size > MAX_REQUEST_BYTES
  ) {
    fail("child request file is not a bounded single-link regular file");
  }
  const temporaryRoot = realpathSync(tmpdir());
  const fromTemporaryRoot = relative(temporaryRoot, canonicalRequest);
  if (
    fromTemporaryRoot === "" ||
    fromTemporaryRoot === ".." ||
    fromTemporaryRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromTemporaryRoot)
  ) {
    fail("child request file must remain below the OS temporary directory");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(canonicalRequest, "utf8"));
  } catch {
    fail("child request JSON is malformed");
  }
  return parseRequest(decoded);
}

function applyInput(projectRoot: string, expectedActiveDigest: string | null) {
  return {
    mode: "apply" as const,
    projectRoot,
    plan: binaryPlannedFixture(),
    payloads: binaryPayloadFixture(),
    expectedActiveDigest,
  };
}

function requireApplyProjection(): ApplyProjectionFunction {
  const implementation = (
    generationStoreModule as unknown as { applyProjection?: ApplyProjectionFunction }
  ).applyProjection;
  return implementation ?? fail("applyProjection is not implemented");
}

function requireApplyProjectionWithRuntime(): ApplyProjectionWithRuntimeFunction {
  const implementation = (
    generationStoreModule as unknown as {
      applyProjectionWithRuntime?: ApplyProjectionWithRuntimeFunction;
    }
  ).applyProjectionWithRuntime;
  return implementation ?? fail("applyProjectionWithRuntime is not implemented");
}

function requireCleanProjectionWithRuntime(): CleanProjectionWithRuntimeFunction {
  const implementation = (
    generationStoreModule as unknown as {
      cleanProjectionGenerationWithRuntime?: CleanProjectionWithRuntimeFunction;
    }
  ).cleanProjectionGenerationWithRuntime;
  return implementation ?? fail("cleanProjectionGenerationWithRuntime is not implemented");
}

function requireRecoverProjectionStore(): RecoverProjectionFunction {
  const implementation = (
    generationStoreModule as unknown as {
      recoverProjectionStore?: RecoverProjectionFunction;
    }
  ).recoverProjectionStore;
  return implementation ?? fail("recoverProjectionStore is not implemented");
}

function writeJson(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

async function run(request: ChildRequest): Promise<void> {
  switch (request.action) {
    case "apply":
      writeJson(
        requireApplyProjection()(applyInput(request.projectRoot, request.expectedActiveDigest)),
      );
      return;
    case "recover":
      writeJson(requireRecoverProjectionStore()({ projectRoot: request.projectRoot }));
      return;
    case "read-activation": {
      const store = openStoreForInspection(request.projectRoot);
      if (store === undefined || !existsSync(store.layout.active)) {
        writeJson(null);
        return;
      }
      const activation = readStoreRecord<ActivationRecord>(
        store,
        store.layout.active,
        ActivationRecordSchema,
        "activation",
      ).record;
      writeJson(activation);
      return;
    }
    case "hold-lock": {
      const store = createOrOpenOwnedStore(request.projectRoot);
      const held = acquireStoreLock(store, TRANSACTION_ID);
      writeSync(1, "READY:hold-lock\n");
      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          process.stdin.pause();
          resolvePromise();
        };
        const timeout = setTimeout(settle, request.holdMilliseconds);
        process.stdin.once("data", settle);
        process.stdin.once("end", settle);
        process.stdin.resume();
      });
      releaseStoreLock(store, held);
      return;
    }
    case "crash-at": {
      const runtime: ApplyRuntime = Object.freeze({
        onFaultPoint(point: ApplyFaultPoint): void {
          if (point !== request.faultPoint) return;
          writeSync(1, `READY:${point}\n`);
          process.exit(86);
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      });
      requireApplyProjectionWithRuntime()(
        applyInput(request.projectRoot, request.expectedActiveDigest),
        runtime,
      );
      return fail("requested apply fault point was not reached");
    }
    case "clean-crash-at": {
      const runtime: CleanRuntime = Object.freeze({
        onFaultPoint(point: CleanFaultPoint): void {
          if (point !== request.faultPoint) return;
          writeSync(1, `READY:${point}\n`);
          process.exit(87);
        },
        lockRuntime: Object.freeze({
          pid: process.pid,
          randomToken: () => LOCK_TOKEN,
          pidState: (pid: number) => (pid === process.pid ? "alive" : "absent"),
        }),
      });
      requireCleanProjectionWithRuntime()(
        {
          projectRoot: request.projectRoot,
          generationDigest: request.generationDigest,
        },
        runtime,
      );
      fail("requested clean fault point was not reached");
    }
  }
}

async function main(): Promise<void> {
  const request = readRequest(process.argv[2]);
  await run(request);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown child failure";
  writeSync(2, `${message.slice(0, 512)}\n`);
  process.exitCode = 2;
});
