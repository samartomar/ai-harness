import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statfsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, platform, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isProxy } from "node:util/types";
import { z } from "zod";

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
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const WEAK_SET_HAS = WeakSet.prototype.has;
const STRING_STARTS_WITH = String.prototype.startsWith;
const JSON_PARSE = JSON.parse;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const STRING_CONVERT = String;
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
const PRIMITIVE_VERSION = "phase-4a-primitive-v1" as const;
const MAX_NATIVE_REPORT_BYTES = 65_536;
const MAX_SNAPSHOT_ARRAY_LENGTH = 16;
const MAX_SNAPSHOT_RECORD_KEYS = 16;
const MAX_SNAPSHOT_DEPTH = 8;
const MAX_SNAPSHOT_NODES = 128;
const CAPABILITY_PREFIX = "aih-methodology-native-fs-";
const require = createRequire(import.meta.url);
const OWNED_REQUIRE_CACHE = require.cache;
const EXPECTED_ADDON_PATH = fileURLToPath(
  new URL("../../native/methodology-fs/build/Release/methodology_fs.node", import.meta.url),
);
const EXPECTED_ADDON_BUILD_LINK = fileURLToPath(
  new URL(
    "../../native/methodology-fs/build/Release/obj.target/methodology_fs.node",
    import.meta.url,
  ),
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
const UNSUPPORTED_REASONS = Object.freeze([
  "identity-bound-file-publication-unavailable",
  "no-replace-directory-publication-unavailable",
  "identity-bound-file-detachment-unavailable",
  "identity-bound-directory-detachment-unavailable",
  "parent-directory-durability-unavailable",
  "link-and-volume-containment-unavailable",
  "substitution-resistance-unavailable",
] as const);
const BLOCKED_REASONS = Object.freeze([
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
  "containment-unproven",
  "substitution-resistance-unproven",
  "source-identity-drift",
  "destination-canary-changed",
  "cross-volume-operation",
  "symlink-detected",
  "hard-link-detected",
  "reparse-point-detected",
] as const);
const NATIVE_FS_REASON_CODES = Object.freeze([
  "primitive-qualified",
  ...UNSUPPORTED_REASONS,
  ...BLOCKED_REASONS,
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
type OwnedAddon = {
  readonly module: NodeModule;
  readonly exports: object;
  readonly probe: CallableFunction;
  readonly artifact: ArtifactIdentity;
};
type SnapshotState = { depth: number; nodes: number; active: WeakSet<object> };
type SnapshotResult = { ok: true; value: unknown } | { ok: false };
type ClosedZodResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: z.ZodError };
type ClosedZodFacade<T> = {
  decode(value: unknown): T;
  decodeAsync(value: unknown): Promise<T>;
  parse(value: unknown): T;
  parseAsync(value: unknown): Promise<T>;
  safeDecode(value: unknown): ClosedZodResult<T>;
  safeDecodeAsync(value: unknown): Promise<ClosedZodResult<T>>;
  safeParse(value: unknown): ClosedZodResult<T>;
  safeParseAsync(value: unknown): Promise<ClosedZodResult<T>>;
  spa(value: unknown): Promise<ClosedZodResult<T>>;
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

function copyOwnValues<T>(values: readonly T[]): T[] {
  const copy: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = ownDescriptor(
      values,
      callIntrinsic<string>(STRING_CONVERT, undefined, [index]),
    );
    if (descriptor !== undefined && "value" in descriptor) appendOwn(copy, descriptor.value);
  }
  return copy;
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

function bigintString(value: bigint): string {
  return callIntrinsic<string>(BIGINT_TO_STRING, value, [10]);
}

function stringStartsWith(value: string, prefix: string): boolean {
  return callIntrinsic<boolean>(STRING_STARTS_WITH, value, [prefix]);
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
  return snapshotPlainData(value, { depth: 0, nodes: 0, active: new WeakSet<object>() });
}

function unsupportedReason(primitive: NativeFsPrimitive): NativeFsReasonCode {
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    if (NATIVE_FS_PRIMITIVES[index] === primitive) {
      const reason = UNSUPPORTED_REASONS[index];
      if (reason !== undefined) return reason;
    }
  }
  return "native-report-invalid";
}

function isUnsupportedReason(reason: NativeFsReasonCode): boolean {
  for (let index = 0; index < UNSUPPORTED_REASONS.length; index += 1) {
    if (UNSUPPORTED_REASONS[index] === reason) return true;
  }
  return false;
}

const NativeFsPrimitiveZodSchema = z.enum(NATIVE_FS_PRIMITIVES);
const NativeFsDispositionZodSchema = z.enum(NATIVE_FS_DISPOSITIONS);
const NativeFsReasonCodeZodSchema = z.enum(NATIVE_FS_REASON_CODES);
const NativeFsObservationZodSchema = z
  .strictObject({
    primitive: NativeFsPrimitiveZodSchema,
    primitiveVersion: z.literal(PRIMITIVE_VERSION),
    disposition: NativeFsDispositionZodSchema,
    reason: NativeFsReasonCodeZodSchema,
  })
  .superRefine((observation, context) => {
    const expected =
      observation.disposition === "supported"
        ? "primitive-qualified"
        : observation.disposition === "unsupported"
          ? unsupportedReason(observation.primitive)
          : undefined;
    if (
      (expected !== undefined && observation.reason !== expected) ||
      (observation.disposition === "blocked" &&
        (observation.reason === "primitive-qualified" || isUnsupportedReason(observation.reason)))
    ) {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is not bound" });
    }
  });
const PlatformZodSchema = z.strictObject({
  os: z.enum(NODE_PLATFORMS),
  architecture: z.enum(NODE_ARCHITECTURES),
  runtime: z.literal("node"),
  runtimeVersion: z.string().min(1).max(4_096),
  nodeApiVersion: z.string().min(1).max(4_096),
});
const RootIdentityZodSchema = z.strictObject({
  device: z
    .string()
    .regex(/^[0-9]+$/)
    .max(128),
  file: z
    .string()
    .regex(/^[0-9]+$/)
    .max(128),
});
const FilesystemIdentityZodSchema = z.strictObject({
  scope: z.enum(["filesystem", "volume"]),
  device: z
    .string()
    .regex(/^[0-9]+$/)
    .max(128),
  type: z.union([
    z
      .string()
      .regex(/^-?[0-9]+$/)
      .max(128),
    z.literal("unavailable"),
  ]),
});
const BoundaryZodSchema = z.strictObject({
  cli: z.literal(false),
  executor: z.literal(false),
  providerExecution: z.literal(false),
  hostExecution: z.literal(false),
  network: z.literal(false),
  nonTemporaryWrites: z.literal(false),
});
const NativeFsCapabilityRecordZodSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    probeVersion: z.literal(PROBE_VERSION),
    state: NativeFsDispositionZodSchema,
    platform: PlatformZodSchema,
    nativeComponentVersion: z.literal(NATIVE_COMPONENT_VERSION),
    rootIdentity: RootIdentityZodSchema,
    filesystemIdentity: FilesystemIdentityZodSchema,
    observations: z.array(NativeFsObservationZodSchema).length(NATIVE_FS_PRIMITIVES.length),
    boundary: BoundaryZodSchema,
  })
  .superRefine((record, context) => {
    let expectedState: NativeFsDisposition = "supported";
    for (let index = 0; index < record.observations.length; index += 1) {
      const observation = record.observations[index];
      if (observation?.primitive !== NATIVE_FS_PRIMITIVES[index]) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "primitive"],
          message: "primitive order is fixed",
        });
      }
      if (observation?.disposition === "blocked") expectedState = "blocked";
      else if (observation?.disposition === "unsupported" && expectedState === "supported") {
        expectedState = "unsupported";
      }
    }
    if (record.state !== expectedState) {
      context.addIssue({ code: "custom", path: ["state"], message: "state does not match" });
    }
    if (
      record.filesystemIdentity.type === "unavailable" &&
      (record.state !== "blocked" ||
        record.observations.some(
          (observation) =>
            observation.disposition !== "blocked" ||
            observation.reason !== "filesystem-identity-unavailable",
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["filesystemIdentity", "type"],
        message: "unavailable identity must block every primitive",
      });
    }
    const expectedScope = record.platform.os === "win32" ? "volume" : "filesystem";
    if (record.filesystemIdentity.scope !== expectedScope) {
      context.addIssue({
        code: "custom",
        path: ["filesystemIdentity", "scope"],
        message: "filesystem scope does not match platform",
      });
    }
  });

function canonicalObservation(observation: NativeFsObservation): NativeFsObservation {
  return {
    primitive: observation.primitive,
    primitiveVersion: PRIMITIVE_VERSION,
    disposition: observation.disposition,
    reason: observation.reason,
  };
}

function canonicalRecord(record: NativeFsCapabilityRecord): NativeFsCapabilityRecord {
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < record.observations.length; index += 1) {
    const observation = record.observations[index];
    if (observation !== undefined) appendOwn(observations, canonicalObservation(observation));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    probeVersion: PROBE_VERSION,
    state: record.state,
    platform: {
      os: record.platform.os,
      architecture: record.platform.architecture,
      runtime: "node",
      runtimeVersion: record.platform.runtimeVersion,
      nodeApiVersion: record.platform.nodeApiVersion,
    },
    nativeComponentVersion: NATIVE_COMPONENT_VERSION,
    rootIdentity: { device: record.rootIdentity.device, file: record.rootIdentity.file },
    filesystemIdentity: {
      scope: record.filesystemIdentity.scope,
      device: record.filesystemIdentity.device,
      type: record.filesystemIdentity.type,
    },
    observations,
    boundary: {
      cli: false,
      executor: false,
      providerExecution: false,
      hostExecution: false,
      network: false,
      nonTemporaryWrites: false,
    },
  };
}

function closedZodFacade<T>(
  schema: z.ZodType<T>,
  canonicalize: (value: T) => T,
): ClosedZodFacade<T> {
  const invalidResult = schema.safeParse(undefined);
  if (invalidResult.success) throw new TypeError("closed schema must reject undefined");
  const safeParse = (value: unknown): ClosedZodResult<T> => {
    const snapshot = validationSnapshot(value);
    if (!snapshot.ok) return invalidResult;
    const parsed = schema.safeParse(snapshot.value);
    return parsed.success
      ? { success: true as const, data: canonicalize(parsed.data) }
      : { success: false as const, error: parsed.error };
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

export const NativeFsPrimitiveSchema = closedZodFacade(
  NativeFsPrimitiveZodSchema,
  (value) => value,
);
export const NativeFsDispositionSchema = closedZodFacade(
  NativeFsDispositionZodSchema,
  (value) => value,
);
export const NativeFsReasonCodeSchema = closedZodFacade(
  NativeFsReasonCodeZodSchema,
  (value) => value,
);
export const NativeFsObservationSchema = closedZodFacade(
  NativeFsObservationZodSchema,
  canonicalObservation,
);
export const NativeFsCapabilityRecordSchema = closedZodFacade(
  NativeFsCapabilityRecordZodSchema,
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
  if (rootFailureReason(metadata) !== undefined) return;
  try {
    rmdirSync(metadata.root);
  } catch {
    return;
  }
  const authentic = descriptorIdentity(metadata.rootDescriptor);
  const pathGone = statRootIdentity(metadata.root) === undefined;
  const descriptorConfirmsRemoval =
    metadata.rootDescriptor === undefined ||
    (sameRootIdentity(metadata.identity, authentic) &&
      (platform() === "win32" ||
        fstatSync(metadata.rootDescriptor, { bigint: true }).nlink === 0n));
  if (!pathGone || !descriptorConfirmsRemoval) return;
  if (metadata.rootDescriptor !== undefined) closeSync(metadata.rootDescriptor);
  weakSetDelete(CAPABILITIES, capability);
}

export function createNativeFsProbeCapability(): NativeFsProbeCapability {
  const tempRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempRoot, CAPABILITY_PREFIX));
  chmodSync(root, 0o700);
  const identity = statRootIdentity(root);
  if (identity === undefined || !underTempRoot(root, tempRoot)) {
    try {
      rmdirSync(root);
    } catch {
      // The failed mint remains confined to the operating-system temporary root.
    }
    throw new Error("failed to mint a private temporary-root capability");
  }
  const rootDescriptor = openRootDescriptor(root);
  let capability: NativeFsProbeCapability;
  const dispose = () => {
    const metadata = weakMapGet(CAPABILITY_METADATA, capability as object);
    if (metadata !== undefined && weakSetHas(CAPABILITIES, capability as object)) {
      disposeCapability(capability as object, metadata);
    }
  };
  capability = OBJECT_FREEZE({ root, dispose });
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

function sameArtifact(left: ArtifactIdentity, right: ArtifactIdentity | undefined): boolean {
  return (
    right !== undefined &&
    left.device === right.device &&
    left.file === right.file &&
    left.size === right.size &&
    left.links === right.links &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.digest === right.digest
  );
}

function captureArtifact(path: string): ArtifactIdentity | undefined {
  try {
    const before = lstatSync(path, { bigint: true });
    if ((before.mode & 0o170000n) !== 0o100000n || before.nlink < 1n || before.nlink > 2n) {
      return undefined;
    }
    if (before.nlink === 2n) {
      const buildLink = lstatSync(EXPECTED_ADDON_BUILD_LINK, { bigint: true });
      if (
        (buildLink.mode & 0o170000n) !== 0o100000n ||
        buildLink.dev !== before.dev ||
        buildLink.ino !== before.ino
      ) {
        return undefined;
      }
    }
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
    return sameArtifact(identity, afterIdentity) ? identity : undefined;
  } catch {
    return undefined;
  }
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

function loadOwnedAddon(): "ready" | "unavailable" | "load-failed" | "abi-mismatch" {
  if (ownedAddon !== undefined) return validateOwnedAddon() ? "ready" : "abi-mismatch";
  if (!cacheIsOwned()) return "abi-mismatch";
  const artifactBefore = captureArtifact(EXPECTED_ADDON_PATH);
  if (artifactBefore === undefined) {
    try {
      lstatSync(EXPECTED_ADDON_PATH);
      return "load-failed";
    } catch {
      return "unavailable";
    }
  }
  if (cacheDescriptor() !== undefined) return "abi-mismatch";
  let exportsValue: unknown;
  try {
    exportsValue = require(EXPECTED_ADDON_PATH);
  } catch {
    return "load-failed";
  }
  const artifactAfter = captureArtifact(EXPECTED_ADDON_PATH);
  const loadedModule = cacheEntry();
  const probe = exportsProbe(exportsValue);
  if (
    !sameArtifact(artifactBefore, artifactAfter) ||
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
    artifact: artifactBefore,
  };
  return validateOwnedAddon() ? "ready" : "abi-mismatch";
}

function validateOwnedAddon(): boolean {
  if (
    ownedAddon === undefined ||
    !cacheIsOwned() ||
    !sameArtifact(ownedAddon.artifact, captureArtifact(EXPECTED_ADDON_PATH))
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
  return {
    os: platform(),
    architecture: arch(),
    runtime: "node",
    runtimeVersion: process.versions.node,
    nodeApiVersion: process.versions.napi ?? "unavailable",
  };
}

function blockedObservations(reason: NativeFsReasonCode): NativeFsObservation[] {
  const observations: NativeFsObservation[] = [];
  for (let index = 0; index < NATIVE_FS_PRIMITIVES.length; index += 1) {
    const primitive = NATIVE_FS_PRIMITIVES[index];
    if (primitive !== undefined) {
      appendOwn(observations, {
        primitive,
        primitiveVersion: PRIMITIVE_VERSION,
        disposition: "blocked",
        reason,
      });
    }
  }
  return observations;
}

function dispositionFor(observations: readonly NativeFsObservation[]): NativeFsDisposition {
  let disposition: NativeFsDisposition = "supported";
  for (let index = 0; index < observations.length; index += 1) {
    if (observations[index]?.disposition === "blocked") return "blocked";
    if (observations[index]?.disposition === "unsupported") disposition = "unsupported";
  }
  return disposition;
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
      device: bigintString(metadata.identity.device),
      file: bigintString(metadata.identity.file),
    },
    filesystemIdentity: {
      scope: metadata.filesystemIdentity.scope,
      device: metadata.filesystemIdentity.device,
      type: metadata.filesystemIdentity.type,
    },
    observations,
    boundary: {
      cli: false,
      executor: false,
      providerExecution: false,
      hostExecution: false,
      network: false,
      nonTemporaryWrites: false,
    },
  };
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
    record.platform.runtimeVersion !== expectedPlatform.runtimeVersion ||
    record.platform.nodeApiVersion !== expectedPlatform.nodeApiVersion ||
    record.rootIdentity.device !== bigintString(metadata.identity.device) ||
    record.rootIdentity.file !== bigintString(metadata.identity.file) ||
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
  validatedAddonPath(options);
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
