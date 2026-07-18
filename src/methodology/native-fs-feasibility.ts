import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";

const INTRINSIC_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_IS_FROZEN = Object.isFrozen;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const OBJECT_PROTOTYPE = Object.prototype;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_DELETE = WeakMap.prototype.delete;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const STRING_STARTS_WITH = String.prototype.startsWith;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const JSON_PARSE = JSON.parse;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const STRING_CONVERT = String;
const PROMISE_RESOLVE = Promise.resolve;
const PROMISE_REJECT = Promise.reject;
const PROMISE_CONSTRUCTOR = Promise;
const WEAK_SET_CONSTRUCTOR = WeakSet;
const HASH_PROTOTYPE = Object.getPrototypeOf(createHash("sha256")) as {
  digest: CallableFunction;
  update: CallableFunction;
};
const HASH_DIGEST = HASH_PROTOTYPE.digest;
const HASH_UPDATE = HASH_PROTOTYPE.update;
const GUARDED_ARRAY_INTRINSICS = Object.freeze([
  ["map", Array.prototype.map],
  ["sort", Array.prototype.sort],
  ["filter", Array.prototype.filter],
  ["forEach", Array.prototype.forEach],
  ["push", Array.prototype.push],
  ["slice", Array.prototype.slice],
  ["some", Array.prototype.some],
  ["every", Array.prototype.every],
  ["reduce", Array.prototype.reduce],
  [Symbol.iterator, Array.prototype[Symbol.iterator]],
] as const);

const SCHEMA_VERSION = 1 as const;
const PROBE_VERSION = "phase-4a-native-fs-v1" as const;
const NATIVE_COMPONENT_VERSION = "phase-4a-native-fs-native-v1" as const;
const NATIVE_PROTOCOL_VERSION = "phase-4a-native-observations-v1" as const;
const PRIMITIVE_VERSION = "phase-4a-primitive-v1" as const;
const MAX_NATIVE_REPORT_BYTES = 65_536;
const MAX_NATIVE_ADDON_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_ARRAY_LENGTH = 16;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 128;
const CAPABILITY_PREFIX = "aih-methodology-native-fs-";
const require = createRequire(import.meta.url);
const OWNED_REQUIRE_CACHE = require.cache;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const REPOSITORY_NATIVE_ROOT = resolve(fileURLToPath(new URL("../../native/", import.meta.url)));
const EXPECTED_ADDON_PATH = fileURLToPath(
  new URL("../../native/methodology-fs/build/Release/methodology_fs.node", import.meta.url),
);
const EXPECTED_ADDON_BUILD_LINK = fileURLToPath(
  new URL(
    "../../native/methodology-fs/build/Release/obj.target/methodology_fs.node",
    import.meta.url,
  ),
);
const EXPECTED_ADDON_ANCESTORS = Object.freeze([
  REPOSITORY_ROOT,
  REPOSITORY_NATIVE_ROOT,
  join(REPOSITORY_NATIVE_ROOT, "methodology-fs"),
  join(REPOSITORY_NATIVE_ROOT, "methodology-fs", "build"),
  join(REPOSITORY_NATIVE_ROOT, "methodology-fs", "build", "Release"),
] as const);

export const NATIVE_FS_PRIMITIVES = Object.freeze([
  "identity-bound-file-publication",
  "no-replace-directory-publication",
  "identity-bound-file-detachment",
  "identity-bound-directory-detachment",
  "parent-directory-durability",
  "link-and-volume-containment",
  "substitution-resistance",
] as const);

const NATIVE_FS_DISPOSITIONS = Object.freeze(["blocked"] as const);
const BLOCKED_REASONS = Object.freeze([
  "native-backend-unimplemented",
  "native-addon-unavailable",
  "native-addon-load-failed",
  "native-addon-abi-mismatch",
  "native-addon-ancestor-invalid",
  "native-addon-oversized",
  "native-loader-not-identity-bound",
  "native-report-invalid",
  "native-report-oversized",
  "native-operation-failed",
  "unexpected-error-code",
  "root-identity-unavailable",
  "root-identity-drift",
  "root-not-private",
  "root-linked",
  "root-capability-unproven",
  "root-outside-temporary-directory",
  "filesystem-identity-unavailable",
  "filesystem-identity-drift",
  "containment-unproven",
  "substitution-resistance-unproven",
  "source-identity-drift",
  "destination-canary-changed",
  "cross-volume-operation",
  "symlink-detected",
  "hard-link-detected",
  "reparse-point-detected",
] as const);
const NATIVE_FS_REASON_CODES = BLOCKED_REASONS;
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
  state: "blocked";
  platform: {
    os: NodeJS.Platform;
    architecture: string;
    runtime: "node";
    runtimeVersion: string;
    nodeApiVersion: string;
  };
  nativeComponentVersion: typeof NATIVE_COMPONENT_VERSION;
  nativeLoader: {
    identityBound: false;
    disposition: "blocked";
    reason: "native-loader-not-identity-bound";
  };
  nativeRootAuthority: {
    authenticated: false;
    disposition: "blocked";
    reason: "root-capability-unproven";
  };
  rootIdentity: { device: string; file: string };
  filesystemIdentity: { scope: "filesystem" | "volume"; device: string; type: string };
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

type RootIdentity = { readonly device: bigint; readonly file: bigint; readonly mode: bigint };
type CapabilityMetadata = {
  readonly root: string;
  readonly tempRoot: string;
  readonly rootDescriptor: number | undefined;
  readonly identity: RootIdentity;
  readonly filesystemIdentity: NativeFsCapabilityRecord["filesystemIdentity"];
};
type ArtifactIdentity = {
  readonly device: bigint;
  readonly file: bigint;
  readonly size: bigint;
  readonly links: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly digest: string;
};
type ArtifactCapture =
  | { readonly state: "ready"; readonly identity: ArtifactIdentity }
  | { readonly state: "unavailable" | "invalid" | "oversized" };
type AncestorIdentity = {
  readonly path: string;
  readonly device: bigint;
  readonly file: bigint;
  readonly mode: bigint;
};
type OwnedAddon = {
  readonly module: NodeModule;
  readonly exports: object;
  readonly probe: CallableFunction;
  readonly artifact: ArtifactIdentity;
  readonly ancestors: readonly AncestorIdentity[];
};
type SnapshotState = { depth: number; nodes: number; active: WeakSet<object> };
type SnapshotResult = { ok: true; value: unknown } | { ok: false };
type NativeRawObservation = {
  primitive: NativeFsPrimitive;
  disposition: NativeFsDisposition;
  reason: NativeFsReasonCode;
};
type NativeRawReport = {
  schemaVersion: typeof SCHEMA_VERSION;
  nativeProtocolVersion: typeof NATIVE_PROTOCOL_VERSION;
  observations: NativeRawObservation[];
};
type ClosedSchemaResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: NativeFsClosedSchemaError };
type ClosedSchemaFacade<T> = {
  decode(value: unknown): T;
  decodeAsync(value: unknown): Promise<T>;
  parse(value: unknown): T;
  parseAsync(value: unknown): Promise<T>;
  safeDecode(value: unknown): ClosedSchemaResult<T>;
  safeDecodeAsync(value: unknown): Promise<ClosedSchemaResult<T>>;
  safeParse(value: unknown): ClosedSchemaResult<T>;
  safeParseAsync(value: unknown): Promise<ClosedSchemaResult<T>>;
  spa(value: unknown): Promise<ClosedSchemaResult<T>>;
};

const CAPABILITIES = new WeakSet<object>();
const CAPABILITY_METADATA = new WeakMap<object, CapabilityMetadata>();
const INVALID_SNAPSHOT = Object.freeze({ ok: false as const });
let ownedAddon: OwnedAddon | undefined;

function callIntrinsic<T>(
  intrinsic: CallableFunction,
  receiver: unknown,
  argumentsList: readonly unknown[],
): T {
  return INTRINSIC_APPLY(intrinsic, receiver, argumentsList) as T;
}

function ownDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return callIntrinsic<PropertyDescriptor | undefined>(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [
    value,
    key,
  ]);
}

function ownKeys(value: object): readonly PropertyKey[] {
  return callIntrinsic<PropertyKey[]>(REFLECT_OWN_KEYS, Reflect, [value]);
}

function prototypeOf(value: object): object | null {
  return callIntrinsic<object | null>(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
}

function appendOwn<T>(values: T[], value: T): void {
  OBJECT_DEFINE_PROPERTY(
    values,
    callIntrinsic<string>(STRING_CONVERT, undefined, [values.length]),
    { configurable: true, enumerable: true, value, writable: true },
  );
}

function closedRecord<T>(entries: readonly (readonly [string, unknown])[]): T {
  const result = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    OBJECT_DEFINE_PROPERTY(result, entry[0], {
      configurable: true,
      enumerable: true,
      value: entry[1],
      writable: true,
    });
  }
  return result as T;
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

function weakMapDelete<K extends WeakKey, V>(map: WeakMap<K, V>, key: K): void {
  callIntrinsic<boolean>(WEAK_MAP_DELETE, map, [key]);
}

function weakMapSet<K extends WeakKey, V>(map: WeakMap<K, V>, key: K, value: V): void {
  callIntrinsic<WeakMap<K, V>>(WEAK_MAP_SET, map, [key, value]);
}

function bigintString(value: bigint): string {
  return callIntrinsic<string>(BIGINT_TO_STRING, value, [10]);
}

function stringStartsWith(value: string, prefix: string): boolean {
  return callIntrinsic<boolean>(STRING_STARTS_WITH, value, [prefix]);
}

function stringCharCodeAt(value: string, index: number): number {
  return callIntrinsic<number>(STRING_CHAR_CODE_AT, value, [index]);
}

function snapshotPlainData(value: unknown, state: SnapshotState): SnapshotResult {
  if (value === null || typeof value !== "object") return { ok: true, value };
  if (isProxy(value) || state.depth >= MAX_SNAPSHOT_DEPTH || state.nodes >= MAX_SNAPSHOT_NODES) {
    return INVALID_SNAPSHOT;
  }
  if (weakSetHas(state.active, value)) return INVALID_SNAPSHOT;
  state.nodes += 1;
  state.depth += 1;
  weakSetAdd(state.active, value);
  try {
    if (ARRAY_IS_ARRAY(value)) {
      if (prototypeOf(value) !== ARRAY_PROTOTYPE || value.length > MAX_SNAPSHOT_ARRAY_LENGTH) {
        return INVALID_SNAPSHOT;
      }
      const keys = ownKeys(value);
      if (keys.length !== value.length + 1) return INVALID_SNAPSHOT;
      const copy: unknown[] = [];
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
        appendOwn(copy, child.value);
      }
      return { ok: true, value: copy };
    }
    const prototype = prototypeOf(value);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return INVALID_SNAPSHOT;
    const keys = ownKeys(value);
    if (keys.length > MAX_SNAPSHOT_RECORD_KEYS) return INVALID_SNAPSHOT;
    const copy = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") return INVALID_SNAPSHOT;
      const descriptor = ownDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return INVALID_SNAPSHOT;
      }
      const child = snapshotPlainData(descriptor.value, state);
      if (!child.ok) return INVALID_SNAPSHOT;
      OBJECT_DEFINE_PROPERTY(copy, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
    return { ok: true, value: copy };
  } finally {
    state.depth -= 1;
    weakSetDelete(state.active, value);
  }
}

function arrayIntrinsicsAreClean(): boolean {
  for (let index = 0; index < GUARDED_ARRAY_INTRINSICS.length; index += 1) {
    const expected = GUARDED_ARRAY_INTRINSICS[index];
    if (expected === undefined) return false;
    const descriptor = ownDescriptor(ARRAY_PROTOTYPE, expected[0]);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value !== expected[1]) {
      return false;
    }
  }
  return true;
}

function validationSnapshot(value: unknown): SnapshotResult {
  if (!arrayIntrinsicsAreClean()) return INVALID_SNAPSHOT;
  return snapshotPlainData(value, {
    depth: 0,
    nodes: 0,
    active: new WEAK_SET_CONSTRUCTOR<object>(),
  });
}

const OBSERVATION_FIELDS = OBJECT_FREEZE([
  "primitive",
  "primitiveVersion",
  "disposition",
  "reason",
] as const);
const RAW_OBSERVATION_FIELDS = OBJECT_FREEZE(["primitive", "disposition", "reason"] as const);
const RAW_REPORT_FIELDS = OBJECT_FREEZE([
  "schemaVersion",
  "nativeProtocolVersion",
  "observations",
] as const);
const PLATFORM_FIELDS = OBJECT_FREEZE([
  "os",
  "architecture",
  "runtime",
  "runtimeVersion",
  "nodeApiVersion",
] as const);
const ROOT_IDENTITY_FIELDS = OBJECT_FREEZE(["device", "file"] as const);
const FILESYSTEM_IDENTITY_FIELDS = OBJECT_FREEZE(["scope", "device", "type"] as const);
const BOUNDARY_FIELDS = OBJECT_FREEZE([
  "cli",
  "executor",
  "providerExecution",
  "hostExecution",
  "network",
  "nonTemporaryWrites",
] as const);
const NATIVE_LOADER_FIELDS = OBJECT_FREEZE(["identityBound", "disposition", "reason"] as const);
const NATIVE_ROOT_AUTHORITY_FIELDS = OBJECT_FREEZE([
  "authenticated",
  "disposition",
  "reason",
] as const);
const CAPABILITY_RECORD_FIELDS = OBJECT_FREEZE([
  "schemaVersion",
  "probeVersion",
  "state",
  "platform",
  "nativeComponentVersion",
  "nativeLoader",
  "nativeRootAuthority",
  "rootIdentity",
  "filesystemIdentity",
  "observations",
  "boundary",
] as const);

type ClosedRecord = Readonly<Record<string, unknown>>;

function strictRecord(value: unknown, fields: readonly string[]): value is ClosedRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    prototypeOf(value) !== null
  ) {
    return false;
  }
  const keys = ownKeys(value);
  if (keys.length !== fields.length) return false;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) return false;
    const descriptor = ownDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
}

function recordValue(record: ClosedRecord, field: string): unknown {
  const descriptor = ownDescriptor(record, field);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function strictArray(value: unknown, length: number): value is readonly unknown[] {
  if (!ARRAY_IS_ARRAY(value) || prototypeOf(value) !== ARRAY_PROTOTYPE || value.length !== length) {
    return false;
  }
  const keys = ownKeys(value);
  if (keys.length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDescriptor(
      value,
      callIntrinsic<string>(STRING_CONVERT, undefined, [index]),
    );
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  return true;
}

function arrayValue(values: readonly unknown[], index: number): unknown {
  const descriptor = ownDescriptor(
    values,
    callIntrinsic<string>(STRING_CONVERT, undefined, [index]),
  );
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function enumContains(value: unknown, values: readonly string[]): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function decimalString(value: unknown, signed: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;
  let index = signed && stringCharCodeAt(value, 0) === 45 ? 1 : 0;
  if (index === value.length) return false;
  for (; index < value.length; index += 1) {
    const code = stringCharCodeAt(value, index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function validatePrimitive(value: unknown): value is NativeFsPrimitive {
  return enumContains(value, NATIVE_FS_PRIMITIVES);
}

function validateDisposition(value: unknown): value is NativeFsDisposition {
  return enumContains(value, NATIVE_FS_DISPOSITIONS);
}

function validateReason(value: unknown): value is NativeFsReasonCode {
  return enumContains(value, NATIVE_FS_REASON_CODES);
}

function validateObservation(value: unknown, raw: boolean): boolean {
  const fields = raw ? RAW_OBSERVATION_FIELDS : OBSERVATION_FIELDS;
  if (!strictRecord(value, fields)) return false;
  const primitive = recordValue(value, "primitive");
  const disposition = recordValue(value, "disposition");
  const reason = recordValue(value, "reason");
  if (
    !validatePrimitive(primitive) ||
    !validateDisposition(disposition) ||
    !validateReason(reason) ||
    (!raw && recordValue(value, "primitiveVersion") !== PRIMITIVE_VERSION)
  ) {
    return false;
  }
  return disposition === "blocked";
}

function validateRawReport(value: unknown): value is NativeRawReport {
  if (
    !strictRecord(value, RAW_REPORT_FIELDS) ||
    recordValue(value, "schemaVersion") !== SCHEMA_VERSION ||
    recordValue(value, "nativeProtocolVersion") !== NATIVE_PROTOCOL_VERSION
  ) {
    return false;
  }
  const observations = recordValue(value, "observations");
  if (!strictArray(observations, NATIVE_FS_PRIMITIVES.length)) return false;
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const observation = arrayValue(observations, index);
    if (
      !validateObservation(observation, true) ||
      !strictRecord(observation, RAW_OBSERVATION_FIELDS) ||
      recordValue(observation, "primitive") !== NATIVE_FS_PRIMITIVES[index]
    ) {
      return false;
    }
  }
  return true;
}

function validatePlatform(value: unknown): boolean {
  return (
    strictRecord(value, PLATFORM_FIELDS) &&
    enumContains(recordValue(value, "os"), NODE_PLATFORMS) &&
    enumContains(recordValue(value, "architecture"), NODE_ARCHITECTURES) &&
    recordValue(value, "runtime") === "node" &&
    boundedString(recordValue(value, "runtimeVersion"), 4_096) &&
    boundedString(recordValue(value, "nodeApiVersion"), 4_096)
  );
}

function validateRootIdentity(value: unknown): boolean {
  return (
    strictRecord(value, ROOT_IDENTITY_FIELDS) &&
    decimalString(recordValue(value, "device"), false) &&
    decimalString(recordValue(value, "file"), false)
  );
}

function validateFilesystemIdentity(value: unknown): boolean {
  if (!strictRecord(value, FILESYSTEM_IDENTITY_FIELDS)) return false;
  const type = recordValue(value, "type");
  return (
    enumContains(recordValue(value, "scope"), ["filesystem", "volume"]) &&
    decimalString(recordValue(value, "device"), false) &&
    (type === "unavailable" || decimalString(type, true))
  );
}

function validateBoundary(value: unknown): boolean {
  if (!strictRecord(value, BOUNDARY_FIELDS)) return false;
  for (let index = 0; index < BOUNDARY_FIELDS.length; index += 1) {
    const field = BOUNDARY_FIELDS[index];
    if (field === undefined || recordValue(value, field) !== false) return false;
  }
  return true;
}

function validateNativeLoader(value: unknown): boolean {
  return (
    strictRecord(value, NATIVE_LOADER_FIELDS) &&
    recordValue(value, "identityBound") === false &&
    recordValue(value, "disposition") === "blocked" &&
    recordValue(value, "reason") === "native-loader-not-identity-bound"
  );
}

function validateNativeRootAuthority(value: unknown): boolean {
  return (
    strictRecord(value, NATIVE_ROOT_AUTHORITY_FIELDS) &&
    recordValue(value, "authenticated") === false &&
    recordValue(value, "disposition") === "blocked" &&
    recordValue(value, "reason") === "root-capability-unproven"
  );
}

function validateCapabilityRecord(value: unknown): value is NativeFsCapabilityRecord {
  if (
    !strictRecord(value, CAPABILITY_RECORD_FIELDS) ||
    recordValue(value, "schemaVersion") !== SCHEMA_VERSION ||
    recordValue(value, "probeVersion") !== PROBE_VERSION ||
    recordValue(value, "state") !== "blocked" ||
    recordValue(value, "nativeComponentVersion") !== NATIVE_COMPONENT_VERSION ||
    !validatePlatform(recordValue(value, "platform")) ||
    !validateNativeLoader(recordValue(value, "nativeLoader")) ||
    !validateNativeRootAuthority(recordValue(value, "nativeRootAuthority")) ||
    !validateRootIdentity(recordValue(value, "rootIdentity")) ||
    !validateFilesystemIdentity(recordValue(value, "filesystemIdentity")) ||
    !validateBoundary(recordValue(value, "boundary"))
  ) {
    return false;
  }
  const observations = recordValue(value, "observations");
  if (!strictArray(observations, NATIVE_FS_PRIMITIVES.length)) return false;
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const observation = arrayValue(observations, index);
    if (
      !validateObservation(observation, false) ||
      !strictRecord(observation, OBSERVATION_FIELDS) ||
      recordValue(observation, "primitive") !== NATIVE_FS_PRIMITIVES[index]
    ) {
      return false;
    }
  }
  const platformRecord = recordValue(value, "platform");
  const filesystemRecord = recordValue(value, "filesystemIdentity");
  if (
    !strictRecord(platformRecord, PLATFORM_FIELDS) ||
    !strictRecord(filesystemRecord, FILESYSTEM_IDENTITY_FIELDS)
  ) {
    return false;
  }
  const expectedScope = recordValue(platformRecord, "os") === "win32" ? "volume" : "filesystem";
  if (recordValue(filesystemRecord, "scope") !== expectedScope) return false;
  if (recordValue(filesystemRecord, "type") === "unavailable") {
    for (let index = 0; index < observations.length; index += 1) {
      const observation = arrayValue(observations, index);
      if (
        !strictRecord(observation, OBSERVATION_FIELDS) ||
        recordValue(observation, "disposition") !== "blocked" ||
        recordValue(observation, "reason") !== "filesystem-identity-unavailable"
      ) {
        return false;
      }
    }
  }
  return true;
}

function canonicalObservation(observation: NativeFsObservation): NativeFsObservation {
  return closedRecord<NativeFsObservation>([
    ["primitive", observation.primitive],
    ["primitiveVersion", PRIMITIVE_VERSION],
    ["disposition", observation.disposition],
    ["reason", observation.reason],
  ]);
}

function canonicalRecord(record: NativeFsCapabilityRecord): NativeFsCapabilityRecord {
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < record.observations.length; index += 1) {
    const observation = record.observations[index];
    if (observation !== undefined) appendOwn(observations, canonicalObservation(observation));
  }
  return closedRecord<NativeFsCapabilityRecord>([
    ["schemaVersion", SCHEMA_VERSION],
    ["probeVersion", PROBE_VERSION],
    ["state", record.state],
    [
      "platform",
      closedRecord<NativeFsCapabilityRecord["platform"]>([
        ["os", record.platform.os],
        ["architecture", record.platform.architecture],
        ["runtime", "node"],
        ["runtimeVersion", record.platform.runtimeVersion],
        ["nodeApiVersion", record.platform.nodeApiVersion],
      ]),
    ],
    ["nativeComponentVersion", NATIVE_COMPONENT_VERSION],
    [
      "nativeLoader",
      closedRecord<NativeFsCapabilityRecord["nativeLoader"]>([
        ["identityBound", false],
        ["disposition", "blocked"],
        ["reason", "native-loader-not-identity-bound"],
      ]),
    ],
    [
      "nativeRootAuthority",
      closedRecord<NativeFsCapabilityRecord["nativeRootAuthority"]>([
        ["authenticated", false],
        ["disposition", "blocked"],
        ["reason", "root-capability-unproven"],
      ]),
    ],
    [
      "rootIdentity",
      closedRecord<NativeFsCapabilityRecord["rootIdentity"]>([
        ["device", record.rootIdentity.device],
        ["file", record.rootIdentity.file],
      ]),
    ],
    [
      "filesystemIdentity",
      closedRecord<NativeFsCapabilityRecord["filesystemIdentity"]>([
        ["scope", record.filesystemIdentity.scope],
        ["device", record.filesystemIdentity.device],
        ["type", record.filesystemIdentity.type],
      ]),
    ],
    ["observations", observations],
    [
      "boundary",
      closedRecord<NativeFsCapabilityRecord["boundary"]>([
        ["cli", false],
        ["executor", false],
        ["providerExecution", false],
        ["hostExecution", false],
        ["network", false],
        ["nonTemporaryWrites", false],
      ]),
    ],
  ]);
}

class NativeFsClosedSchemaError extends Error {
  constructor() {
    super("native filesystem closed-schema validation failed");
    OBJECT_DEFINE_PROPERTY(this, "name", { value: "NativeFsClosedSchemaError" });
  }
}

const CLOSED_SCHEMA_ERROR = OBJECT_FREEZE(new NativeFsClosedSchemaError());
const CLOSED_SCHEMA_FAILURE_RECORD = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [
  null,
]);
OBJECT_DEFINE_PROPERTY(CLOSED_SCHEMA_FAILURE_RECORD, "success", {
  enumerable: true,
  value: false,
});
OBJECT_DEFINE_PROPERTY(CLOSED_SCHEMA_FAILURE_RECORD, "error", {
  enumerable: true,
  value: CLOSED_SCHEMA_ERROR,
});
const CLOSED_SCHEMA_FAILURE = OBJECT_FREEZE(CLOSED_SCHEMA_FAILURE_RECORD) as {
  success: false;
  error: NativeFsClosedSchemaError;
};

function closedSchemaSuccess<T>(data: T): ClosedSchemaResult<T> {
  const result = callIntrinsic<Record<string, unknown>>(OBJECT_CREATE, Object, [null]);
  OBJECT_DEFINE_PROPERTY(result, "success", { enumerable: true, value: true });
  OBJECT_DEFINE_PROPERTY(result, "data", { enumerable: true, value: data });
  return OBJECT_FREEZE(result) as ClosedSchemaResult<T>;
}

function closedSchemaFacade<T>(
  validate: (value: unknown) => boolean,
  canonicalize: (value: T) => T,
): ClosedSchemaFacade<T> {
  const safeParse = (value: unknown): ClosedSchemaResult<T> => {
    const snapshot = validationSnapshot(value);
    if (!snapshot.ok || !validate(snapshot.value)) return CLOSED_SCHEMA_FAILURE;
    return closedSchemaSuccess(canonicalize(snapshot.value as T));
  };
  const parse = (value: unknown): T => {
    const result = safeParse(value);
    if (!result.success) throw result.error;
    return result.data;
  };
  const safeParseAsync = (value: unknown): Promise<ClosedSchemaResult<T>> =>
    callIntrinsic<Promise<ClosedSchemaResult<T>>>(PROMISE_RESOLVE, PROMISE_CONSTRUCTOR, [
      safeParse(value),
    ]);
  const parseAsync = (value: unknown): Promise<T> => {
    try {
      return callIntrinsic<Promise<T>>(PROMISE_RESOLVE, PROMISE_CONSTRUCTOR, [parse(value)]);
    } catch (error) {
      return callIntrinsic<Promise<T>>(PROMISE_REJECT, PROMISE_CONSTRUCTOR, [error]);
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

export const NativeFsPrimitiveSchema = closedSchemaFacade<NativeFsPrimitive>(
  validatePrimitive,
  (value) => value,
);
export const NativeFsDispositionSchema = closedSchemaFacade<NativeFsDisposition>(
  validateDisposition,
  (value) => value,
);
export const NativeFsReasonCodeSchema = closedSchemaFacade<NativeFsReasonCode>(
  validateReason,
  (value) => value,
);
export const NativeFsObservationSchema = closedSchemaFacade<NativeFsObservation>(
  (value) => validateObservation(value, false),
  canonicalObservation,
);
export const NativeFsCapabilityRecordSchema = closedSchemaFacade<NativeFsCapabilityRecord>(
  validateCapabilityRecord,
  canonicalRecord,
);

function statRootIdentity(root: string): RootIdentity | undefined {
  try {
    const stat = lstatSync(root, { bigint: true });
    if ((stat.mode & 0o170000n) !== 0o040000n || stat.nlink < 1n) return undefined;
    return { device: stat.dev, file: stat.ino, mode: stat.mode };
  } catch {
    return undefined;
  }
}

function descriptorIdentity(descriptor: number | undefined): RootIdentity | undefined {
  if (descriptor === undefined) return undefined;
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if ((stat.mode & 0o170000n) !== 0o040000n) return undefined;
    return { device: stat.dev, file: stat.ino, mode: stat.mode };
  } catch {
    return undefined;
  }
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity | undefined): boolean {
  return right !== undefined && left.device === right.device && left.file === right.file;
}

function rootFailureReason(metadata: CapabilityMetadata): NativeFsReasonCode | undefined {
  const pathIdentity = statRootIdentity(metadata.root);
  if (!sameRootIdentity(metadata.identity, pathIdentity)) return "root-identity-drift";
  if (
    metadata.rootDescriptor !== undefined &&
    !sameRootIdentity(metadata.identity, descriptorIdentity(metadata.rootDescriptor))
  ) {
    return "root-identity-drift";
  }
  if (
    platform() !== "win32" &&
    pathIdentity !== undefined &&
    (pathIdentity.mode & 0o777n) !== 0o700n
  ) {
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
    type = bigintString(statfsSync(root, { bigint: true }).type);
  } catch {
    // Unavailable identity is represented explicitly and blocks every primitive.
  }
  return {
    scope: platform() === "win32" ? "volume" : "filesystem",
    device: bigintString(identity.device),
    type,
  };
}

function sameFilesystemIdentity(
  left: NativeFsCapabilityRecord["filesystemIdentity"],
  right: NativeFsCapabilityRecord["filesystemIdentity"],
): boolean {
  return left.scope === right.scope && left.device === right.device && left.type === right.type;
}

function filesystemFailureReason(metadata: CapabilityMetadata): NativeFsReasonCode | undefined {
  const currentRoot = statRootIdentity(metadata.root);
  if (currentRoot === undefined) return "root-identity-drift";
  const current = filesystemIdentity(metadata.root, currentRoot);
  if (current.type === "unavailable") return "filesystem-identity-unavailable";
  return sameFilesystemIdentity(metadata.filesystemIdentity, current)
    ? undefined
    : "filesystem-identity-drift";
}

function openRootDescriptor(root: string): number | undefined {
  try {
    const directory = "O_DIRECTORY" in fsConstants ? fsConstants.O_DIRECTORY : 0;
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    return openSync(root, fsConstants.O_RDONLY | directory | noFollow);
  } catch {
    return undefined;
  }
}

function disposeCapability(capability: object, metadata: CapabilityMetadata): void {
  weakSetDelete(CAPABILITIES, capability);
  weakMapDelete(CAPABILITY_METADATA, capability);
  if (metadata.rootDescriptor !== undefined) {
    try {
      closeSync(metadata.rootDescriptor);
    } catch {
      // Authority is already irrevocably revoked; disposal never falls back to a pathname action.
    }
  }
}

export function createNativeFsProbeCapability(): NativeFsProbeCapability {
  const tempRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempRoot, CAPABILITY_PREFIX));
  const identity = statRootIdentity(root);
  const rootDescriptor = openRootDescriptor(root);
  if (identity === undefined || !underTempRoot(root, tempRoot)) {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
    throw new Error("failed to mint a private temporary-root capability");
  }
  let capability: NativeFsProbeCapability;
  const dispose = () => {
    const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
    if (metadata !== undefined && weakSetHas(CAPABILITIES, capability as object)) {
      disposeCapability(capability as object, metadata);
    }
  };
  capability = OBJECT_FREEZE(
    closedRecord<NativeFsProbeCapability>([
      ["root", root],
      ["dispose", dispose],
    ]),
  );
  const metadata = {
    root,
    tempRoot,
    rootDescriptor,
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
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  const keys = ownKeys(options);
  if (keys.length > 1) throw new TypeError("native filesystem probe options must be closed data");
  if (keys.length === 0) return EXPECTED_ADDON_PATH;
  if (keys[0] !== "addonPath") {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  const descriptor = ownDescriptor(options, "addonPath");
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError("native filesystem probe options must be closed data");
  }
  if (descriptor.value !== EXPECTED_ADDON_PATH) {
    throw new TypeError("addon path must be the canonical module-relative native addon");
  }
  return EXPECTED_ADDON_PATH;
}

function hashBytes(bytes: Buffer): string {
  const hash = createHash("sha256");
  callIntrinsic(HASH_UPDATE, hash, [bytes]);
  return callIntrinsic<string>(HASH_DIGEST, hash, ["hex"]);
}

function sameArtifact(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return (
    left.device === right.device &&
    left.file === right.file &&
    left.size === right.size &&
    left.links === right.links &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.digest === right.digest
  );
}

function captureArtifact(path: string): ArtifactCapture {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path, { bigint: true });
  } catch {
    return { state: "unavailable" };
  }
  try {
    if ((before.mode & 0o170000n) !== 0o100000n || before.nlink < 1n || before.nlink > 2n) {
      return { state: "invalid" };
    }
    if (before.nlink === 2n) {
      const buildLink = lstatSync(EXPECTED_ADDON_BUILD_LINK, { bigint: true });
      if (
        (buildLink.mode & 0o170000n) !== 0o100000n ||
        buildLink.dev !== before.dev ||
        buildLink.ino !== before.ino
      ) {
        return { state: "invalid" };
      }
    }
    if (before.size > BigInt(MAX_NATIVE_ADDON_BYTES)) return { state: "oversized" };
    const digest = hashBytes(readFileSync(path));
    const after = lstatSync(path, { bigint: true });
    const identity = {
      device: before.dev,
      file: before.ino,
      size: before.size,
      links: before.nlink,
      modified: before.mtimeNs,
      changed: before.ctimeNs,
      digest,
    };
    const afterIdentity = {
      device: after.dev,
      file: after.ino,
      size: after.size,
      links: after.nlink,
      modified: after.mtimeNs,
      changed: after.ctimeNs,
      digest,
    };
    return sameArtifact(identity, afterIdentity)
      ? { state: "ready", identity }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function addonPathIsContained(): boolean {
  const expected = join(
    REPOSITORY_NATIVE_ROOT,
    "methodology-fs",
    "build",
    "Release",
    "methodology_fs.node",
  );
  const child = relative(REPOSITORY_NATIVE_ROOT, EXPECTED_ADDON_PATH);
  return (
    EXPECTED_ADDON_PATH === expected &&
    child.length > 0 &&
    child !== ".." &&
    !stringStartsWith(child, `..${sep}`) &&
    !isAbsolute(child)
  );
}

function captureAncestorChain(): readonly AncestorIdentity[] | undefined {
  if (!addonPathIsContained()) return undefined;
  const ancestors: AncestorIdentity[] = [];
  try {
    for (let index = 0; index < EXPECTED_ADDON_ANCESTORS.length; index += 1) {
      const path = EXPECTED_ADDON_ANCESTORS[index];
      if (path === undefined) return undefined;
      const identity = lstatSync(path, { bigint: true });
      if ((identity.mode & 0o170000n) !== 0o040000n || resolve(realpathSync(path)) !== path) {
        return undefined;
      }
      appendOwn(ancestors, {
        path,
        device: identity.dev,
        file: identity.ino,
        mode: identity.mode,
      });
    }
  } catch {
    return undefined;
  }
  return ancestors;
}

function sameAncestorChain(
  left: readonly AncestorIdentity[],
  right: readonly AncestorIdentity[] | undefined,
): boolean {
  if (right === undefined || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftIdentity = left[index];
    const rightIdentity = right[index];
    if (
      leftIdentity === undefined ||
      rightIdentity === undefined ||
      leftIdentity.path !== rightIdentity.path ||
      leftIdentity.device !== rightIdentity.device ||
      leftIdentity.file !== rightIdentity.file ||
      leftIdentity.mode !== rightIdentity.mode
    ) {
      return false;
    }
  }
  return true;
}

function cacheIsOwned(): boolean {
  return require.cache === OWNED_REQUIRE_CACHE && !isProxy(OWNED_REQUIRE_CACHE);
}

function cacheDescriptor(): PropertyDescriptor | undefined {
  if (!cacheIsOwned()) return undefined;
  return ownDescriptor(OWNED_REQUIRE_CACHE, EXPECTED_ADDON_PATH);
}

function cacheEntry(): NodeModule | undefined {
  const descriptor = cacheDescriptor();
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
    return undefined;
  }
  if (
    descriptor.value === null ||
    typeof descriptor.value !== "object" ||
    isProxy(descriptor.value)
  ) {
    return undefined;
  }
  return descriptor.value as NodeModule;
}

function exportsProbe(exportsValue: unknown): CallableFunction | undefined {
  if (exportsValue === null || typeof exportsValue !== "object" || isProxy(exportsValue)) {
    return undefined;
  }
  const keys = ownKeys(exportsValue);
  const descriptor = ownDescriptor(exportsValue, "probe");
  return keys.length === 1 &&
    keys[0] === "probe" &&
    descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "function"
    ? descriptor.value
    : undefined;
}

function loadOwnedAddon():
  | "ready"
  | "unavailable"
  | "load-failed"
  | "abi-mismatch"
  | "ancestor-invalid"
  | "oversized" {
  if (ownedAddon !== undefined) {
    const currentAncestors = captureAncestorChain();
    if (!sameAncestorChain(ownedAddon.ancestors, currentAncestors)) return "ancestor-invalid";
    return validateOwnedAddon() ? "ready" : "abi-mismatch";
  }
  if (!cacheIsOwned()) return "abi-mismatch";
  const ancestorsBefore = captureAncestorChain();
  if (ancestorsBefore === undefined) return "ancestor-invalid";
  const artifactBefore = captureArtifact(EXPECTED_ADDON_PATH);
  if (artifactBefore.state === "unavailable") return "unavailable";
  if (artifactBefore.state === "oversized") return "oversized";
  if (artifactBefore.state !== "ready") return "load-failed";
  if (cacheDescriptor() !== undefined) return "abi-mismatch";
  let exportsValue: unknown;
  try {
    exportsValue = require(EXPECTED_ADDON_PATH);
  } catch {
    return "load-failed";
  }
  const ancestorsAfter = captureAncestorChain();
  const artifactAfter = captureArtifact(EXPECTED_ADDON_PATH);
  const loadedModule = cacheEntry();
  const probe = exportsProbe(exportsValue);
  if (!sameAncestorChain(ancestorsBefore, ancestorsAfter)) {
    return "ancestor-invalid";
  }
  if (
    artifactAfter.state !== "ready" ||
    !sameArtifact(artifactBefore.identity, artifactAfter.identity) ||
    loadedModule === undefined ||
    probe === undefined
  ) {
    return "abi-mismatch";
  }
  const moduleExports = ownDescriptor(loadedModule, "exports");
  if (
    moduleExports === undefined ||
    !("value" in moduleExports) ||
    moduleExports.value !== exportsValue
  ) {
    return "abi-mismatch";
  }
  try {
    OBJECT_FREEZE(exportsValue as object);
  } catch {
    return "abi-mismatch";
  }
  ownedAddon = {
    module: loadedModule,
    exports: exportsValue as object,
    probe,
    artifact: artifactBefore.identity,
    ancestors: ancestorsBefore,
  };
  return validateOwnedAddon() ? "ready" : "abi-mismatch";
}

function validateOwnedAddon(): boolean {
  const artifact = captureArtifact(EXPECTED_ADDON_PATH);
  if (
    ownedAddon === undefined ||
    !cacheIsOwned() ||
    artifact.state !== "ready" ||
    !sameArtifact(ownedAddon.artifact, artifact.identity) ||
    !sameAncestorChain(ownedAddon.ancestors, captureAncestorChain())
  ) {
    return false;
  }
  if (cacheEntry() !== ownedAddon.module) return false;
  const moduleExports = ownDescriptor(ownedAddon.module, "exports");
  if (
    moduleExports === undefined ||
    !("value" in moduleExports) ||
    moduleExports.value !== ownedAddon.exports
  ) {
    return false;
  }
  if (!callIntrinsic<boolean>(OBJECT_IS_FROZEN, Object, [ownedAddon.exports])) return false;
  const probe = exportsProbe(ownedAddon.exports);
  if (probe !== ownedAddon.probe) return false;
  const descriptor = ownDescriptor(ownedAddon.exports, "probe");
  return descriptor?.writable === false && descriptor.configurable === false;
}

function currentPlatform(): NativeFsCapabilityRecord["platform"] {
  return closedRecord<NativeFsCapabilityRecord["platform"]>([
    ["os", platform()],
    ["architecture", arch()],
    ["runtime", "node"],
    ["runtimeVersion", process.versions.node],
    ["nodeApiVersion", process.versions.napi ?? "unavailable"],
  ]);
}

function blockedObservations(reason: NativeFsReasonCode): NativeFsObservation[] {
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const primitive = NATIVE_FS_PRIMITIVES[index];
    if (primitive !== undefined) {
      appendOwn(
        observations,
        canonicalObservation({
          primitive,
          primitiveVersion: PRIMITIVE_VERSION,
          disposition: "blocked",
          reason,
        }),
      );
    }
  }
  return observations;
}

function recordFor(
  metadata: CapabilityMetadata,
  observations: NativeFsObservation[],
): NativeFsCapabilityRecord {
  return closedRecord<NativeFsCapabilityRecord>([
    ["schemaVersion", SCHEMA_VERSION],
    ["probeVersion", PROBE_VERSION],
    ["state", "blocked"],
    ["platform", currentPlatform()],
    ["nativeComponentVersion", NATIVE_COMPONENT_VERSION],
    [
      "nativeLoader",
      closedRecord<NativeFsCapabilityRecord["nativeLoader"]>([
        ["identityBound", false],
        ["disposition", "blocked"],
        ["reason", "native-loader-not-identity-bound"],
      ]),
    ],
    [
      "nativeRootAuthority",
      closedRecord<NativeFsCapabilityRecord["nativeRootAuthority"]>([
        ["authenticated", false],
        ["disposition", "blocked"],
        ["reason", "root-capability-unproven"],
      ]),
    ],
    [
      "rootIdentity",
      closedRecord<NativeFsCapabilityRecord["rootIdentity"]>([
        ["device", bigintString(metadata.identity.device)],
        ["file", bigintString(metadata.identity.file)],
      ]),
    ],
    [
      "filesystemIdentity",
      closedRecord<NativeFsCapabilityRecord["filesystemIdentity"]>([
        ["scope", metadata.filesystemIdentity.scope],
        ["device", metadata.filesystemIdentity.device],
        ["type", metadata.filesystemIdentity.type],
      ]),
    ],
    ["observations", observations],
    [
      "boundary",
      closedRecord<NativeFsCapabilityRecord["boundary"]>([
        ["cli", false],
        ["executor", false],
        ["providerExecution", false],
        ["hostExecution", false],
        ["network", false],
        ["nonTemporaryWrites", false],
      ]),
    ],
  ]);
}

function blockedRecord(
  metadata: CapabilityMetadata,
  reason: NativeFsReasonCode,
): NativeFsCapabilityRecord {
  return recordFor(metadata, blockedObservations(reason));
}

function parseNativeReport(raw: unknown, metadata: CapabilityMetadata): NativeFsCapabilityRecord {
  if (typeof raw !== "string") return blockedRecord(metadata, "native-report-invalid");
  if (callIntrinsic<number>(BUFFER_BYTE_LENGTH, Buffer, [raw, "utf8"]) > MAX_NATIVE_REPORT_BYTES) {
    return blockedRecord(metadata, "native-report-oversized");
  }
  let parsed: unknown;
  try {
    parsed = callIntrinsic<unknown>(JSON_PARSE, JSON, [raw]);
  } catch {
    return blockedRecord(metadata, "native-report-invalid");
  }
  const snapshot = validationSnapshot(parsed);
  if (!snapshot.ok) return blockedRecord(metadata, "native-report-invalid");
  if (!validateRawReport(snapshot.value)) return blockedRecord(metadata, "native-report-invalid");
  const result = snapshot.value;
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < result.observations.length; index += 1) {
    const observation = arrayValue(result.observations, index) as NativeRawObservation | undefined;
    if (observation !== undefined) {
      appendOwn(
        observations,
        canonicalObservation({
          primitive: observation.primitive,
          primitiveVersion: PRIMITIVE_VERSION,
          disposition: observation.disposition,
          reason: observation.reason,
        }),
      );
    }
  }
  return recordFor(metadata, observations);
}

export function probeNativeFilesystem(
  capability: NativeFsProbeCapability,
  options?: Readonly<{ addonPath?: string }>,
): NativeFsCapabilityRecord {
  const metadata = capabilityMetadata(capability);
  validatedAddonPath(options);
  if (!arrayIntrinsicsAreClean()) {
    return blockedRecord(metadata, "native-operation-failed");
  }
  if (!underTempRoot(metadata.root, metadata.tempRoot)) {
    return blockedRecord(metadata, "root-outside-temporary-directory");
  }
  const initialRootFailure = rootFailureReason(metadata);
  if (initialRootFailure !== undefined) return blockedRecord(metadata, initialRootFailure);
  const initialFilesystemFailure = filesystemFailureReason(metadata);
  if (initialFilesystemFailure !== undefined) {
    return blockedRecord(metadata, initialFilesystemFailure);
  }
  const loadState = loadOwnedAddon();
  if (loadState === "unavailable") return blockedRecord(metadata, "native-addon-unavailable");
  if (loadState === "load-failed") return blockedRecord(metadata, "native-addon-load-failed");
  if (loadState === "ancestor-invalid") {
    return blockedRecord(metadata, "native-addon-ancestor-invalid");
  }
  if (loadState === "oversized") return blockedRecord(metadata, "native-addon-oversized");
  if (loadState !== "ready" || ownedAddon === undefined) {
    return blockedRecord(metadata, "native-addon-abi-mismatch");
  }
  const owned = ownedAddon;
  let raw: unknown;
  try {
    raw = callIntrinsic<unknown>(owned.probe, undefined, [metadata.root]);
  } catch {
    return blockedRecord(metadata, "native-operation-failed");
  }
  if (!validateOwnedAddon()) return blockedRecord(metadata, "native-addon-abi-mismatch");
  const finalRootFailure = rootFailureReason(metadata);
  if (finalRootFailure !== undefined) return blockedRecord(metadata, finalRootFailure);
  const finalFilesystemFailure = filesystemFailureReason(metadata);
  if (finalFilesystemFailure !== undefined) return blockedRecord(metadata, finalFilesystemFailure);
  return parseNativeReport(raw, metadata);
}
