import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  Dir,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { isProxy } from "node:util/types";
import { planSyntheticProjection } from "./projection-planner.js";

const SCHEMA_VERSION = 1 as const;
const CAPABILITY_PREFIX = "aih-methodology-transaction-";
const MAX_SNAPSHOT_DEPTH = 16;
const MAX_SNAPSHOT_NODES = 16_384;
const MAX_PAYLOADS = 64;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_DIRECTORY_ENTRIES = 256;
const TRANSACTION_VERSION = "phase-4-transaction-v1" as const;
const LOCK = ".aih-methodology.lock";
const PROJECTION = ".aih-methodology-projection";
const RECEIPT = ".aih-methodology-receipt.json";
const RECOVERY = ".aih-methodology-recovery.json";
const FILE_TYPE_MASK = 0o170000n;
const FILE_TYPE_REGULAR = 0o100000n;
const FILE_TYPE_DIRECTORY = 0o040000n;
const FILE_TYPE_SYMBOLIC_LINK = 0o120000n;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SPLICE = Array.prototype.splice;
const BIGINT_FUNCTION = BigInt;
const NUMBER_FUNCTION = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const WEAK_MAP_DELETE = WeakMap.prototype.delete;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const INTRINSIC_APPLY = Reflect.apply;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_FROM = Buffer.from;
const BUFFER_EQUALS = Buffer.prototype.equals;
const HASH_PROTOTYPE = Object.getPrototypeOf(createHash("sha256")) as {
  digest: CallableFunction;
  update: CallableFunction;
};
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HMAC_PROTOTYPE = Object.getPrototypeOf(createHmac("sha256", Buffer.alloc(1))) as {
  digest: CallableFunction;
  update: CallableFunction;
};
const HMAC_DIGEST = HMAC_PROTOTYPE.digest;
const HMAC_UPDATE = HMAC_PROTOTYPE.update;
const JSON_STRINGIFY = JSON.stringify;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_ENDS_WITH = String.prototype.endsWith;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const DIR_READ_SYNC = Dir.prototype.readSync;
const DIR_CLOSE_SYNC = Dir.prototype.closeSync;

type TrustedDescriptor = Readonly<{
  target: object;
  key: PropertyKey;
  descriptor: PropertyDescriptor | undefined;
}>;

function trustedDescriptor(target: object, key: PropertyKey): TrustedDescriptor {
  return OBJECT_FREEZE({
    target,
    key,
    descriptor: OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key),
  });
}

const TRUSTED_DESCRIPTORS: readonly TrustedDescriptor[] = OBJECT_FREEZE([
  trustedDescriptor(Array.prototype, "push"),
  trustedDescriptor(Array.prototype, "splice"),
  trustedDescriptor(String.prototype, "split"),
  trustedDescriptor(String.prototype, "startsWith"),
  trustedDescriptor(String.prototype, "endsWith"),
  trustedDescriptor(RegExp.prototype, "test"),
  trustedDescriptor(Object.prototype, "then"),
]);

function callIntrinsic<T>(
  intrinsic: CallableFunction,
  receiver: unknown,
  argumentsList: readonly unknown[],
): T {
  return INTRINSIC_APPLY(intrinsic, receiver, argumentsList) as T;
}

function descriptorMatches(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.get === right.get &&
    left.set === right.set &&
    left.value === right.value &&
    left.writable === right.writable
  );
}

function ambientIntrinsicsAreClean(): boolean {
  for (let index = 0; index < TRUSTED_DESCRIPTORS.length; index += 1) {
    const trusted = TRUSTED_DESCRIPTORS[index];
    if (
      trusted === undefined ||
      !descriptorMatches(
        OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(trusted.target, trusted.key),
        trusted.descriptor,
      )
    ) {
      return false;
    }
  }
  return true;
}

function appendOwn<T>(values: T[], value: T): void {
  OBJECT_DEFINE_PROPERTY(values, String(values.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function arrayRemoveAt<T>(values: T[], index: number): void {
  callIntrinsic<T[]>(ARRAY_SPLICE, values, [index, 1]);
}

function bigint(value: number): bigint {
  return callIntrinsic<bigint>(BIGINT_FUNCTION, undefined, [value]);
}

function numberIsFinite(value: number): boolean {
  return NUMBER_IS_FINITE(value);
}

function numberIsSafeInteger(value: number): boolean {
  return NUMBER_IS_SAFE_INTEGER(value);
}

function number(value: bigint): number {
  return callIntrinsic<number>(NUMBER_FUNCTION, undefined, [value]);
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return callIntrinsic<boolean>(REGEXP_TEST, pattern, [value]);
}

function stringSplit(value: string, separator: string): string[] {
  return callIntrinsic<string[]>(STRING_SPLIT, value, [separator]);
}

function stringEndsWith(value: string, suffix: string): boolean {
  return callIntrinsic<boolean>(STRING_ENDS_WITH, value, [suffix]);
}

function stringStartsWith(value: string, prefix: string): boolean {
  return callIntrinsic<boolean>(STRING_STARTS_WITH, value, [prefix]);
}

function boundedDirectoryNames(path: string): string[] | undefined {
  let directory: Dir;
  try {
    directory = opendirSync(path);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  let complete = false;
  let failed = false;
  try {
    for (let index = 0; index <= MAX_DIRECTORY_ENTRIES; index += 1) {
      const entry = callIntrinsic<ReturnType<Dir["readSync"]>>(DIR_READ_SYNC, directory, []);
      if (entry === null) {
        complete = true;
        break;
      }
      if (index === MAX_DIRECTORY_ENTRIES || typeof entry.name !== "string") {
        failed = true;
        break;
      }
      appendOwn(names, entry.name);
    }
  } catch {
    failed = true;
  } finally {
    try {
      callIntrinsic<void>(DIR_CLOSE_SYNC, directory, []);
    } catch {
      failed = true;
    }
  }
  return complete && !failed ? names : undefined;
}

function statIsDirectory(stat: BigIntStats): boolean {
  return (stat.mode & FILE_TYPE_MASK) === FILE_TYPE_DIRECTORY;
}

function statIsRegularFile(stat: BigIntStats): boolean {
  return (stat.mode & FILE_TYPE_MASK) === FILE_TYPE_REGULAR;
}

function statIsSymbolicLink(stat: BigIntStats): boolean {
  return (stat.mode & FILE_TYPE_MASK) === FILE_TYPE_SYMBOLIC_LINK;
}

function weakMapDelete<K extends WeakKey>(map: WeakMap<K, unknown>, key: K): void {
  callIntrinsic<boolean>(WEAK_MAP_DELETE, map, [key]);
}

function weakMapGet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return callIntrinsic<V | undefined>(WEAK_MAP_GET, map, [key]);
}

function weakMapSet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K, value: V): void {
  callIntrinsic<WeakMap<K, V>>(WEAK_MAP_SET, map, [key, value]);
}

function weakSetAdd<T extends WeakKey>(set: WeakSet<T>, value: T): void {
  callIntrinsic<WeakSet<T>>(WEAK_SET_ADD, set, [value]);
}

function weakSetDelete<T extends WeakKey>(set: WeakSet<T>, value: T): void {
  callIntrinsic<boolean>(WEAK_SET_DELETE, set, [value]);
}

function weakSetHas<T extends WeakKey>(set: WeakSet<T>, value: T): boolean {
  return callIntrinsic<boolean>(WEAK_SET_HAS, set, [value]);
}

type ClosedSchemaSuccess<T> = Readonly<{ success: true; data: T }>;
type ClosedSchemaFailure = Readonly<{ success: false; error: TransactionSchemaError }>;

export interface ClosedTransactionSchema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): ClosedSchemaSuccess<T> | ClosedSchemaFailure;
}

export class TransactionSchemaError extends Error {
  readonly issues = OBJECT_FREEZE([
    OBJECT_FREEZE({ code: "custom", message: "invalid closed transaction value", path: [] }),
  ]);

  constructor() {
    super("invalid closed transaction value");
    this.name = "TransactionSchemaError";
  }
}

const SCHEMA_FAILURE = OBJECT_FREEZE({
  success: false as const,
  error: OBJECT_FREEZE(new TransactionSchemaError()),
});

function schemaSuccess<T>(data: T): ClosedSchemaSuccess<T> {
  return OBJECT_FREEZE({ success: true as const, data });
}

function closedSchema<T>(parser: (value: unknown) => T | undefined): ClosedTransactionSchema<T> {
  const safeParse = (value: unknown): ClosedSchemaSuccess<T> | ClosedSchemaFailure => {
    const parsed = parser(value);
    return parsed === undefined ? SCHEMA_FAILURE : schemaSuccess(parsed);
  };
  const parse = (value: unknown): T => {
    const result = safeParse(value);
    if (!result.success) throw result.error;
    return result.data;
  };
  return OBJECT_FREEZE({ parse, safeParse });
}

function isAllowedRecordPrototype(value: object): boolean {
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  return prototype === null || prototype === Object.prototype;
}

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
    ? descriptor
    : undefined;
}

function allowedKey(key: PropertyKey, allowed: readonly string[]): key is string {
  if (typeof key !== "string") return false;
  for (let index = 0; index < allowed.length; index += 1) {
    if (allowed[index] === key) return true;
  }
  return false;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    isProxy(value) ||
    !isAllowedRecordPrototype(value)
  ) {
    return false;
  }
  const ownKeys = REFLECT_OWN_KEYS(value);
  if (ownKeys.length !== keys.length) return false;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (
      key === undefined ||
      !allowedKey(key, keys) ||
      ownDataDescriptor(value, key) === undefined
    ) {
      return false;
    }
  }
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || ownDataDescriptor(value, key) === undefined) return false;
  }
  return true;
}

type SnapshotState = { depth: number; nodes: { value: number }; active: WeakSet<object> };
type SnapshotResult = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>;
const SNAPSHOT_FAILURE = OBJECT_FREEZE({ ok: false as const });

function defineOwn(target: object, key: PropertyKey, value: unknown): void {
  OBJECT_DEFINE_PROPERTY(target, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function snapshotValue(value: unknown, state: SnapshotState): SnapshotResult {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && numberIsFinite(value))
  ) {
    return OBJECT_FREEZE({ ok: true as const, value });
  }
  if (
    typeof value !== "object" ||
    isProxy(value) ||
    state.depth >= MAX_SNAPSHOT_DEPTH ||
    state.nodes.value >= MAX_SNAPSHOT_NODES ||
    weakSetHas(state.active, value)
  ) {
    return SNAPSHOT_FAILURE;
  }
  state.nodes.value += 1;
  weakSetAdd(state.active, value);
  try {
    if (ARRAY_IS_ARRAY(value)) {
      if (OBJECT_GET_PROTOTYPE_OF(value) !== Array.prototype || value.length > MAX_PAYLOADS * 16) {
        return SNAPSHOT_FAILURE;
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = ownDataDescriptor(value, String(index));
        if (descriptor === undefined) return SNAPSHOT_FAILURE;
        const child = snapshotValue(descriptor.value, {
          active: state.active,
          depth: state.depth + 1,
          nodes: state.nodes,
        });
        if (!child.ok) return SNAPSHOT_FAILURE;
        state.nodes.value += 1;
        defineOwn(copy, String(index), child.value);
      }
      OBJECT_DEFINE_PROPERTY(copy, "length", { value: value.length, writable: false });
      return OBJECT_FREEZE({ ok: true as const, value: OBJECT_FREEZE(copy) });
    }
    if (!isAllowedRecordPrototype(value)) return SNAPSHOT_FAILURE;
    const keys = REFLECT_OWN_KEYS(value);
    const copy = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") return SNAPSHOT_FAILURE;
      const descriptor = ownDataDescriptor(value, key);
      if (descriptor === undefined) return SNAPSHOT_FAILURE;
      const child = snapshotValue(descriptor.value, {
        active: state.active,
        depth: state.depth + 1,
        nodes: state.nodes,
      });
      if (!child.ok) return SNAPSHOT_FAILURE;
      state.nodes.value += 1;
      defineOwn(copy, key, child.value);
    }
    return OBJECT_FREEZE({ ok: true as const, value: OBJECT_FREEZE(copy) });
  } finally {
    weakSetDelete(state.active, value);
  }
}

function snapshot(value: unknown): SnapshotResult {
  return snapshotValue(value, { active: new WeakSet<object>(), depth: 0, nodes: { value: 0 } });
}

type RootIdentity = Readonly<{
  device: bigint;
  file: bigint;
  mode: bigint;
  user: bigint;
  group: bigint;
}>;

type CapabilityMetadata = {
  readonly root: string;
  readonly tempRoot: string;
  readonly descriptor: number | undefined;
  readonly identity: RootIdentity;
  readonly authorityKey: Buffer;
};

export interface SyntheticTransactionCapability {
  readonly root: string;
  readonly dispose: () => void;
}

const CAPABILITIES = new WeakSet<object>();
const CAPABILITY_METADATA = new WeakMap<object, CapabilityMetadata>();

function statIdentity(path: string): RootIdentity | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!statIsDirectory(stat)) return undefined;
    return {
      device: stat.dev,
      file: stat.ino,
      mode: stat.mode,
      user: stat.uid,
      group: stat.gid,
    };
  } catch {
    return undefined;
  }
}

function openRoot(path: string): number | undefined {
  try {
    const directory = "O_DIRECTORY" in fsConstants ? fsConstants.O_DIRECTORY : 0;
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    return openSync(path, fsConstants.O_RDONLY | directory | noFollow);
  } catch {
    return undefined;
  }
}

function containedBy(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child.length > 0 &&
    child !== ".." &&
    !stringStartsWith(child, `..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

export function createSyntheticTransactionCapability(): SyntheticTransactionCapability {
  const tempRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempRoot, CAPABILITY_PREFIX));
  const identity = statIdentity(root);
  const descriptor = openRoot(root);
  if (
    identity === undefined ||
    !containedBy(tempRoot, root) ||
    (process.platform !== "win32" && (identity.mode & 0o777n) !== 0o700n)
  ) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new Error("failed to mint a private disposable transaction capability");
  }
  let capability: SyntheticTransactionCapability;
  const dispose = () => {
    if (!weakSetHas(CAPABILITIES, capability as object)) return;
    const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
    weakSetDelete(CAPABILITIES, capability as object);
    weakMapDelete(CAPABILITY_METADATA, capability as object);
    if (metadata?.descriptor !== undefined) {
      try {
        closeSync(metadata.descriptor);
      } catch {
        // Revocation is complete before descriptor close; never fall back to pathname cleanup.
      }
    }
  };
  capability = OBJECT_FREEZE({ root, dispose });
  weakSetAdd(CAPABILITIES, capability as object);
  weakMapSet(CAPABILITY_METADATA, capability as object, {
    authorityKey: randomBytes(32),
    descriptor,
    identity,
    root,
    tempRoot,
  });
  return capability;
}

type ApplySyntheticTransactionRequest = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION;
  capability: SyntheticTransactionCapability;
  plannerInput: unknown;
  payloads: readonly unknown[];
}>;

function parseApplyRequest(value: unknown): ApplySyntheticTransactionRequest | undefined {
  if (!exactRecord(value, ["schemaVersion", "capability", "plannerInput", "payloads"])) {
    return undefined;
  }
  const version = ownDataDescriptor(value, "schemaVersion")?.value;
  const capability = ownDataDescriptor(value, "capability")?.value;
  const plannerInput = ownDataDescriptor(value, "plannerInput")?.value;
  const payloads = ownDataDescriptor(value, "payloads")?.value;
  if (
    version !== SCHEMA_VERSION ||
    capability === null ||
    typeof capability !== "object" ||
    isProxy(capability) ||
    !weakSetHas(CAPABILITIES, capability) ||
    weakMapGet(CAPABILITY_METADATA, capability) === undefined ||
    !ARRAY_IS_ARRAY(payloads) ||
    payloads.length > MAX_PAYLOADS
  ) {
    return undefined;
  }
  const plannerSnapshot = snapshot(plannerInput);
  const payloadSnapshot = snapshot(payloads);
  if (!plannerSnapshot.ok || !payloadSnapshot.ok || !ARRAY_IS_ARRAY(payloadSnapshot.value)) {
    return undefined;
  }
  return OBJECT_FREEZE({
    schemaVersion: SCHEMA_VERSION,
    capability: capability as SyntheticTransactionCapability,
    plannerInput: plannerSnapshot.value,
    payloads: payloadSnapshot.value,
  });
}

export const ApplySyntheticTransactionRequestSchema = closedSchema(parseApplyRequest);

type Payload = Readonly<{
  artifactId: string;
  target: string;
  content: string;
  bytes: Buffer;
  contentDigest: string;
}>;

export type SyntheticTransactionReceipt = Readonly<{
  schemaVersion: 1;
  transactionVersion: typeof TRANSACTION_VERSION;
  manifestDigest: string;
  owner: string;
  entries: readonly Readonly<{
    artifactId: string;
    target: string;
    contentDigest: string;
    bytes: number;
  }>[];
  claims: Readonly<{
    installed: false;
    active: false;
    isolated: false;
    switchable: false;
    concurrent: false;
    conflictFree: false;
    secureErasure: false;
  }>;
  boundary: TransactionBoundary;
  authTag: string;
}>;

type TransactionBoundary = Readonly<{
  temporaryRootOnly: true;
  cli: false;
  executor: false;
  providerExecution: false;
  hostExecution: false;
  network: false;
  nativeComponent: false;
}>;

type TransactionFindingCode =
  | "METHODOLOGY_TRANSACTION_INVALID"
  | "METHODOLOGY_TRANSACTION_ROOT_UNTRUSTED"
  | "METHODOLOGY_TRANSACTION_ROOT_NOT_EMPTY"
  | "METHODOLOGY_TRANSACTION_PAYLOAD_MISMATCH"
  | "METHODOLOGY_TRANSACTION_IO_FAILED"
  | "METHODOLOGY_TRANSACTION_RECEIPT_MISMATCH"
  | "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED";

const TRANSACTION_FINDING_CODES: readonly TransactionFindingCode[] = OBJECT_FREEZE([
  "METHODOLOGY_TRANSACTION_INVALID",
  "METHODOLOGY_TRANSACTION_ROOT_UNTRUSTED",
  "METHODOLOGY_TRANSACTION_ROOT_NOT_EMPTY",
  "METHODOLOGY_TRANSACTION_PAYLOAD_MISMATCH",
  "METHODOLOGY_TRANSACTION_IO_FAILED",
  "METHODOLOGY_TRANSACTION_RECEIPT_MISMATCH",
  "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED",
]);

function validFindingCode(value: string): value is TransactionFindingCode {
  for (let index = 0; index < TRANSACTION_FINDING_CODES.length; index += 1) {
    if (TRANSACTION_FINDING_CODES[index] === value) return true;
  }
  return false;
}

type TransactionFailure = Readonly<{
  schemaVersion: 1;
  state: "blocked" | "recovery-required";
  boundary: TransactionBoundary;
  findings: readonly Readonly<{ code: TransactionFindingCode }>[];
}>;

type AppliedTransactionResult = Readonly<{
  schemaVersion: 1;
  state: "applied";
  receipt: SyntheticTransactionReceipt;
  boundary: TransactionBoundary;
  findings: readonly [];
}>;

type CleanedTransactionResult = Readonly<{
  schemaVersion: 1;
  state: "cleaned";
  manifestDigest: string;
  receiptDigest: string;
  boundary: TransactionBoundary;
  findings: readonly [];
}>;

export type SyntheticTransactionResult =
  | AppliedTransactionResult
  | CleanedTransactionResult
  | TransactionFailure;

export type ApplyFaultPoint =
  | "after-root-validation"
  | "after-lock"
  | "after-projection-create"
  | "after-entry-write"
  | "after-metadata-validation"
  | "before-commit"
  | "after-commit"
  | "during-rollback"
  | "during-recovery";

const APPLY_FAULT_POINTS: readonly ApplyFaultPoint[] = OBJECT_FREEZE([
  "after-root-validation",
  "after-lock",
  "after-projection-create",
  "after-entry-write",
  "after-metadata-validation",
  "before-commit",
  "after-commit",
  "during-rollback",
  "during-recovery",
]);

export type CleanFaultPoint =
  | "after-root-validation"
  | "after-lock"
  | "after-recovery-record"
  | "after-receipt-revoke"
  | "during-entry-remove"
  | "during-directory-remove"
  | "before-recovery-remove"
  | "during-recovery";

const CLEAN_FAULT_POINTS: readonly CleanFaultPoint[] = OBJECT_FREEZE([
  "after-root-validation",
  "after-lock",
  "after-recovery-record",
  "after-receipt-revoke",
  "during-entry-remove",
  "during-directory-remove",
  "before-recovery-remove",
  "during-recovery",
]);

class InjectedTransactionFault extends Error {}

const BOUNDARY: TransactionBoundary = OBJECT_FREEZE({
  temporaryRootOnly: true,
  cli: false,
  executor: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  nativeComponent: false,
});

const CLAIMS = OBJECT_FREEZE({
  installed: false,
  active: false,
  isolated: false,
  switchable: false,
  concurrent: false,
  conflictFree: false,
  secureErasure: false,
});

const EMPTY_FINDINGS = OBJECT_FREEZE([]) as readonly [];

function closedRecord<T extends object>(entries: readonly (readonly [PropertyKey, unknown])[]): T {
  const record = callIntrinsic<object>(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined) defineOwn(record, entry[0], entry[1]);
  }
  return OBJECT_FREEZE(record) as T;
}

function finding(code: TransactionFindingCode): Readonly<{ code: TransactionFindingCode }> {
  return closedRecord([["code", code]]);
}

function failure(
  state: TransactionFailure["state"],
  code: TransactionFindingCode,
): TransactionFailure {
  return closedRecord([
    ["schemaVersion", SCHEMA_VERSION],
    ["state", state],
    ["boundary", BOUNDARY],
    ["findings", OBJECT_FREEZE([finding(code)])],
  ]);
}

type FaultOptionResult<T extends string> =
  | Readonly<{ ok: true; faultAt: T | undefined }>
  | Readonly<{ ok: false }>;

function snapshotFaultOption<T extends string>(
  value: unknown,
  allowed: readonly T[],
): FaultOptionResult<T> {
  if (value === undefined) return OBJECT_FREEZE({ ok: true as const, faultAt: undefined });
  if (!exactRecord(value, ["faultAt"])) return OBJECT_FREEZE({ ok: false as const });
  const faultAt = ownDataDescriptor(value, "faultAt")?.value;
  if (typeof faultAt !== "string") return OBJECT_FREEZE({ ok: false as const });
  for (let index = 0; index < allowed.length; index += 1) {
    if (allowed[index] === faultAt) {
      return OBJECT_FREEZE({ ok: true as const, faultAt: faultAt as T });
    }
  }
  return OBJECT_FREEZE({ ok: false as const });
}

function maybeFault(actual: string | undefined, expected: string): void {
  if (actual === expected) throw new InjectedTransactionFault(expected);
}

function bufferFrom(value: string): Buffer {
  return callIntrinsic<Buffer>(BUFFER_FROM, Buffer, [value, "utf8"]);
}

function byteLength(value: string): number {
  return callIntrinsic<number>(BUFFER_BYTE_LENGTH, Buffer, [value, "utf8"]);
}

function hashBytes(value: Buffer): string {
  const hash = createHash("sha256");
  callIntrinsic<ReturnType<typeof createHash>>(HASH_UPDATE, hash, [value]);
  return callIntrinsic<string>(HASH_DIGEST, hash, ["hex"]);
}

function hmacHex(key: Buffer, value: string): string {
  const hmac = createHmac("sha256", key);
  callIntrinsic<ReturnType<typeof createHmac>>(HMAC_UPDATE, hmac, [value]);
  return callIntrinsic<string>(HMAC_DIGEST, hmac, ["hex"]);
}

function secureHexEqual(left: string, right: string): boolean {
  if (!regexpTest(/^[0-9a-f]{64}$/, left) || !regexpTest(/^[0-9a-f]{64}$/, right)) return false;
  const leftBytes = callIntrinsic<Buffer>(BUFFER_FROM, Buffer, [left, "hex"]);
  const rightBytes = callIntrinsic<Buffer>(BUFFER_FROM, Buffer, [right, "hex"]);
  return timingSafeEqual(leftBytes, rightBytes);
}

function quote(value: string): string {
  return callIntrinsic<string>(JSON_STRINGIFY, JSON, [value]);
}

function sameIdentity(left: RootIdentity, right: RootIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.device === right.device &&
    left.file === right.file &&
    left.mode === right.mode &&
    left.user === right.user &&
    left.group === right.group
  );
}

function descriptorIdentity(descriptor: number | undefined): RootIdentity | undefined {
  if (descriptor === undefined) return undefined;
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!statIsDirectory(stat)) return undefined;
    return {
      device: stat.dev,
      file: stat.ino,
      mode: stat.mode,
      user: stat.uid,
      group: stat.gid,
    };
  } catch {
    return undefined;
  }
}

function liveMetadata(capability: SyntheticTransactionCapability): CapabilityMetadata | undefined {
  if (
    capability === null ||
    typeof capability !== "object" ||
    isProxy(capability) ||
    !weakSetHas(CAPABILITIES, capability as object)
  ) {
    return undefined;
  }
  const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
  if (metadata === undefined) return undefined;
  const pathIdentity = statIdentity(metadata.root);
  if (
    !containedBy(metadata.tempRoot, metadata.root) ||
    !sameIdentity(metadata.identity, pathIdentity) ||
    (metadata.descriptor !== undefined &&
      !sameIdentity(metadata.identity, descriptorIdentity(metadata.descriptor))) ||
    (process.platform !== "win32" && (metadata.identity.mode & 0o777n) !== 0o700n)
  ) {
    return undefined;
  }
  return metadata;
}

function parsePayloads(
  values: readonly unknown[],
  entries: readonly Readonly<{
    artifactId: string;
    target: string;
    contentDigest: string;
  }>[],
): readonly Payload[] | undefined {
  if (values.length !== entries.length) return undefined;
  const payloads: Payload[] = [];
  let total = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (entry === undefined) return undefined;
    let matched: Payload | undefined;
    for (let payloadIndex = 0; payloadIndex < values.length; payloadIndex += 1) {
      const value = values[payloadIndex];
      if (!exactRecord(value, ["artifactId", "target", "content"])) return undefined;
      const artifactId = ownDataDescriptor(value, "artifactId")?.value;
      const target = ownDataDescriptor(value, "target")?.value;
      const content = ownDataDescriptor(value, "content")?.value;
      if (
        typeof artifactId !== "string" ||
        typeof target !== "string" ||
        typeof content !== "string"
      ) {
        return undefined;
      }
      if (artifactId === entry.artifactId && target === entry.target) {
        if (matched !== undefined) return undefined;
        const length = byteLength(content);
        if (length > MAX_PAYLOAD_BYTES) return undefined;
        const bytes = bufferFrom(content);
        const contentDigest = hashBytes(bytes);
        if (contentDigest !== entry.contentDigest) return undefined;
        matched = OBJECT_FREEZE({ artifactId, target, content, bytes, contentDigest });
      }
    }
    if (matched === undefined) return undefined;
    total += matched.bytes.length;
    if (total > MAX_TOTAL_BYTES) return undefined;
    appendOwn(payloads, matched);
  }
  return OBJECT_FREEZE(payloads);
}

function receiptPreimage(
  manifestDigest: string,
  owner: string,
  entries: SyntheticTransactionReceipt["entries"],
): string {
  let value = `phase-4-receipt-v1\n${manifestDigest}\n${owner}\n`;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry !== undefined) {
      value += `${entry.artifactId.length}:${entry.artifactId}${entry.target.length}:${entry.target}${entry.contentDigest}${entry.bytes}\n`;
    }
  }
  return value;
}

function buildReceipt(
  metadata: CapabilityMetadata,
  manifest: Readonly<{
    digest: string;
    owner: string;
    entries: readonly Readonly<{
      artifactId: string;
      target: string;
      contentDigest: string;
    }>[];
  }>,
  payloads: readonly Payload[],
): SyntheticTransactionReceipt {
  const entries: Array<SyntheticTransactionReceipt["entries"][number]> = [];
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const payload = payloads[index];
    if (entry === undefined || payload === undefined) throw new Error("invalid receipt binding");
    appendOwn(
      entries,
      closedRecord([
        ["artifactId", entry.artifactId],
        ["target", entry.target],
        ["contentDigest", entry.contentDigest],
        ["bytes", payload.bytes.length],
      ]),
    );
  }
  const frozenEntries = OBJECT_FREEZE(entries);
  return closedRecord([
    ["schemaVersion", SCHEMA_VERSION],
    ["transactionVersion", TRANSACTION_VERSION],
    ["manifestDigest", manifest.digest],
    ["owner", manifest.owner],
    ["entries", frozenEntries],
    ["claims", CLAIMS],
    ["boundary", BOUNDARY],
    [
      "authTag",
      hmacHex(
        metadata.authorityKey,
        receiptPreimage(manifest.digest, manifest.owner, frozenEntries),
      ),
    ],
  ]);
}

function receiptJson(receipt: SyntheticTransactionReceipt): string {
  let entries = "[";
  for (let index = 0; index < receipt.entries.length; index += 1) {
    const entry = receipt.entries[index];
    if (entry === undefined) throw new Error("invalid receipt entry");
    if (index > 0) entries += ",";
    entries += `{"artifactId":${quote(entry.artifactId)},"target":${quote(entry.target)},"contentDigest":${quote(entry.contentDigest)},"bytes":${entry.bytes}}`;
  }
  entries += "]";
  return `{"schemaVersion":1,"transactionVersion":${quote(receipt.transactionVersion)},"manifestDigest":${quote(receipt.manifestDigest)},"owner":${quote(receipt.owner)},"entries":${entries},"claims":{"installed":false,"active":false,"isolated":false,"switchable":false,"concurrent":false,"conflictFree":false,"secureErasure":false},"boundary":{"temporaryRootOnly":true,"cli":false,"executor":false,"providerExecution":false,"hostExecution":false,"network":false,"nativeComponent":false},"authTag":${quote(receipt.authTag)}}\n`;
}

type FileIdentity = Readonly<{
  device: bigint;
  file: bigint;
  mode: bigint;
  links: bigint;
  size: bigint;
}>;
function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    if ((stat.mode & FILE_TYPE_MASK) !== FILE_TYPE_REGULAR) return undefined;
    return {
      device: stat.dev,
      file: stat.ino,
      mode: stat.mode,
      links: stat.nlink,
      size: stat.size,
    };
  } catch {
    return undefined;
  }
}

function readOwnedFile(
  path: string,
  maximumBytes: number,
): Readonly<{ bytes: Buffer; identity: FileIdentity }> | undefined {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch {
    return undefined;
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      (before.mode & FILE_TYPE_MASK) !== FILE_TYPE_REGULAR ||
      before.nlink !== 1n ||
      before.size < 0n ||
      before.size > bigint(maximumBytes)
    ) {
      return undefined;
    }
    const size = number(before.size);
    if (!numberIsSafeInteger(size)) return undefined;
    const bytes = callIntrinsic<Buffer>(BUFFER_ALLOC, Buffer, [size]);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count <= 0) return undefined;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const identity: FileIdentity = {
      device: before.dev,
      file: before.ino,
      mode: before.mode,
      links: before.nlink,
      size: before.size,
    };
    const afterIdentity: FileIdentity = {
      device: after.dev,
      file: after.ino,
      mode: after.mode,
      links: after.nlink,
      size: after.size,
    };
    if (
      !sameFileIdentity(identity, afterIdentity) ||
      !sameFileIdentity(identity, fileIdentity(path))
    ) {
      return undefined;
    }
    return OBJECT_FREEZE({ bytes, identity });
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A failed close cannot authorize a read or mutation fallback.
    }
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.device === right.device &&
    left.file === right.file &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size
  );
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("transaction write made no progress");
    offset += written;
  }
}

function writeExclusive(path: string, bytes: Buffer): FileIdentity {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  let identity: FileIdentity;
  try {
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      (stat.mode & FILE_TYPE_MASK) !== FILE_TYPE_REGULAR ||
      stat.nlink !== 1n ||
      stat.size !== bigint(bytes.length)
    ) {
      throw new Error("written transaction file identity is invalid");
    }
    identity = {
      device: stat.dev,
      file: stat.ino,
      mode: stat.mode,
      links: stat.nlink,
      size: stat.size,
    };
  } finally {
    closeSync(descriptor);
  }
  if (!sameFileIdentity(identity, fileIdentity(path))) {
    throw new Error("written transaction file path identity drifted");
  }
  return identity;
}

function ensureParents(root: string, target: string): string {
  const parts = stringSplit(target, "/");
  if (parts.length === 0) throw new Error("invalid transaction target");
  let parent = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length === 0) throw new Error("invalid transaction target");
    const next = join(parent, part);
    if (!containedBy(root, next)) throw new Error("transaction target escaped projection");
    try {
      const stat = lstatSync(next, { bigint: true });
      if (!statIsDirectory(stat) || statIsSymbolicLink(stat))
        throw new Error("invalid target parent");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(next, { mode: 0o700 });
    }
    parent = next;
  }
  const leaf = parts[parts.length - 1];
  if (leaf === undefined || leaf.length === 0) throw new Error("invalid transaction target");
  return join(parent, leaf);
}

function validateWrittenFile(path: string, expected: Buffer, identity: FileIdentity): boolean {
  if (!sameFileIdentity(identity, fileIdentity(path)) || identity.links !== 1n) return false;
  const actual = readOwnedFile(path, expected.length);
  return (
    actual !== undefined &&
    sameFileIdentity(identity, actual.identity) &&
    actual.bytes.length === expected.length &&
    callIntrinsic<boolean>(BUFFER_EQUALS, actual.bytes, [expected])
  );
}

function validExistingProjection(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  payloads: readonly Payload[],
  allowControls = false,
): boolean {
  const projection = join(metadata.root, PROJECTION);
  try {
    const rootEntries = boundedDirectoryNames(metadata.root);
    if (rootEntries === undefined) return false;
    let sawProjection = false;
    for (let index = 0; index < rootEntries.length; index += 1) {
      const entry = rootEntries[index];
      if (entry === PROJECTION) {
        if (sawProjection) return false;
        sawProjection = true;
      } else if (!allowControls || (entry !== LOCK && entry !== RECOVERY)) {
        return false;
      }
    }
    if (!sawProjection) return false;
    const projectionStat = lstatSync(projection, { bigint: true });
    if (!statIsDirectory(projectionStat) || statIsSymbolicLink(projectionStat)) return false;
    for (let index = 0; index < receipt.entries.length; index += 1) {
      const entry = receipt.entries[index];
      const payload = payloads[index];
      if (entry === undefined || payload === undefined) return false;
      const path = join(projection, entry.target);
      const identity = fileIdentity(path);
      if (
        identity === undefined ||
        identity.links !== 1n ||
        !validateWrittenFile(path, payload.bytes, identity)
      ) {
        return false;
      }
    }
    return (
      exactRegularFile(join(projection, RECEIPT), bufferFrom(receiptJson(receipt))) &&
      liveMetadataFor(metadata)
    );
  } catch {
    return false;
  }
}

function liveMetadataFor(metadata: CapabilityMetadata): boolean {
  return (
    sameIdentity(metadata.identity, statIdentity(metadata.root)) &&
    (metadata.descriptor === undefined ||
      sameIdentity(metadata.identity, descriptorIdentity(metadata.descriptor)))
  );
}

function recoveryPreimage(
  receipt: SyntheticTransactionReceipt,
  phase: "rollback" | "committed",
): string {
  return `phase-4-recovery-v1\n${phase}\n${receipt.manifestDigest}\n${receipt.authTag}\n`;
}

function recoveryJson(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  phase: "rollback" | "committed",
): string {
  const authTag = hmacHex(metadata.authorityKey, recoveryPreimage(receipt, phase));
  return `{"schemaVersion":1,"recoveryVersion":"phase-4-recovery-v1","operation":"apply","phase":${quote(phase)},"manifestDigest":${quote(receipt.manifestDigest)},"receiptAuthTag":${quote(receipt.authTag)},"authTag":${quote(authTag)}}\n`;
}

function exactRegularFile(path: string, expected: Buffer): boolean {
  const actual = readOwnedFile(path, expected.length);
  return (
    actual !== undefined &&
    actual.bytes.length === expected.length &&
    callIntrinsic<boolean>(BUFFER_EQUALS, actual.bytes, [expected])
  );
}

function pathIn(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function expectedProjectionPaths(
  projection: string,
  payloads: readonly Payload[],
): Readonly<{ files: readonly string[]; directories: readonly string[] }> {
  const files: string[] = [join(projection, RECEIPT)];
  const directories: string[] = [projection];
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    if (payload === undefined) continue;
    const parts = stringSplit(payload.target, "/");
    let parent = projection;
    for (let partIndex = 0; partIndex < parts.length - 1; partIndex += 1) {
      const part = parts[partIndex];
      if (part === undefined) continue;
      parent = join(parent, part);
      if (!pathIn(directories, parent)) appendOwn(directories, parent);
    }
    appendOwn(files, join(projection, payload.target));
  }
  return OBJECT_FREEZE({ files: OBJECT_FREEZE(files), directories: OBJECT_FREEZE(directories) });
}

function expectedFileBytes(
  path: string,
  projection: string,
  receipt: SyntheticTransactionReceipt,
  payloads: readonly Payload[],
): Buffer | undefined {
  if (path === join(projection, RECEIPT)) return bufferFrom(receiptJson(receipt));
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    if (payload !== undefined && path === join(projection, payload.target)) return payload.bytes;
  }
  return undefined;
}

function scanProjection(
  projection: string,
  receipt: SyntheticTransactionReceipt,
  payloads: readonly Payload[],
): Readonly<{ files: readonly string[]; directories: readonly string[] }> | undefined {
  let projectionStat: BigIntStats;
  try {
    projectionStat = lstatSync(projection, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? OBJECT_FREEZE({ files: OBJECT_FREEZE([]), directories: OBJECT_FREEZE([]) })
      : undefined;
  }
  if (!statIsDirectory(projectionStat) || statIsSymbolicLink(projectionStat)) return undefined;
  const expected = expectedProjectionPaths(projection, payloads);
  const files: string[] = [];
  const directories: string[] = [projection];
  const queue: string[] = [projection];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const directory = queue[queueIndex];
    if (directory === undefined) return undefined;
    let children: string[];
    try {
      const bounded = boundedDirectoryNames(directory);
      if (bounded === undefined) return undefined;
      children = bounded;
    } catch {
      return undefined;
    }
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (child === undefined) return undefined;
      const path = join(directory, child);
      let stat: BigIntStats;
      try {
        stat = lstatSync(path, { bigint: true });
      } catch {
        return undefined;
      }
      if (statIsSymbolicLink(stat)) return undefined;
      if (statIsDirectory(stat)) {
        if (!pathIn(expected.directories, path)) return undefined;
        appendOwn(directories, path);
        appendOwn(queue, path);
      } else if (statIsRegularFile(stat)) {
        if (!pathIn(expected.files, path) || stat.nlink !== 1n) return undefined;
        const bytes = expectedFileBytes(path, projection, receipt, payloads);
        if (bytes === undefined || !exactRegularFile(path, bytes)) return undefined;
        appendOwn(files, path);
      } else {
        return undefined;
      }
    }
    if (files.length + directories.length > 256) return undefined;
  }
  return OBJECT_FREEZE({ files: OBJECT_FREEZE(files), directories: OBJECT_FREEZE(directories) });
}

function removeDeepestDirectories(directories: readonly string[]): boolean {
  const remaining: string[] = [];
  for (let index = 0; index < directories.length; index += 1) {
    const path = directories[index];
    if (path !== undefined) appendOwn(remaining, path);
  }
  try {
    while (remaining.length > 0) {
      let selected = 0;
      for (let index = 1; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        const current = remaining[selected];
        if (candidate !== undefined && current !== undefined && candidate.length > current.length) {
          selected = index;
        }
      }
      const path = remaining[selected];
      if (path === undefined) return false;
      const stat = lstatSync(path, { bigint: true });
      if (!statIsDirectory(stat) || statIsSymbolicLink(stat)) return false;
      rmdirSync(path);
      arrayRemoveAt(remaining, selected);
    }
    return true;
  } catch {
    return false;
  }
}

function unlinkExact(path: string, expected: Buffer): boolean {
  try {
    if (!exactRegularFile(path, expected)) return false;
    unlinkSync(path);
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch {
    return false;
  }
}

function recoverRollback(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  payloads: readonly Payload[],
): boolean {
  const projection = join(metadata.root, PROJECTION);
  const scanned = scanProjection(projection, receipt, payloads);
  if (scanned === undefined) return false;
  for (let index = 0; index < scanned.files.length; index += 1) {
    const path = scanned.files[index];
    if (path === undefined) return false;
    const bytes = expectedFileBytes(path, projection, receipt, payloads);
    if (bytes === undefined || !unlinkExact(path, bytes)) return false;
  }
  if (!removeDeepestDirectories(scanned.directories)) return false;
  const lockPath = join(metadata.root, LOCK);
  try {
    lstatSync(lockPath);
    if (!unlinkExact(lockPath, bufferFrom(`${TRANSACTION_VERSION}\n${receipt.authTag}\n`)))
      return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const recoveryPath = join(metadata.root, RECOVERY);
  try {
    lstatSync(recoveryPath);
    if (!unlinkExact(recoveryPath, bufferFrom(recoveryJson(metadata, receipt, "rollback"))))
      return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const remaining = boundedDirectoryNames(metadata.root);
  return liveMetadataFor(metadata) && remaining !== undefined && remaining.length === 0;
}

function recoverExistingApply(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  payloads: readonly Payload[],
  faultAt: ApplyFaultPoint | undefined,
): SyntheticTransactionResult | undefined {
  const rootEntries = boundedDirectoryNames(metadata.root);
  if (rootEntries === undefined) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  if (!pathIn(rootEntries, RECOVERY) && !pathIn(rootEntries, LOCK)) return undefined;
  maybeFault(faultAt, "during-recovery");
  const recoveryPath = join(metadata.root, RECOVERY);
  const rollback = recoveryJson(metadata, receipt, "rollback");
  const committed = recoveryJson(metadata, receipt, "committed");
  const committedBytes = bufferFrom(committed);
  const rollbackBytes = bufferFrom(rollback);
  const recoveryIsCommitted = exactRegularFile(recoveryPath, committedBytes);
  const recoveryIsRollback = exactRegularFile(recoveryPath, rollbackBytes);
  let recoveryExists = true;
  if (!recoveryIsCommitted && !recoveryIsRollback) {
    try {
      lstatSync(recoveryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") recoveryExists = false;
    }
  }
  if (recoveryIsCommitted && validExistingProjection(metadata, receipt, payloads, true)) {
    const lockPath = join(metadata.root, LOCK);
    if (!unlinkExact(lockPath, bufferFrom(`${TRANSACTION_VERSION}\n${receipt.authTag}\n`))) {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
    if (!unlinkExact(recoveryPath, committedBytes)) {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
    return validExistingProjection(metadata, receipt, payloads)
      ? closedRecord([
          ["schemaVersion", SCHEMA_VERSION],
          ["state", "applied"],
          ["receipt", receipt],
          ["boundary", BOUNDARY],
          ["findings", EMPTY_FINDINGS],
        ])
      : failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  if (recoveryExists && !recoveryIsRollback) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  if (!recoverRollback(metadata, receipt, payloads)) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  return undefined;
}

export function applySyntheticTransaction(
  value: unknown,
  options?: Readonly<{ faultAt?: ApplyFaultPoint }>,
): SyntheticTransactionResult {
  if (!ambientIntrinsicsAreClean()) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  }
  const optionSnapshot = snapshotFaultOption(options, APPLY_FAULT_POINTS);
  if (!optionSnapshot.ok) return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  const faultAt = optionSnapshot.faultAt;
  const parsed = ApplySyntheticTransactionRequestSchema.safeParse(value);
  if (!parsed.success) return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  const metadata = liveMetadata(parsed.data.capability);
  if (metadata === undefined) return failure("blocked", "METHODOLOGY_TRANSACTION_ROOT_UNTRUSTED");
  let plan: ReturnType<typeof planSyntheticProjection>;
  try {
    plan = planSyntheticProjection(parsed.data.plannerInput);
  } catch {
    return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  }
  if (plan.state !== "planned") return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  const payloads = parsePayloads(parsed.data.payloads, plan.manifest.entries);
  if (payloads === undefined) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_PAYLOAD_MISMATCH");
  }
  const receipt = buildReceipt(metadata, plan.manifest, payloads);
  try {
    maybeFault(faultAt, "after-root-validation");
  } catch {
    return failure("blocked", "METHODOLOGY_TRANSACTION_IO_FAILED");
  }
  const existing = boundedDirectoryNames(metadata.root);
  if (existing === undefined) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_ROOT_UNTRUSTED");
  }
  if (existing.length > 0) {
    let recovered: SyntheticTransactionResult | undefined;
    try {
      recovered = recoverExistingApply(metadata, receipt, payloads, faultAt);
    } catch {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
    if (recovered !== undefined) return recovered;
    const afterRecovery = boundedDirectoryNames(metadata.root);
    if (afterRecovery !== undefined && afterRecovery.length === 0) {
      // A prior authenticated rollback was completed; start the requested transaction below.
    } else if (validExistingProjection(metadata, receipt, payloads)) {
      return closedRecord([
        ["schemaVersion", SCHEMA_VERSION],
        ["state", "applied"],
        ["receipt", receipt],
        ["boundary", BOUNDARY],
        ["findings", EMPTY_FINDINGS],
      ]);
    } else {
      return failure("blocked", "METHODOLOGY_TRANSACTION_ROOT_NOT_EMPTY");
    }
  }
  const lockPath = join(metadata.root, LOCK);
  const projection = join(metadata.root, PROJECTION);
  let committed = false;
  try {
    writeExclusive(lockPath, bufferFrom(`${TRANSACTION_VERSION}\n${receipt.authTag}\n`));
    maybeFault(faultAt, "after-lock");
    if (!liveMetadataFor(metadata)) throw new Error("transaction root drifted");
    mkdirSync(projection, { mode: 0o700 });
    maybeFault(faultAt, "after-projection-create");
    const identities: FileIdentity[] = [];
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      if (payload === undefined) throw new Error("missing transaction payload");
      const path = ensureParents(projection, payload.target);
      const identity = writeExclusive(path, payload.bytes);
      appendOwn(identities, identity);
      if (index === 0) {
        maybeFault(faultAt, "after-entry-write");
        maybeFault(faultAt, "during-rollback");
      }
      if (!liveMetadataFor(metadata)) throw new Error("transaction root drifted");
    }
    for (let index = 0; index < payloads.length; index += 1) {
      const payload = payloads[index];
      const identity = identities[index];
      if (
        payload === undefined ||
        identity === undefined ||
        !validateWrittenFile(join(projection, payload.target), payload.bytes, identity)
      ) {
        throw new Error("transaction metadata validation failed");
      }
    }
    maybeFault(faultAt, "after-metadata-validation");
    maybeFault(faultAt, "before-commit");
    const receiptPath = join(projection, RECEIPT);
    const receiptBytes = bufferFrom(receiptJson(receipt));
    const receiptIdentity = writeExclusive(receiptPath, receiptBytes);
    committed = true;
    if (
      !validateWrittenFile(receiptPath, receiptBytes, receiptIdentity) ||
      !liveMetadataFor(metadata)
    ) {
      throw new Error("transaction receipt validation failed");
    }
    maybeFault(faultAt, "after-commit");
    unlinkSync(lockPath);
    if (!validExistingProjection(metadata, receipt, payloads)) {
      throw new Error("committed transaction validation failed");
    }
    return closedRecord([
      ["schemaVersion", SCHEMA_VERSION],
      ["state", "applied"],
      ["receipt", receipt],
      ["boundary", BOUNDARY],
      ["findings", EMPTY_FINDINGS],
    ]);
  } catch {
    const phase = committed ? "committed" : "rollback";
    try {
      writeExclusive(
        join(metadata.root, RECOVERY),
        bufferFrom(recoveryJson(metadata, receipt, phase)),
      );
    } catch {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
    if (committed || faultAt === "during-rollback") {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
    return recoverRollback(metadata, receipt, payloads)
      ? failure("blocked", "METHODOLOGY_TRANSACTION_IO_FAILED")
      : failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
}

function parseReceipt(value: unknown): SyntheticTransactionReceipt | undefined {
  const candidate = snapshot(value);
  if (
    !candidate.ok ||
    !exactRecord(candidate.value, [
      "schemaVersion",
      "transactionVersion",
      "manifestDigest",
      "owner",
      "entries",
      "claims",
      "boundary",
      "authTag",
    ])
  )
    return undefined;
  const record = candidate.value;
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    record.transactionVersion !== TRANSACTION_VERSION ||
    typeof record.manifestDigest !== "string" ||
    !regexpTest(/^[0-9a-f]{64}$/, record.manifestDigest) ||
    typeof record.owner !== "string" ||
    !regexpTest(/^[a-z][a-z0-9-]{0,63}$/, record.owner) ||
    !ARRAY_IS_ARRAY(record.entries) ||
    record.entries.length > MAX_PAYLOADS ||
    typeof record.authTag !== "string" ||
    !regexpTest(/^[0-9a-f]{64}$/, record.authTag) ||
    !exactRecord(record.claims, [
      "installed",
      "active",
      "isolated",
      "switchable",
      "concurrent",
      "conflictFree",
      "secureErasure",
    ]) ||
    record.claims.installed !== false ||
    record.claims.active !== false ||
    record.claims.isolated !== false ||
    record.claims.switchable !== false ||
    record.claims.concurrent !== false ||
    record.claims.conflictFree !== false ||
    record.claims.secureErasure !== false ||
    !validBoundary(record.boundary)
  )
    return undefined;
  let totalBytes = 0;
  for (let index = 0; index < record.entries.length; index += 1) {
    const entry = record.entries[index];
    if (
      !exactRecord(entry, ["artifactId", "target", "contentDigest", "bytes"]) ||
      typeof entry.artifactId !== "string" ||
      !regexpTest(/^[a-z][a-z0-9-]{0,63}$/, entry.artifactId) ||
      typeof entry.target !== "string" ||
      !validReceiptTarget(entry.target) ||
      typeof entry.contentDigest !== "string" ||
      !regexpTest(/^[0-9a-f]{64}$/, entry.contentDigest) ||
      typeof entry.bytes !== "number" ||
      !numberIsSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > MAX_PAYLOAD_BYTES
    )
      return undefined;
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) return undefined;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = record.entries[priorIndex];
      if (
        prior !== undefined &&
        (prior.artifactId === entry.artifactId || prior.target === entry.target)
      ) {
        return undefined;
      }
    }
  }
  return record as SyntheticTransactionReceipt;
}

function validReceiptTarget(target: string): boolean {
  if (
    target.length < 1 ||
    target.length > 240 ||
    !regexpTest(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/, target)
  ) {
    return false;
  }
  const segments = stringSplit(target, "/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment === undefined ||
      stringEndsWith(segment, ".") ||
      regexpTest(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/, segment)
    ) {
      return false;
    }
  }
  return true;
}

function validBoundary(value: unknown): value is TransactionBoundary {
  return (
    exactRecord(value, [
      "temporaryRootOnly",
      "cli",
      "executor",
      "providerExecution",
      "hostExecution",
      "network",
      "nativeComponent",
    ]) &&
    value.temporaryRootOnly === true &&
    value.cli === false &&
    value.executor === false &&
    value.providerExecution === false &&
    value.hostExecution === false &&
    value.network === false &&
    value.nativeComponent === false
  );
}

function parseResult(value: unknown): SyntheticTransactionResult | undefined {
  const candidate = snapshot(value);
  if (!candidate.ok || candidate.value === null || typeof candidate.value !== "object")
    return undefined;
  const state = ownDataDescriptor(candidate.value, "state")?.value;
  if (state === "applied") {
    if (
      !exactRecord(candidate.value, ["schemaVersion", "state", "receipt", "boundary", "findings"])
    )
      return undefined;
    const receipt = parseReceipt(candidate.value.receipt);
    if (
      candidate.value.schemaVersion !== SCHEMA_VERSION ||
      receipt === undefined ||
      !validBoundary(candidate.value.boundary) ||
      !ARRAY_IS_ARRAY(candidate.value.findings) ||
      candidate.value.findings.length !== 0
    )
      return undefined;
    return closedRecord([
      ["schemaVersion", SCHEMA_VERSION],
      ["state", "applied"],
      ["receipt", receipt],
      ["boundary", BOUNDARY],
      ["findings", EMPTY_FINDINGS],
    ]);
  }
  if (state === "cleaned") {
    if (
      !exactRecord(candidate.value, [
        "schemaVersion",
        "state",
        "manifestDigest",
        "receiptDigest",
        "boundary",
        "findings",
      ]) ||
      candidate.value.schemaVersion !== SCHEMA_VERSION ||
      typeof candidate.value.manifestDigest !== "string" ||
      !regexpTest(/^[0-9a-f]{64}$/, candidate.value.manifestDigest) ||
      typeof candidate.value.receiptDigest !== "string" ||
      !regexpTest(/^[0-9a-f]{64}$/, candidate.value.receiptDigest) ||
      !validBoundary(candidate.value.boundary) ||
      !ARRAY_IS_ARRAY(candidate.value.findings) ||
      candidate.value.findings.length !== 0
    ) {
      return undefined;
    }
    return candidate.value as CleanedTransactionResult;
  }
  if (state === "blocked" || state === "recovery-required") {
    if (!exactRecord(candidate.value, ["schemaVersion", "state", "boundary", "findings"]))
      return undefined;
    const findings = candidate.value.findings;
    if (
      candidate.value.schemaVersion !== SCHEMA_VERSION ||
      !validBoundary(candidate.value.boundary) ||
      !ARRAY_IS_ARRAY(findings) ||
      findings.length !== 1 ||
      !exactRecord(findings[0], ["code"]) ||
      typeof findings[0].code !== "string" ||
      !validFindingCode(findings[0].code)
    )
      return undefined;
    return candidate.value as TransactionFailure;
  }
  return undefined;
}

export const SyntheticTransactionReceiptSchema = closedSchema(parseReceipt);
export const SyntheticTransactionResultSchema = closedSchema(parseResult);

export type CleanSyntheticTransactionRequest = Readonly<{
  schemaVersion: 1;
  capability: SyntheticTransactionCapability;
  receipt: SyntheticTransactionReceipt;
}>;

function parseCleanRequest(value: unknown): CleanSyntheticTransactionRequest | undefined {
  if (!exactRecord(value, ["schemaVersion", "capability", "receipt"])) return undefined;
  const version = ownDataDescriptor(value, "schemaVersion")?.value;
  const capability = ownDataDescriptor(value, "capability")?.value;
  const receipt = parseReceipt(ownDataDescriptor(value, "receipt")?.value);
  if (
    version !== SCHEMA_VERSION ||
    capability === null ||
    typeof capability !== "object" ||
    isProxy(capability) ||
    !weakSetHas(CAPABILITIES, capability) ||
    weakMapGet(CAPABILITY_METADATA, capability) === undefined ||
    receipt === undefined
  ) {
    return undefined;
  }
  return closedRecord([
    ["schemaVersion", SCHEMA_VERSION],
    ["capability", capability],
    ["receipt", receipt],
  ]);
}

export const CleanSyntheticTransactionRequestSchema = closedSchema(parseCleanRequest);

function receiptAuthenticationIsValid(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
): boolean {
  const expected = hmacHex(
    metadata.authorityKey,
    receiptPreimage(receipt.manifestDigest, receipt.owner, receipt.entries),
  );
  return secureHexEqual(receipt.authTag, expected);
}

function cleanRecoveryPreimage(receipt: SyntheticTransactionReceipt): string {
  return `phase-4-recovery-v1\nclean\n${receipt.manifestDigest}\n${receipt.authTag}\n`;
}

function cleanRecoveryJson(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
): string {
  const authTag = hmacHex(metadata.authorityKey, cleanRecoveryPreimage(receipt));
  return `{"schemaVersion":1,"recoveryVersion":"phase-4-recovery-v1","operation":"clean","phase":"cleaning","manifestDigest":${quote(receipt.manifestDigest)},"receiptAuthTag":${quote(receipt.authTag)},"authTag":${quote(authTag)}}\n`;
}

function receiptDigest(receipt: SyntheticTransactionReceipt): string {
  return hashBytes(bufferFrom(receiptJson(receipt)));
}

function cleaned(receipt: SyntheticTransactionReceipt): CleanedTransactionResult {
  return closedRecord([
    ["schemaVersion", SCHEMA_VERSION],
    ["state", "cleaned"],
    ["manifestDigest", receipt.manifestDigest],
    ["receiptDigest", receiptDigest(receipt)],
    ["boundary", BOUNDARY],
    ["findings", EMPTY_FINDINGS],
  ]);
}

type CleanScan = Readonly<{
  files: readonly string[];
  directories: readonly string[];
  receiptPresent: boolean;
}>;

function expectedCleanPaths(
  projection: string,
  receipt: SyntheticTransactionReceipt,
): Readonly<{ files: readonly string[]; directories: readonly string[] }> {
  const files: string[] = [join(projection, RECEIPT)];
  const directories: string[] = [projection];
  for (let index = 0; index < receipt.entries.length; index += 1) {
    const entry = receipt.entries[index];
    if (entry === undefined) continue;
    const parts = stringSplit(entry.target, "/");
    let parent = projection;
    for (let partIndex = 0; partIndex < parts.length - 1; partIndex += 1) {
      const part = parts[partIndex];
      if (part === undefined) continue;
      parent = join(parent, part);
      if (!pathIn(directories, parent)) appendOwn(directories, parent);
    }
    appendOwn(files, join(projection, entry.target));
  }
  return OBJECT_FREEZE({ files: OBJECT_FREEZE(files), directories: OBJECT_FREEZE(directories) });
}

function receiptEntryForPath(
  path: string,
  projection: string,
  receipt: SyntheticTransactionReceipt,
): SyntheticTransactionReceipt["entries"][number] | undefined {
  for (let index = 0; index < receipt.entries.length; index += 1) {
    const entry = receipt.entries[index];
    if (entry !== undefined && path === join(projection, entry.target)) return entry;
  }
  return undefined;
}

function exactReceiptEntryFile(
  path: string,
  entry: SyntheticTransactionReceipt["entries"][number],
): boolean {
  if (entry.bytes > MAX_PAYLOAD_BYTES) return false;
  const actual = readOwnedFile(path, entry.bytes);
  return (
    actual !== undefined &&
    actual.bytes.length === entry.bytes &&
    hashBytes(actual.bytes) === entry.contentDigest
  );
}

function scanCleanProjection(
  projection: string,
  receipt: SyntheticTransactionReceipt,
): CleanScan | undefined {
  let projectionStat: BigIntStats;
  try {
    projectionStat = lstatSync(projection, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? OBJECT_FREEZE({
          files: OBJECT_FREEZE([]),
          directories: OBJECT_FREEZE([]),
          receiptPresent: false,
        })
      : undefined;
  }
  if (!statIsDirectory(projectionStat) || statIsSymbolicLink(projectionStat)) return undefined;
  const expected = expectedCleanPaths(projection, receipt);
  const files: string[] = [];
  const directories: string[] = [projection];
  const queue: string[] = [projection];
  let receiptPresent = false;
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const directory = queue[queueIndex];
    if (directory === undefined) return undefined;
    let children: string[];
    try {
      const bounded = boundedDirectoryNames(directory);
      if (bounded === undefined) return undefined;
      children = bounded;
    } catch {
      return undefined;
    }
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      if (child === undefined) return undefined;
      const path = join(directory, child);
      let stat: BigIntStats;
      try {
        stat = lstatSync(path, { bigint: true });
      } catch {
        return undefined;
      }
      if (statIsSymbolicLink(stat)) return undefined;
      if (statIsDirectory(stat)) {
        if (!pathIn(expected.directories, path)) return undefined;
        appendOwn(directories, path);
        appendOwn(queue, path);
      } else if (statIsRegularFile(stat)) {
        if (!pathIn(expected.files, path) || stat.nlink !== 1n) return undefined;
        if (path === join(projection, RECEIPT)) {
          if (!exactRegularFile(path, bufferFrom(receiptJson(receipt)))) return undefined;
          receiptPresent = true;
        } else {
          const entry = receiptEntryForPath(path, projection, receipt);
          if (entry === undefined || !exactReceiptEntryFile(path, entry)) return undefined;
        }
        appendOwn(files, path);
      } else {
        return undefined;
      }
    }
    if (files.length + directories.length > 256) return undefined;
  }
  return OBJECT_FREEZE({
    files: OBJECT_FREEZE(files),
    directories: OBJECT_FREEZE(directories),
    receiptPresent,
  });
}

function unlinkCleanFile(
  path: string,
  projection: string,
  receipt: SyntheticTransactionReceipt,
): boolean {
  if (path === join(projection, RECEIPT)) {
    return unlinkExact(path, bufferFrom(receiptJson(receipt)));
  }
  const entry = receiptEntryForPath(path, projection, receipt);
  if (entry === undefined || !exactReceiptEntryFile(path, entry)) return false;
  try {
    unlinkSync(path);
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  } catch {
    return false;
  }
}

function removeCleanProjection(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  faultAt: CleanFaultPoint | undefined,
): boolean {
  const projection = join(metadata.root, PROJECTION);
  const scanned = scanCleanProjection(projection, receipt);
  if (scanned === undefined) return false;
  let removedFiles = 0;
  for (let index = 0; index < scanned.files.length; index += 1) {
    const path = scanned.files[index];
    if (path === undefined || !unlinkCleanFile(path, projection, receipt)) return false;
    removedFiles += 1;
    if (removedFiles === 1) maybeFault(faultAt, "during-entry-remove");
  }
  const remaining: string[] = [];
  for (let index = 0; index < scanned.directories.length; index += 1) {
    const path = scanned.directories[index];
    if (path !== undefined) appendOwn(remaining, path);
  }
  let removedDirectories = 0;
  while (remaining.length > 0) {
    let selected = 0;
    for (let index = 1; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const current = remaining[selected];
      if (candidate !== undefined && current !== undefined && candidate.length > current.length) {
        selected = index;
      }
    }
    const path = remaining[selected];
    if (path === undefined) return false;
    let stat: BigIntStats;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch {
      return false;
    }
    if (!statIsDirectory(stat) || statIsSymbolicLink(stat)) return false;
    try {
      rmdirSync(path);
    } catch {
      return false;
    }
    arrayRemoveAt(remaining, selected);
    removedDirectories += 1;
    if (removedDirectories === 1) maybeFault(faultAt, "during-directory-remove");
  }
  return liveMetadataFor(metadata);
}

function completeCleanControls(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
): boolean {
  const recoveryPath = join(metadata.root, RECOVERY);
  const lockPath = join(metadata.root, LOCK);
  try {
    lstatSync(lockPath);
    if (!unlinkExact(lockPath, bufferFrom(`${TRANSACTION_VERSION}\nclean\n${receipt.authTag}\n`))) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    lstatSync(recoveryPath);
    if (!unlinkExact(recoveryPath, bufferFrom(cleanRecoveryJson(metadata, receipt)))) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const remaining = boundedDirectoryNames(metadata.root);
  return liveMetadataFor(metadata) && remaining !== undefined && remaining.length === 0;
}

function recoverClean(
  metadata: CapabilityMetadata,
  receipt: SyntheticTransactionReceipt,
  faultAt: CleanFaultPoint | undefined,
): SyntheticTransactionResult {
  maybeFault(faultAt, "during-recovery");
  const recoveryPath = join(metadata.root, RECOVERY);
  const expectedRecovery = cleanRecoveryJson(metadata, receipt);
  if (!exactRegularFile(recoveryPath, bufferFrom(expectedRecovery))) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  const projection = join(metadata.root, PROJECTION);
  const scanned = scanCleanProjection(projection, receipt);
  if (scanned === undefined) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  if (!removeCleanProjection(metadata, receipt, undefined)) {
    return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
  }
  return completeCleanControls(metadata, receipt)
    ? cleaned(receipt)
    : failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
}

export function cleanSyntheticTransaction(
  value: unknown,
  options?: Readonly<{ faultAt?: CleanFaultPoint }>,
): SyntheticTransactionResult {
  if (!ambientIntrinsicsAreClean()) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  }
  const optionSnapshot = snapshotFaultOption(options, CLEAN_FAULT_POINTS);
  if (!optionSnapshot.ok) return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  const faultAt = optionSnapshot.faultAt;
  const parsed = CleanSyntheticTransactionRequestSchema.safeParse(value);
  if (!parsed.success) return failure("blocked", "METHODOLOGY_TRANSACTION_INVALID");
  const metadata = liveMetadata(parsed.data.capability);
  if (metadata === undefined || !receiptAuthenticationIsValid(metadata, parsed.data.receipt)) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_RECEIPT_MISMATCH");
  }
  const receipt = parsed.data.receipt;
  try {
    maybeFault(faultAt, "after-root-validation");
  } catch {
    return failure("blocked", "METHODOLOGY_TRANSACTION_IO_FAILED");
  }
  const boundedRootEntries = boundedDirectoryNames(metadata.root);
  if (boundedRootEntries === undefined) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_ROOT_UNTRUSTED");
  }
  const rootEntries = boundedRootEntries;
  if (rootEntries.length === 0) return cleaned(receipt);
  if (pathIn(rootEntries, RECOVERY)) {
    try {
      return recoverClean(metadata, receipt, faultAt);
    } catch {
      return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
    }
  }
  if (rootEntries.length !== 1 || rootEntries[0] !== PROJECTION) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_ROOT_NOT_EMPTY");
  }
  const projection = join(metadata.root, PROJECTION);
  const initial = scanCleanProjection(projection, receipt);
  if (initial === undefined || !initial.receiptPresent) {
    return failure("blocked", "METHODOLOGY_TRANSACTION_RECEIPT_MISMATCH");
  }
  const lockPath = join(metadata.root, LOCK);
  const recoveryPath = join(metadata.root, RECOVERY);
  let lockWritten = false;
  let recoveryWritten = false;
  try {
    writeExclusive(lockPath, bufferFrom(`${TRANSACTION_VERSION}\nclean\n${receipt.authTag}\n`));
    lockWritten = true;
    maybeFault(faultAt, "after-lock");
    writeExclusive(recoveryPath, bufferFrom(cleanRecoveryJson(metadata, receipt)));
    recoveryWritten = true;
    maybeFault(faultAt, "after-recovery-record");
    if (!unlinkCleanFile(join(projection, RECEIPT), projection, receipt)) {
      throw new Error("failed to revoke transaction receipt");
    }
    maybeFault(faultAt, "after-receipt-revoke");
    if (!removeCleanProjection(metadata, receipt, faultAt)) {
      throw new Error("failed to remove receipt-bound projection");
    }
    maybeFault(faultAt, "before-recovery-remove");
    if (!completeCleanControls(metadata, receipt)) {
      throw new Error("failed to remove transaction controls");
    }
    return cleaned(receipt);
  } catch {
    if (lockWritten && !recoveryWritten) {
      try {
        writeExclusive(recoveryPath, bufferFrom(cleanRecoveryJson(metadata, receipt)));
        recoveryWritten = true;
      } catch {
        return failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED");
      }
    }
    return lockWritten || recoveryWritten
      ? failure("recovery-required", "METHODOLOGY_TRANSACTION_RECOVERY_REQUIRED")
      : failure("blocked", "METHODOLOGY_TRANSACTION_IO_FAILED");
  }
}
