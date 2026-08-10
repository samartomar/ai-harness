import { isProxy } from "node:util/types";
import type { SkillPackageGraphDiagnostic } from "../package-graph/adapters/skills.js";
import type { DeepReadonly, PackageGraphIndex } from "../package-graph/build.js";
import { codeUnitCompare } from "../package-graph/canonical.js";
import { type PackageId, PackageIdSchema } from "../package-graph/schema.js";
import {
  CapabilityPackageSkillPackError,
  type CapabilityPackageSkillPackErrorCode,
  resolveSkillPackAuthorityBindings,
} from "./domains/skill-pack.js";
import { parseCapabilityPackageIntentBytes } from "./intent.js";
import {
  type CapabilityPackageOwnershipPackage,
  type CapabilityPackageOwnershipReceipt,
  parseCapabilityPackageOwnershipReceipt,
  serializeCapabilityPackageOwnershipReceipt,
} from "./receipt.js";
import {
  CapabilityPackageResolutionError,
  type CapabilityPackageResolutionErrorCode,
  resolveCapabilityPackages,
} from "./resolve.js";

export interface CapabilityPackageLifecycleChanges {
  add: PackageId[];
  update: PackageId[];
  remove: PackageId[];
  unchanged: PackageId[];
}

export type CapabilityPackageLifecycleRefusal =
  | { stage: "intent"; code: "invalid-intent" }
  | { stage: "receipt"; code: "invalid-current-receipt" }
  | { stage: "resolution"; code: CapabilityPackageResolutionErrorCode }
  | { stage: "skill-pack"; code: CapabilityPackageSkillPackErrorCode }
  | { stage: "receipt"; code: "invalid-desired-receipt" }
  | {
      stage: "operation";
      code: "invalid-removal" | "unknown-root" | "current-state-mismatch";
    };

export interface CapabilityPackageLifecycleDesiredReceipt {
  receipt: CapabilityPackageOwnershipReceipt;
  serialized: string;
}

export interface CapabilityPackageLifecycleDesiredIntent {
  bytes: number[];
  sha256: string;
}

interface CapabilityPackageLifecycleBase {
  schemaVersion: 1;
  changes: CapabilityPackageLifecycleChanges;
  refusals: CapabilityPackageLifecycleRefusal[];
}

export interface CapabilityPackageLifecycleReady extends CapabilityPackageLifecycleBase {
  status: "ready";
  desiredIntent?: CapabilityPackageLifecycleDesiredIntent;
  desiredReceipt?: CapabilityPackageLifecycleDesiredReceipt;
}

export interface CapabilityPackageLifecycleRefused extends CapabilityPackageLifecycleBase {
  status: "refused";
}

export type CapabilityPackageLifecycleResult =
  | CapabilityPackageLifecycleReady
  | CapabilityPackageLifecycleRefused;

export interface CapabilityPackageLifecycleReconcileInput {
  operation?: "reconcile";
  intentBytes: Buffer;
  index: PackageGraphIndex;
  currentReceipt?: unknown;
  diagnostics: readonly SkillPackageGraphDiagnostic[];
}

export interface CapabilityPackageLifecycleRemoveInput {
  operation: "remove";
  removeRoots: readonly PackageId[];
  intentBytes: Buffer;
  index: PackageGraphIndex;
  currentReceipt: unknown;
  diagnostics: readonly SkillPackageGraphDiagnostic[];
}

export type CapabilityPackageLifecycleInput =
  | CapabilityPackageLifecycleReconcileInput
  | CapabilityPackageLifecycleRemoveInput;

const EMPTY_CHANGES: CapabilityPackageLifecycleChanges = {
  add: [],
  update: [],
  remove: [],
  unchanged: [],
};

const MAX_LIFECYCLE_INPUT_DEPTH = 64;
const MAX_LIFECYCLE_INPUT_NODES = 250_000;

interface LifecycleGuardState {
  active: Set<object>;
  nodes: number;
}

function guardedLifecycleClone(
  value: unknown,
  state: LifecycleGuardState,
  depth = 0,
  jsonSafe = false,
): unknown {
  state.nodes += 1;
  if (depth > MAX_LIFECYCLE_INPUT_DEPTH || state.nodes > MAX_LIFECYCLE_INPUT_NODES) {
    throw new Error("capability package lifecycle input is too complex");
  }
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("capability package lifecycle input contains an invalid number");
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || state.active.has(value)) {
    throw new Error("capability package lifecycle input contains an invalid value");
  }
  if (Buffer.isBuffer(value)) {
    if (Object.getPrototypeOf(value) !== Buffer.prototype) {
      throw new Error("capability package lifecycle input contains a custom buffer");
    }
    return Buffer.from(value);
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("capability package lifecycle input contains a custom array");
      }
      const names = Object.getOwnPropertyNames(value);
      if (
        names.length !== value.length + 1 ||
        !names.includes("length") ||
        names.some((name) => name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name))
      ) {
        throw new Error("capability package lifecycle input contains an invalid array");
      }
      const clone: unknown[] = [];
      if (jsonSafe) Object.defineProperty(clone, "toJSON", { value: undefined });
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("capability package lifecycle input contains an invalid array entry");
        }
        clone.push(guardedLifecycleClone(descriptor.value, state, depth + 1, jsonSafe));
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new Error("capability package lifecycle input contains a custom object");
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("capability package lifecycle input contains an invalid property");
      }
      clone[name] = guardedLifecycleClone(descriptor.value, state, depth + 1, jsonSafe);
    }
    return clone;
  } finally {
    state.active.delete(value);
  }
}

type LifecycleSnapshotResult =
  | { snapshot: CapabilityPackageLifecycleInput }
  | { refusal: CapabilityPackageLifecycleRefusal };

function lifecycleSnapshot(input: unknown): LifecycleSnapshotResult {
  const invalidIntent = (): LifecycleSnapshotResult => ({
    refusal: { stage: "intent", code: "invalid-intent" },
  });
  try {
    if (
      input === null ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      isProxy(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype &&
        Object.getPrototypeOf(input) !== null) ||
      Object.getOwnPropertySymbols(input).length !== 0
    ) {
      return invalidIntent();
    }
    const allowed = new Set([
      "operation",
      "removeRoots",
      "intentBytes",
      "index",
      "currentReceipt",
      "diagnostics",
    ]);
    const snapshot = Object.create(null) as Record<string, unknown>;
    const state: LifecycleGuardState = { active: new Set(), nodes: 0 };
    for (const name of Object.getOwnPropertyNames(input).sort(codeUnitCompare)) {
      if (!allowed.has(name)) return invalidIntent();
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return name === "currentReceipt"
          ? { refusal: { stage: "receipt", code: "invalid-current-receipt" } }
          : invalidIntent();
      }
      try {
        snapshot[name] = guardedLifecycleClone(descriptor.value, state, 1);
      } catch {
        return name === "currentReceipt"
          ? { refusal: { stage: "receipt", code: "invalid-current-receipt" } }
          : invalidIntent();
      }
    }
    if (
      !Buffer.isBuffer(snapshot.intentBytes) ||
      !("index" in snapshot) ||
      !Array.isArray(snapshot.diagnostics)
    ) {
      return invalidIntent();
    }
    return { snapshot: snapshot as unknown as CapabilityPackageLifecycleInput };
  } catch {
    return invalidIntent();
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function refused(
  refusal: CapabilityPackageLifecycleRefusal,
): DeepReadonly<CapabilityPackageLifecycleRefused> {
  return deepFreeze({
    schemaVersion: 1,
    status: "refused",
    changes: structuredClone(EMPTY_CHANGES),
    refusals: [refusal],
  });
}

function sameDigest(
  left: { algorithm: string; value: string },
  right: { algorithm: string; value: string },
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(codeUnitCompare);
  const b = [...right].sort(codeUnitCompare);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameAuthorityRefs(
  left: CapabilityPackageOwnershipPackage["members"][number]["authorityRefs"],
  right: CapabilityPackageOwnershipPackage["members"][number]["authorityRefs"],
): boolean {
  const a = [...left].sort((x, y) => codeUnitCompare(x.authorityId, y.authorityId));
  const b = [...right].sort((x, y) => codeUnitCompare(x.authorityId, y.authorityId));
  return (
    a.length === b.length &&
    a.every((reference, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        reference.authorityId === other.authorityId &&
        reference.claimDigest === other.claimDigest &&
        sameDigest(reference.sourceDigest, other.sourceDigest)
      );
    })
  );
}

function sameOwnershipPackage(
  left: CapabilityPackageOwnershipPackage,
  right: CapabilityPackageOwnershipPackage,
): boolean {
  if (
    left.id !== right.id ||
    left.authorityId !== right.authorityId ||
    left.claimDigest !== right.claimDigest ||
    !sameDigest(left.sourceDigest, right.sourceDigest) ||
    !sameStrings(left.dependencies, right.dependencies) ||
    left.members.length !== right.members.length
  ) {
    return false;
  }
  const leftMembers = [...left.members].sort((a, b) => codeUnitCompare(a.id, b.id));
  const rightMembers = [...right.members].sort((a, b) => codeUnitCompare(a.id, b.id));
  return leftMembers.every((member, index) => {
    const other = rightMembers[index];
    return (
      other !== undefined &&
      member.id === other.id &&
      member.claimDigest === other.claimDigest &&
      sameDigest(member.sourceDigest, other.sourceDigest) &&
      sameAuthorityRefs(member.authorityRefs, other.authorityRefs)
    );
  });
}

function currentReceipt(input: unknown): CapabilityPackageOwnershipReceipt | undefined {
  if (input === undefined) return undefined;
  return parseCapabilityPackageOwnershipReceipt(
    serializeCapabilityPackageOwnershipReceipt(input as CapabilityPackageOwnershipReceipt),
  );
}

function planRemoval(
  input: CapabilityPackageLifecycleRemoveInput,
): DeepReadonly<CapabilityPackageLifecycleResult> {
  let current: CapabilityPackageOwnershipReceipt | undefined;
  try {
    current = currentReceipt(input.currentReceipt);
  } catch {
    return refused({ stage: "receipt", code: "invalid-current-receipt" });
  }
  if (
    current === undefined ||
    !Array.isArray(input.removeRoots) ||
    input.removeRoots.length === 0 ||
    input.removeRoots.length > 128 ||
    new Set(input.removeRoots).size !== input.removeRoots.length ||
    input.removeRoots.some((id) => !PackageIdSchema.safeParse(id).success)
  ) {
    return refused({ stage: "operation", code: "invalid-removal" });
  }

  const currentPlan = planCapabilityPackageLifecycle({
    intentBytes: input.intentBytes,
    index: input.index,
    currentReceipt: undefined,
    diagnostics: input.diagnostics,
  });
  if (currentPlan.status === "refused") return currentPlan;
  if (
    currentPlan.desiredReceipt === undefined ||
    serializeCapabilityPackageOwnershipReceipt(current) !== currentPlan.desiredReceipt.serialized
  ) {
    return refused({ stage: "operation", code: "current-state-mismatch" });
  }

  let intent: ReturnType<typeof parseCapabilityPackageIntentBytes>;
  try {
    intent = parseCapabilityPackageIntentBytes(input.intentBytes);
  } catch {
    return refused({ stage: "intent", code: "invalid-intent" });
  }
  const currentRoots = new Set(intent.manifest.roots);
  if (input.removeRoots.some((id) => !currentRoots.has(id))) {
    return refused({ stage: "operation", code: "unknown-root" });
  }
  const removedRoots = new Set(input.removeRoots);
  const roots = intent.manifest.roots.filter((id) => !removedRoots.has(id)).sort(codeUnitCompare);
  const packages = new Map(intent.manifest.packages.map((pkg) => [pkg.id, pkg]));
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(packages.get(id)?.dependencies ?? []));
  }
  if (roots.length === 0) {
    return deepFreeze({
      schemaVersion: 1,
      status: "ready",
      changes: {
        add: [],
        update: [],
        remove: current.packages.map(({ id }) => id).sort(codeUnitCompare),
        unchanged: [],
      },
      refusals: [],
    });
  }

  const reducedPackages = intent.manifest.packages.filter(({ id }) => reachable.has(id));
  const usedAuthorities = new Set(reducedPackages.map(({ authorityId }) => authorityId));
  const reducedManifest = {
    schemaVersion: 1 as const,
    authorities: intent.manifest.authorities
      .filter(({ id }) => usedAuthorities.has(id))
      .map((authority) => ({
        id: authority.id,
        kind: authority.kind,
        sourceDigest: { ...authority.sourceDigest },
        projectionDigest: authority.projectionDigest,
      }))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
    roots,
    packages: reducedPackages
      .map((pkg) => ({
        kind: "package" as const,
        id: pkg.id,
        authorityId: pkg.authorityId,
        claimDigest: pkg.claimDigest,
        sourceDigest: { ...pkg.sourceDigest },
        dependencies: [...pkg.dependencies].sort(codeUnitCompare),
        members: [...pkg.members].sort(codeUnitCompare),
      }))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
  };
  const serializableIntent = guardedLifecycleClone(
    reducedManifest,
    {
      active: new Set(),
      nodes: 0,
    },
    0,
    true,
  );
  const serializedIntent = `${JSON.stringify(serializableIntent, null, 2)}\n`;
  const reducedIntent = parseCapabilityPackageIntentBytes(Buffer.from(serializedIntent, "utf8"));
  const planned = planCapabilityPackageLifecycle({
    intentBytes: reducedIntent.sourceBytes,
    index: input.index,
    currentReceipt: current,
    diagnostics: input.diagnostics,
  });
  if (planned.status === "refused") return planned;
  return deepFreeze({
    ...structuredClone(planned),
    desiredIntent: {
      bytes: [...reducedIntent.sourceBytes],
      sha256: reducedIntent.sourceSha256,
    },
  });
}

/**
 * Compute package ownership metadata only. The result is not an execution plan and makes no
 * assertion that a package or member has been installed or configured.
 */
export function planCapabilityPackageLifecycle(
  input: CapabilityPackageLifecycleInput,
): DeepReadonly<CapabilityPackageLifecycleResult> {
  const snapshotResult = lifecycleSnapshot(input);
  if ("refusal" in snapshotResult) return refused(snapshotResult.refusal);
  const { snapshot } = snapshotResult;
  if (snapshot.operation === "remove") return planRemoval(snapshot);
  let intent: ReturnType<typeof parseCapabilityPackageIntentBytes>;
  if (!Buffer.isBuffer(snapshot.intentBytes))
    return refused({ stage: "intent", code: "invalid-intent" });
  try {
    intent = parseCapabilityPackageIntentBytes(snapshot.intentBytes);
  } catch {
    return refused({ stage: "intent", code: "invalid-intent" });
  }

  let current: CapabilityPackageOwnershipReceipt | undefined;
  try {
    current = currentReceipt(snapshot.currentReceipt);
  } catch {
    return refused({ stage: "receipt", code: "invalid-current-receipt" });
  }

  let resolution: ReturnType<typeof resolveCapabilityPackages>;
  try {
    resolution = resolveCapabilityPackages({ manifest: intent.manifest, index: snapshot.index });
  } catch (error) {
    return refused({
      stage: "resolution",
      code: error instanceof CapabilityPackageResolutionError ? error.code : "invalid-input",
    });
  }

  let bindings: ReturnType<typeof resolveSkillPackAuthorityBindings>;
  try {
    bindings = resolveSkillPackAuthorityBindings({
      resolution,
      index: snapshot.index,
      diagnostics: snapshot.diagnostics,
    });
  } catch (error) {
    return refused({
      stage: "skill-pack",
      code: error instanceof CapabilityPackageSkillPackError ? error.code : "invalid-diagnostics",
    });
  }

  const receiptInput: CapabilityPackageOwnershipReceipt = {
    format: "aih-capability-package-ownership-receipt",
    schemaVersion: 1,
    manifest: { sha256: intent.sourceSha256 },
    roots: [...resolution.roots],
    packages: bindings.map((binding) => ({
      id: binding.id,
      authorityId: binding.authorityId,
      claimDigest: binding.claimDigest,
      sourceDigest: structuredClone(binding.sourceDigest),
      dependencies: [...binding.dependencies],
      members: binding.members.map((member) => ({
        id: member.id,
        claimDigest: member.catalogClaimDigest,
        sourceDigest: structuredClone(member.sourceDigest),
        authorityRefs: member.authorityRefs.map((reference) => ({
          authorityId: reference.authorityId,
          claimDigest: reference.claimDigest,
          sourceDigest: structuredClone(reference.sourceDigest),
        })),
      })),
    })),
  };

  let serialized: string;
  let receipt: CapabilityPackageOwnershipReceipt;
  try {
    serialized = serializeCapabilityPackageOwnershipReceipt(receiptInput);
    receipt = parseCapabilityPackageOwnershipReceipt(serialized);
  } catch {
    return refused({ stage: "receipt", code: "invalid-desired-receipt" });
  }

  const previous = new Map((current?.packages ?? []).map((pkg) => [pkg.id, pkg]));
  const desired = new Map(receipt.packages.map((pkg) => [pkg.id, pkg]));
  const changes: CapabilityPackageLifecycleChanges = structuredClone(EMPTY_CHANGES);
  for (const pkg of receipt.packages) {
    const before = previous.get(pkg.id);
    if (before === undefined) changes.add.push(pkg.id);
    else if (sameOwnershipPackage(before, pkg)) changes.unchanged.push(pkg.id);
    else changes.update.push(pkg.id);
  }
  for (const pkg of current?.packages ?? []) {
    if (!desired.has(pkg.id)) changes.remove.push(pkg.id);
  }
  for (const values of Object.values(changes)) values.sort(codeUnitCompare);

  return deepFreeze({
    schemaVersion: 1,
    status: "ready",
    changes,
    refusals: [],
    desiredReceipt: { receipt, serialized },
  });
}
