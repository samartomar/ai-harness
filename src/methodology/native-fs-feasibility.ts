import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { type ClosedSchema, ClosedSchemaError, type ClosedSchemaIssue } from "./classifier.js";

const INTRINSIC_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_CREATE = Object.create;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const ARRAY_IS_ARRAY = Array.isArray;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const STRING_STARTS_WITH = String.prototype.startsWith;
const JSON_PARSE = JSON.parse;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const STRING_CONVERT = String;

const SCHEMA_VERSION = 1 as const;
const PROBE_VERSION = "phase-4a-native-fs-v1" as const;
const NATIVE_COMPONENT_VERSION = "phase-4a-native-fs-native-v1" as const;
const PRIMITIVE_VERSION = "phase-4a-primitive-v1" as const;
const MAX_NATIVE_REPORT_BYTES = 65_536;
const MAX_SNAPSHOT_ARRAY_LENGTH = 16;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 128;
const CAPABILITY_PREFIX = "aih-methodology-native-fs-";
const require = createRequire(import.meta.url);
const EXPECTED_ADDON_PATH = resolve(
  process.cwd(),
  "native",
  "methodology-fs",
  "build",
  "Release",
  "methodology_fs.node",
);
const EXPECTED_ADDON_BUILD_LINK = resolve(
  process.cwd(),
  "native",
  "methodology-fs",
  "build",
  "Release",
  "obj.target",
  "methodology_fs.node",
);

export const NATIVE_FS_PRIMITIVES = Object.freeze([
  "identity-bound-file-publication",
  "no-replace-directory-publication",
  "identity-bound-file-detachment",
  "identity-bound-directory-detachment",
  "parent-directory-durability",
  "link-and-volume-containment",
  "substitution-resistance",
] as const);

const NATIVE_FS_DISPOSITIONS = Object.freeze(["supported", "unsupported", "blocked"] as const);

const NATIVE_FS_REASON_CODES = Object.freeze([
  "primitive-qualified",
  "native-backend-unimplemented",
  "native-addon-unavailable",
  "native-addon-load-failed",
  "native-addon-abi-mismatch",
  "native-report-invalid",
  "native-report-oversized",
  "native-operation-failed",
  "unexpected-error-code",
  "root-identity-unavailable",
  "root-identity-drift",
  "root-not-private",
  "root-linked",
  "root-outside-temporary-directory",
  "filesystem-identity-unavailable",
  "filesystem-identity-drift",
  "platform-interface-unavailable",
  "filesystem-unsupported",
  "identity-bound-publication-unavailable",
  "identity-bound-detachment-unavailable",
  "parent-directory-durability-unavailable",
  "containment-unproven",
  "substitution-resistance-unproven",
  "source-identity-drift",
  "destination-canary-changed",
  "cross-volume-operation",
  "symlink-detected",
  "hard-link-detected",
  "reparse-point-detected",
] as const);
const NODE_PLATFORMS = Object.freeze([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
] as const);
const NODE_ARCHITECTURES = Object.freeze([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
] as const);
const UNSUPPORTED_REASONS = Object.freeze([
  "platform-interface-unavailable",
  "filesystem-unsupported",
  "identity-bound-publication-unavailable",
  "identity-bound-detachment-unavailable",
  "parent-directory-durability-unavailable",
] as const);

export type NativeFsPrimitive = (typeof NATIVE_FS_PRIMITIVES)[number];
export type NativeFsDisposition = (typeof NATIVE_FS_DISPOSITIONS)[number];
export type NativeFsReasonCode = (typeof NATIVE_FS_REASON_CODES)[number];

export type NativeFsObservation = {
  primitive: NativeFsPrimitive;
  primitiveVersion: typeof PRIMITIVE_VERSION;
  disposition: NativeFsDisposition;
  reason: NativeFsReasonCode;
};

export type NativeFsCapabilityRecord = {
  schemaVersion: typeof SCHEMA_VERSION;
  probeVersion: typeof PROBE_VERSION;
  state: NativeFsDisposition;
  platform: {
    os: NodeJS.Platform;
    architecture: string;
    runtime: "node";
    runtimeVersion: string;
    nodeApiVersion: string;
  };
  nativeComponentVersion: typeof NATIVE_COMPONENT_VERSION;
  rootIdentity: {
    device: string;
    file: string;
  };
  filesystemIdentity: {
    scope: "filesystem" | "volume";
    device: string;
    type: string;
  };
  observations: NativeFsObservation[];
  boundary: {
    cli: false;
    executor: false;
    providerExecution: false;
    hostExecution: false;
    network: false;
    nonTemporaryWrites: false;
  };
};

export interface NativeFsProbeCapability {
  readonly root: string;
  readonly dispose: () => void;
}

type RootIdentity = {
  readonly device: bigint;
  readonly file: bigint;
  readonly mode: bigint;
};

type CapabilityMetadata = {
  readonly root: string;
  readonly tempRoot: string;
  readonly identity: RootIdentity;
  readonly filesystemIdentity: NativeFsCapabilityRecord["filesystemIdentity"];
};

type SnapshotState = {
  depth: number;
  nodes: number;
  active: WeakSet<object>;
};

type SnapshotResult = { ok: true; value: unknown } | { ok: false };

const CAPABILITIES = new WeakSet<object>();
const CAPABILITY_METADATA = new WeakMap<object, CapabilityMetadata>();
const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });

function callIntrinsic<T>(
  intrinsic: CallableFunction,
  receiver: unknown,
  argumentsList: readonly unknown[],
): T {
  return INTRINSIC_APPLY(intrinsic, receiver, argumentsList) as T;
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

function weakMapGet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return callIntrinsic<V | undefined>(WEAK_MAP_GET, map, [key]);
}

function weakMapSet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K, value: V): void {
  callIntrinsic<WeakMap<K, V>>(WEAK_MAP_SET, map, [key, value]);
}

function appendOwn<T>(values: T[], value: T): void {
  OBJECT_DEFINE_PROPERTY(
    values,
    callIntrinsic<string>(STRING_CONVERT, undefined, [values.length]),
    {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    },
  );
}

function copyOwnValues<T>(values: readonly T[]): T[] {
  const result: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      values,
      callIntrinsic<string>(STRING_CONVERT, undefined, [index]),
    );
    if (descriptor !== undefined && "value" in descriptor) appendOwn(result, descriptor.value);
  }
  return result;
}

function stringStartsWith(value: string, prefix: string): boolean {
  return callIntrinsic<boolean>(STRING_STARTS_WITH, value, [prefix]);
}

function ownKeys(value: object): readonly PropertyKey[] {
  return callIntrinsic<PropertyKey[]>(REFLECT_OWN_KEYS, Reflect, [value]);
}

function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return callIntrinsic<PropertyDescriptor | undefined>(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [
    value,
    key,
  ]);
}

function prototypeOf(value: object): object | null {
  return callIntrinsic<object | null>(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
}

function snapshotPlainData(value: unknown, state: SnapshotState): SnapshotResult {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (isProxy(value) || state.depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (weakSetHas(state.active, value)) return INVALID_SNAPSHOT;
  state.nodes += 1;
  weakSetAdd(state.active, value);
  state.depth += 1;
  try {
    if (ARRAY_IS_ARRAY(value)) {
      if (prototypeOf(value) !== Array.prototype || value.length > MAX_SNAPSHOT_ARRAY_LENGTH) {
        return INVALID_SNAPSHOT;
      }
      const keys = ownKeys(value);
      if (keys.length !== value.length + 1) return INVALID_SNAPSHOT;
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = ownDescriptor(
          value,
          callIntrinsic<string>(STRING_CONVERT, undefined, [index]),
        );
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return INVALID_SNAPSHOT;
        }
        const child = snapshotPlainData(descriptor.value, state);
        if (!child.ok) return INVALID_SNAPSHOT;
        appendOwn(result, child.value);
      }
      return { ok: true, value: result };
    }
    const prototype = prototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return INVALID_SNAPSHOT;
    const keys = ownKeys(value);
    if (keys.length > MAX_SNAPSHOT_RECORD_KEYS) return INVALID_SNAPSHOT;
    const result = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") return INVALID_SNAPSHOT;
      const descriptor = ownDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return INVALID_SNAPSHOT;
      }
      const child = snapshotPlainData(descriptor.value, state);
      if (!child.ok) return INVALID_SNAPSHOT;
      OBJECT_DEFINE_PROPERTY(result, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
    return { ok: true, value: result };
  } finally {
    state.depth -= 1;
    weakSetDelete(state.active, value);
  }
}

function validationSnapshot(value: unknown): SnapshotResult {
  return snapshotPlainData(value, { depth: 0, nodes: 0, active: new WeakSet<object>() });
}

function issue(path: readonly (string | number)[], message: string): ClosedSchemaIssue {
  return { code: "custom", path: copyOwnValues(path), message };
}

function isOneOf(value: unknown, choices: readonly string[]): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < choices.length; index += 1) {
    if (value === choices[index]) return true;
  }
  return false;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) return undefined;
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
  path: readonly (string | number)[] = [],
): { record?: Record<string, unknown>; issue?: ClosedSchemaIssue } {
  const record = recordOf(value);
  if (record === undefined) return { issue: issue(path, "expected a closed record") };
  const keys = ownKeys(record);
  if (keys.length !== fields.length) return { issue: issue(path, "record shape is not closed") };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || !isOneOf(key, fields)) {
      return { issue: issue(path, "record shape is not closed") };
    }
  }
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || ownDescriptor(record, field) === undefined) {
      return { issue: issue(path, "record shape is not closed") };
    }
  }
  return { record };
}

function closedSchema<T>(
  validate: (value: unknown) => ClosedSchemaIssue | undefined,
): ClosedSchema<T> {
  const safeParse = (value: unknown) => {
    const snapshot = validationSnapshot(value);
    if (!snapshot.ok) {
      return { success: false as const, error: new ClosedSchemaError(issue([], "unsafe value")) };
    }
    const validationIssue = validate(snapshot.value);
    if (validationIssue !== undefined) {
      return { success: false as const, error: new ClosedSchemaError(validationIssue) };
    }
    return { success: true as const, data: snapshot.value as T };
  };
  const parse = (value: unknown): T => {
    const result = safeParse(value);
    if (!result.success) throw result.error;
    return result.data;
  };
  const safeParseAsync = (value: unknown) => Promise.resolve(safeParse(value));
  const parseAsync = (value: unknown): Promise<T> => {
    try {
      return Promise.resolve(parse(value));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return OBJECT_FREEZE({
    decode: parse,
    decodeAsync: parseAsync,
    parse,
    parseAsync,
    safeDecode: safeParse,
    safeDecodeAsync: safeParseAsync,
    safeParse,
    safeParseAsync,
    spa: safeParseAsync,
  });
}

function validatePrimitive(value: unknown): ClosedSchemaIssue | undefined {
  return isOneOf(value, NATIVE_FS_PRIMITIVES) ? undefined : issue([], "unknown primitive");
}

function validateDisposition(value: unknown): ClosedSchemaIssue | undefined {
  return isOneOf(value, NATIVE_FS_DISPOSITIONS) ? undefined : issue([], "unknown disposition");
}

function validateReasonCode(value: unknown): ClosedSchemaIssue | undefined {
  return isOneOf(value, NATIVE_FS_REASON_CODES) ? undefined : issue([], "unknown reason code");
}

function validateObservation(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["primitive", "primitiveVersion", "disposition", "reason"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const observation = shape.record;
  if (!isOneOf(observation.primitive, NATIVE_FS_PRIMITIVES)) {
    return issue(["primitive"], "unknown primitive");
  }
  if (observation.primitiveVersion !== PRIMITIVE_VERSION) {
    return issue(["primitiveVersion"], "unsupported primitive version");
  }
  if (!isOneOf(observation.disposition, NATIVE_FS_DISPOSITIONS)) {
    return issue(["disposition"], "unknown disposition");
  }
  if (!isOneOf(observation.reason, NATIVE_FS_REASON_CODES)) {
    return issue(["reason"], "unknown reason code");
  }
  if (observation.disposition === "supported" && observation.reason !== "primitive-qualified") {
    return issue(["reason"], "supported observations require qualification evidence");
  }
  if (observation.disposition !== "supported" && observation.reason === "primitive-qualified") {
    return issue(["reason"], "qualification evidence cannot describe a non-supported result");
  }
  if (
    observation.disposition === "unsupported" &&
    !isOneOf(observation.reason, UNSUPPORTED_REASONS)
  ) {
    return issue(["reason"], "unsupported observations require a fixed unsupported reason");
  }
  if (observation.disposition === "blocked" && isOneOf(observation.reason, UNSUPPORTED_REASONS)) {
    return issue(["reason"], "blocked observations require a fixed blocked reason");
  }
  return undefined;
}

function validateString(
  value: unknown,
  path: readonly (string | number)[],
): ClosedSchemaIssue | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    ? undefined
    : issue(path, "expected a bounded non-empty string");
}

function validatePlatform(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(
    value,
    ["os", "architecture", "runtime", "runtimeVersion", "nodeApiVersion"],
    ["platform"],
  );
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const record = shape.record;
  if (!isOneOf(record.os, NODE_PLATFORMS)) {
    return issue(["platform", "os"], "unknown operating system");
  }
  if (!isOneOf(record.architecture, NODE_ARCHITECTURES)) {
    return issue(["platform", "architecture"], "unknown architecture");
  }
  const stringFields = ["runtimeVersion", "nodeApiVersion"] as const;
  for (let index = 0; index < stringFields.length; index += 1) {
    const field = stringFields[index];
    if (field === undefined) continue;
    const fieldIssue = validateString(record[field], ["platform", field]);
    if (fieldIssue !== undefined) return fieldIssue;
  }
  return record.runtime === "node"
    ? undefined
    : issue(["platform", "runtime"], "runtime must be node");
}

function validateRootIdentity(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["device", "file"], ["rootIdentity"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  return (
    validateString(shape.record.device, ["rootIdentity", "device"]) ??
    validateString(shape.record.file, ["rootIdentity", "file"])
  );
}

function validateFilesystemIdentity(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, ["scope", "device", "type"], ["filesystemIdentity"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  if (shape.record.scope !== "filesystem" && shape.record.scope !== "volume") {
    return issue(["filesystemIdentity", "scope"], "unknown identity scope");
  }
  return (
    validateString(shape.record.device, ["filesystemIdentity", "device"]) ??
    validateString(shape.record.type, ["filesystemIdentity", "type"])
  );
}

function validateBoundary(value: unknown): ClosedSchemaIssue | undefined {
  const fields = [
    "cli",
    "executor",
    "providerExecution",
    "hostExecution",
    "network",
    "nonTemporaryWrites",
  ] as const;
  const shape = exactRecord(value, fields, ["boundary"]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field !== undefined && shape.record[field] !== false) {
      return issue(["boundary", field], "boundary capability must remain false");
    }
  }
  return undefined;
}

function dispositionFor(observations: readonly NativeFsObservation[]): NativeFsDisposition {
  let unsupported = false;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    if (observation?.disposition === "blocked") return "blocked";
    if (observation?.disposition === "unsupported") unsupported = true;
  }
  return unsupported ? "unsupported" : "supported";
}

function validateCapabilityRecord(value: unknown): ClosedSchemaIssue | undefined {
  const shape = exactRecord(value, [
    "schemaVersion",
    "probeVersion",
    "state",
    "platform",
    "nativeComponentVersion",
    "rootIdentity",
    "filesystemIdentity",
    "observations",
    "boundary",
  ]);
  if (shape.issue !== undefined || shape.record === undefined) return shape.issue;
  const record = shape.record;
  if (record.schemaVersion !== SCHEMA_VERSION)
    return issue(["schemaVersion"], "unsupported version");
  if (record.probeVersion !== PROBE_VERSION) return issue(["probeVersion"], "unsupported version");
  if (!isOneOf(record.state, NATIVE_FS_DISPOSITIONS)) return issue(["state"], "unknown state");
  if (record.nativeComponentVersion !== NATIVE_COMPONENT_VERSION) {
    return issue(["nativeComponentVersion"], "unsupported native component version");
  }
  const platformIssue = validatePlatform(record.platform);
  if (platformIssue !== undefined) return platformIssue;
  const rootIssue = validateRootIdentity(record.rootIdentity);
  if (rootIssue !== undefined) return rootIssue;
  const filesystemIssue = validateFilesystemIdentity(record.filesystemIdentity);
  if (filesystemIssue !== undefined) return filesystemIssue;
  if (
    !ARRAY_IS_ARRAY(record.observations) ||
    record.observations.length !== NATIVE_FS_PRIMITIVES.length
  ) {
    return issue(["observations"], "all seven observations are required");
  }
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const observation = record.observations[index];
    const observationIssue = validateObservation(observation);
    if (observationIssue !== undefined)
      return issue(["observations", index], observationIssue.message);
    const observationRecord = recordOf(observation);
    if (observationRecord?.primitive !== NATIVE_FS_PRIMITIVES[index]) {
      return issue(["observations", index, "primitive"], "primitive order is fixed");
    }
  }
  if (record.state !== dispositionFor(record.observations as NativeFsObservation[])) {
    return issue(["state"], "state does not match observations");
  }
  return validateBoundary(record.boundary);
}

export const NativeFsPrimitiveSchema = closedSchema<NativeFsPrimitive>(validatePrimitive);
export const NativeFsDispositionSchema = closedSchema<NativeFsDisposition>(validateDisposition);
export const NativeFsReasonCodeSchema = closedSchema<NativeFsReasonCode>(validateReasonCode);
export const NativeFsObservationSchema = closedSchema<NativeFsObservation>(validateObservation);
export const NativeFsCapabilityRecordSchema =
  closedSchema<NativeFsCapabilityRecord>(validateCapabilityRecord);

function statRootIdentity(root: string): RootIdentity | undefined {
  try {
    const stat = lstatSync(root, { bigint: true });
    if ((stat.mode & 0o170000n) !== 0o040000n || stat.nlink < 1n) return undefined;
    return { device: stat.dev, file: stat.ino, mode: stat.mode };
  } catch {
    return undefined;
  }
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity | undefined): boolean {
  return right !== undefined && left.device === right.device && left.file === right.file;
}

function rootFailureReason(metadata: CapabilityMetadata): NativeFsReasonCode | undefined {
  const current = statRootIdentity(metadata.root);
  if (!sameRootIdentity(metadata.identity, current)) return "root-identity-drift";
  if (platform() !== "win32" && current !== undefined && (current.mode & 0o777n) !== 0o700n) {
    return "root-not-private";
  }
  return undefined;
}

function underTempRoot(root: string, tempRoot: string): boolean {
  const child = relative(tempRoot, root);
  return (
    child.length > 0 &&
    child !== ".." &&
    !stringStartsWith(child, `..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

function filesystemIdentity(
  root: string,
  identity: RootIdentity,
): NativeFsCapabilityRecord["filesystemIdentity"] {
  let type = "unavailable";
  try {
    type = callIntrinsic<string>(BIGINT_TO_STRING, statfsSync(root, { bigint: true }).type, [10]);
  } catch {
    // The exact device remains bound; unsupported native filesystem details fail closed later.
  }
  return {
    scope: platform() === "win32" ? "volume" : "filesystem",
    device: callIntrinsic<string>(BIGINT_TO_STRING, identity.device, [10]),
    type,
  };
}

function cleanupCapability(capability: object, metadata: CapabilityMetadata): void {
  weakSetDelete(CAPABILITIES, capability);
  if (!sameRootIdentity(metadata.identity, statRootIdentity(metadata.root))) return;
  try {
    rmSync(metadata.root, { recursive: true, force: false, maxRetries: 0 });
  } catch {
    // Cleanup is bounded and never broadens beyond the minted root.
  }
}

export function createNativeFsProbeCapability(): NativeFsProbeCapability {
  const tempRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempRoot, CAPABILITY_PREFIX));
  chmodSync(root, 0o700);
  const identity = statRootIdentity(root);
  if (identity === undefined || !underTempRoot(root, tempRoot)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 0 });
    throw new Error("failed to mint a private temporary-root capability");
  }
  let capability: NativeFsProbeCapability;
  const dispose = () => {
    const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
    if (metadata !== undefined && weakSetHas(CAPABILITIES, capability as object)) {
      cleanupCapability(capability as object, metadata);
    }
  };
  capability = OBJECT_FREEZE({ root, dispose });
  const metadata = {
    root,
    tempRoot,
    identity,
    filesystemIdentity: filesystemIdentity(root, identity),
  };
  weakSetAdd(CAPABILITIES, capability as object);
  weakMapSet(CAPABILITY_METADATA, capability as object, metadata);
  return capability;
}

function capabilityMetadata(capability: NativeFsProbeCapability): CapabilityMetadata {
  if (
    capability === null ||
    typeof capability !== "object" ||
    isProxy(capability) ||
    !weakSetHas(CAPABILITIES, capability as object)
  ) {
    throw new TypeError("a live native filesystem probe capability is required");
  }
  const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
  if (metadata === undefined) throw new TypeError("native filesystem probe capability is invalid");
  return metadata;
}

function validatedAddonPath(options: Readonly<{ addonPath?: string }> | undefined): string {
  if (options === undefined) return EXPECTED_ADDON_PATH;
  if (options === null || typeof options !== "object" || isProxy(options)) {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  const prototype = prototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  const keys = ownKeys(options);
  if (keys.length > 1) throw new TypeError("native filesystem probe options must be closed data");
  if (keys.length === 0) return EXPECTED_ADDON_PATH;
  const key = keys[0];
  if (key !== "addonPath")
    throw new TypeError("native filesystem probe options must be closed data");
  const descriptor = ownDescriptor(options, "addonPath");
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  if (descriptor.value !== EXPECTED_ADDON_PATH) {
    throw new TypeError("addon path must be the canonical repository-local native addon");
  }
  return EXPECTED_ADDON_PATH;
}

function currentPlatform(): NativeFsCapabilityRecord["platform"] {
  return {
    os: platform(),
    architecture: arch(),
    runtime: "node",
    runtimeVersion: process.versions.node,
    nodeApiVersion: process.versions.napi ?? "unavailable",
  };
}

const BOUNDARY: NativeFsCapabilityRecord["boundary"] = Object.freeze({
  cli: false,
  executor: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  nonTemporaryWrites: false,
});

function blockedObservations(reason: NativeFsReasonCode): NativeFsObservation[] {
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const primitive = NATIVE_FS_PRIMITIVES[index];
    if (primitive === undefined) continue;
    appendOwn(observations, {
      primitive,
      primitiveVersion: PRIMITIVE_VERSION,
      disposition: "blocked",
      reason,
    });
  }
  return observations;
}

function recordFor(
  metadata: CapabilityMetadata,
  observations: NativeFsObservation[],
): NativeFsCapabilityRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    probeVersion: PROBE_VERSION,
    state: dispositionFor(observations),
    platform: currentPlatform(),
    nativeComponentVersion: NATIVE_COMPONENT_VERSION,
    rootIdentity: {
      device: callIntrinsic<string>(BIGINT_TO_STRING, metadata.identity.device, [10]),
      file: callIntrinsic<string>(BIGINT_TO_STRING, metadata.identity.file, [10]),
    },
    filesystemIdentity: { ...metadata.filesystemIdentity },
    observations,
    boundary: { ...BOUNDARY },
  };
}

function blockedRecord(
  metadata: CapabilityMetadata,
  reason: NativeFsReasonCode,
): NativeFsCapabilityRecord {
  return recordFor(metadata, blockedObservations(reason));
}

function addonIsLoadable(path: string): "available" | "unavailable" | "invalid" {
  try {
    const stat = lstatSync(path, { bigint: true });
    if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink < 1n || stat.nlink > 2n) {
      return "invalid";
    }
    if (realpathSync(path) !== path) return "invalid";
    if (stat.nlink === 2n) {
      const buildLink = lstatSync(EXPECTED_ADDON_BUILD_LINK, { bigint: true });
      if (
        (buildLink.mode & 0o170000n) !== 0o100000n ||
        realpathSync(EXPECTED_ADDON_BUILD_LINK) !== EXPECTED_ADDON_BUILD_LINK ||
        buildLink.dev !== stat.dev ||
        buildLink.ino !== stat.ino
      ) {
        return "invalid";
      }
    }
    return "available";
  } catch {
    return "unavailable";
  }
}

function parseNativeReport(raw: unknown, metadata: CapabilityMetadata): NativeFsCapabilityRecord {
  if (typeof raw !== "string") return blockedRecord(metadata, "native-report-invalid");
  const reportBytes = callIntrinsic<number>(BUFFER_BYTE_LENGTH, Buffer, [raw, "utf8"]);
  if (reportBytes > MAX_NATIVE_REPORT_BYTES) {
    return blockedRecord(metadata, "native-report-oversized");
  }
  if (
    raw ===
    '{"schemaVersion":1,"probeVersion":"phase-4a-native-fs-v1","state":"blocked","reason":"native-backend-unimplemented"}'
  ) {
    return blockedRecord(metadata, "native-backend-unimplemented");
  }
  let parsed: unknown;
  try {
    parsed = callIntrinsic<unknown>(JSON_PARSE, JSON, [raw]);
  } catch {
    return blockedRecord(metadata, "native-report-invalid");
  }
  const result = NativeFsCapabilityRecordSchema.safeParse(parsed);
  if (!result.success) return blockedRecord(metadata, "native-report-invalid");
  const record = result.data;
  const expectedPlatform = currentPlatform();
  if (
    record.platform.os !== expectedPlatform.os ||
    record.platform.architecture !== expectedPlatform.architecture ||
    record.platform.runtime !== expectedPlatform.runtime ||
    record.platform.runtimeVersion !== expectedPlatform.runtimeVersion ||
    record.platform.nodeApiVersion !== expectedPlatform.nodeApiVersion ||
    record.rootIdentity.device !==
      callIntrinsic<string>(BIGINT_TO_STRING, metadata.identity.device, [10]) ||
    record.rootIdentity.file !==
      callIntrinsic<string>(BIGINT_TO_STRING, metadata.identity.file, [10]) ||
    record.filesystemIdentity.device !== metadata.filesystemIdentity.device ||
    record.filesystemIdentity.type !== metadata.filesystemIdentity.type ||
    record.filesystemIdentity.scope !== metadata.filesystemIdentity.scope
  ) {
    return blockedRecord(metadata, "native-report-invalid");
  }
  return recordFor(metadata, copyOwnValues(record.observations));
}

export function probeNativeFilesystem(
  capability: NativeFsProbeCapability,
  options?: Readonly<{ addonPath?: string }>,
): NativeFsCapabilityRecord {
  const metadata = capabilityMetadata(capability);
  const addonPath = validatedAddonPath(options);
  if (!underTempRoot(metadata.root, metadata.tempRoot)) {
    return blockedRecord(metadata, "root-outside-temporary-directory");
  }
  const initialRootFailure = rootFailureReason(metadata);
  if (initialRootFailure !== undefined) return blockedRecord(metadata, initialRootFailure);
  const addonState = addonIsLoadable(addonPath);
  if (addonState === "unavailable") return blockedRecord(metadata, "native-addon-unavailable");
  if (addonState === "invalid") return blockedRecord(metadata, "native-addon-load-failed");

  let addon: unknown;
  try {
    addon = require(addonPath);
  } catch {
    return blockedRecord(metadata, "native-addon-load-failed");
  }
  if (addon === null || typeof addon !== "object" || isProxy(addon)) {
    return blockedRecord(metadata, "native-addon-abi-mismatch");
  }
  const keys = ownKeys(addon);
  const probeDescriptor = ownDescriptor(addon, "probe");
  if (
    keys.length !== 1 ||
    keys[0] !== "probe" ||
    probeDescriptor === undefined ||
    !("value" in probeDescriptor) ||
    typeof probeDescriptor.value !== "function"
  ) {
    return blockedRecord(metadata, "native-addon-abi-mismatch");
  }
  let raw: unknown;
  try {
    raw = callIntrinsic<unknown>(probeDescriptor.value, undefined, [metadata.root]);
  } catch {
    return blockedRecord(metadata, "native-operation-failed");
  }
  const finalRootFailure = rootFailureReason(metadata);
  if (finalRootFailure !== undefined) return blockedRecord(metadata, finalRootFailure);
  return parseNativeReport(raw, metadata);
}
