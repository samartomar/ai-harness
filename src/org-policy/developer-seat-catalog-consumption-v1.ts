import { isProxy } from "node:util/types";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import { assertWellFormedNfcV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  type AdminSeatDistributionV1,
  parseAdminSeatDistributionV1Json,
  type ResolvedCatalogBindingV1,
  verifyAdminSeatDistributionV1,
} from "./catalog-binding-v1.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MAX_TRANSPORT_BYTES = 96 * 1024;
const MIN_MAX_AGE_SECONDS = 60;
const MAX_MAX_AGE_SECONDS = 31536000;
const SAFE_VERIFIER_ERROR =
  "DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1: verifier rejected the presented material";

const INPUT_FIELDS = [
  "current",
  "expectedAdminSignerIdentity",
  "expectedAdminSignerRootSha256",
  "expectedEffectVersion",
  "expectedHeadSignerRootSha256",
  "expectedSchemaVersion",
  "lastGood",
  "maxAgeSeconds",
  "now",
  "verifyCanonicalPae",
] as const;

type Json = Record<string, unknown>;
type Verifier = (request: unknown) => unknown;

export interface DeveloperSeatCatalogConsumptionResolvedV1 {
  readonly ageSeconds: number;
  readonly binding: ResolvedCatalogBindingV1;
  readonly distribution: AdminSeatDistributionV1;
  readonly kind: "resolved";
  readonly protocol: "DeveloperSeatCatalogConsumptionV1";
  readonly resolvedAt: string;
  readonly sequence: number;
  readonly source: "current" | "last-good";
}

export interface DeveloperSeatCatalogConsumptionCompatibilityRequiredV1 {
  readonly kind: "compatibility-required";
  readonly materializable: false;
  readonly protocol: "DeveloperSeatCatalogConsumptionV1";
  readonly resolvedCatalogBindingSha256: string;
}

export type DeveloperSeatCatalogConsumptionV1Result =
  | DeveloperSeatCatalogConsumptionResolvedV1
  | DeveloperSeatCatalogConsumptionCompatibilityRequiredV1;

interface ParsedInput {
  readonly current: Buffer | undefined;
  readonly expectedAdminSignerIdentity: string;
  readonly expectedAdminSignerRootSha256: string;
  readonly expectedEffectVersion: string;
  readonly expectedHeadSignerRootSha256: string;
  readonly expectedSchemaVersion: string;
  readonly lastGood: Buffer | undefined;
  readonly maxAgeSeconds: number;
  readonly now: string;
  readonly verifyCanonicalPae: Verifier;
}

function fail(label: string): never {
  throw new TypeError(`DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1: ${label}`);
}

function rejectProxy(value: unknown, label: string): void {
  if (isProxy(value)) fail(label);
}

function record(value: unknown, label: string): Json {
  rejectProxy(value, label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(label);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail(label);
  }
  return value as Json;
}

function exact(value: Json, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(label);
  return value;
}

function boundedNfcString(
  value: unknown,
  label: string,
  max: number,
  rejectAsciiControls = false,
): string {
  if (typeof value !== "string") fail(label);
  assertWellFormedNfcV1(value, label);
  if (value.length === 0 || value.length > max) fail(label);
  if (value.trim() !== value || value.trim().length === 0) fail(label);
  if (rejectAsciiControls && hasAsciiControl(value)) fail(label);
  return value;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    fail(label);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) fail(label);
  const match = value.match(UTC_SECOND);
  if (match === null) fail(label);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(
    Date.UTC(year ?? -1, (month ?? 0) - 1, day ?? -1, hour ?? -1, minute ?? -1, second ?? -1),
  );
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month ?? 1) - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    fail(label);
  return value;
}

function isExactUnavailable(value: unknown, label: string): true {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "kind") fail(label);
  const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.value !== "unavailable"
  )
    fail(label);
  return true;
}

function transportOrUnavailable(value: unknown, label: string): Buffer | undefined {
  rejectProxy(value, label);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Buffer.prototype || prototype === Uint8Array.prototype) {
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(label);
      const size = value.length;
      if (size === 0 || size > MAX_TRANSPORT_BYTES) fail(label);
      return Buffer.from(value);
    }
    if (isExactUnavailable(value, label)) return undefined;
  }
  fail(label);
}

function parseInput(value: unknown): ParsedInput {
  const input = record(value, "input");
  exact(input, INPUT_FIELDS, "input fields");
  const verifyCanonicalPae = input.verifyCanonicalPae;
  rejectProxy(verifyCanonicalPae, "verifier");
  if (typeof verifyCanonicalPae !== "function") fail("verifier");
  return {
    current: transportOrUnavailable(input.current, "current material"),
    expectedAdminSignerIdentity: boundedNfcString(
      input.expectedAdminSignerIdentity,
      "admin signer identity",
      256,
      true,
    ),
    expectedAdminSignerRootSha256: digest(input.expectedAdminSignerRootSha256, "admin signer root"),
    expectedEffectVersion: boundedNfcString(
      input.expectedEffectVersion,
      "effect version",
      64,
      true,
    ),
    expectedHeadSignerRootSha256: digest(input.expectedHeadSignerRootSha256, "head signer root"),
    expectedSchemaVersion: boundedNfcString(
      input.expectedSchemaVersion,
      "schema version",
      64,
      true,
    ),
    lastGood: transportOrUnavailable(input.lastGood, "last-good material"),
    maxAgeSeconds: boundedInteger(
      input.maxAgeSeconds,
      "max age seconds",
      MIN_MAX_AGE_SECONDS,
      MAX_MAX_AGE_SECONDS,
    ),
    now: timestamp(input.now, "now"),
    verifyCanonicalPae: verifyCanonicalPae as Verifier,
  };
}

function safeVerifier(verify: Verifier): Verifier {
  rejectProxy(verify, "verifier");
  return (request: unknown): unknown => {
    try {
      return verify(request);
    } catch {
      throw new TypeError(SAFE_VERIFIER_ERROR);
    }
  };
}

function verifyEnvelope(bytes: Buffer, input: ParsedInput): AdminSeatDistributionV1 {
  const distribution = parseAdminSeatDistributionV1Json(bytes);
  return verifyAdminSeatDistributionV1({
    distribution,
    expectedAdminSignerIdentity: input.expectedAdminSignerIdentity,
    expectedAdminSignerRootSha256: input.expectedAdminSignerRootSha256,
    expectedHeadSignerRootSha256: input.expectedHeadSignerRootSha256,
    verifyCanonicalPae: safeVerifier(input.verifyCanonicalPae),
  });
}

export function resolveDeveloperSeatCatalogConsumptionV1(
  value: unknown,
): DeveloperSeatCatalogConsumptionV1Result {
  const input = parseInput(value);

  const currentDistribution =
    input.current === undefined ? undefined : verifyEnvelope(input.current, input);
  const priorDistribution =
    input.lastGood === undefined ? undefined : verifyEnvelope(input.lastGood, input);

  let primary: AdminSeatDistributionV1;
  let source: "current" | "last-good";
  if (currentDistribution !== undefined) {
    primary = currentDistribution;
    source = "current";
  } else if (priorDistribution !== undefined) {
    primary = priorDistribution;
    source = "last-good";
  } else {
    fail("material unavailable");
  }

  const nowEpoch = Date.parse(input.now);
  const resolvedAtEpoch = Date.parse(primary.binding.resolvedAt);
  if (resolvedAtEpoch > nowEpoch) fail("resolved at is future dated");
  const ageSeconds = Math.round((nowEpoch - resolvedAtEpoch) / 1000);
  if (ageSeconds > input.maxAgeSeconds) fail("resolved at exceeds the bounded max age");

  if (currentDistribution !== undefined && priorDistribution !== undefined) {
    const currentSequence = currentDistribution.binding.sequence;
    const priorSequence = priorDistribution.binding.sequence;
    if (currentSequence < priorSequence) fail("continuity rollback");
    if (
      currentSequence === priorSequence &&
      currentDistribution.binding.resolvedCatalogBindingSha256 !==
        priorDistribution.binding.resolvedCatalogBindingSha256
    )
      fail("continuity digest conflict");
  }

  if (
    primary.binding.compatibleSchemaVersion !== input.expectedSchemaVersion ||
    primary.binding.compatibleEffectVersion !== input.expectedEffectVersion
  ) {
    return deepFreezeStrictJsonV1({
      kind: "compatibility-required",
      materializable: false,
      protocol: "DeveloperSeatCatalogConsumptionV1",
      resolvedCatalogBindingSha256: primary.binding.resolvedCatalogBindingSha256,
    }) as DeveloperSeatCatalogConsumptionCompatibilityRequiredV1;
  }

  return deepFreezeStrictJsonV1({
    ageSeconds,
    binding: primary.binding,
    distribution: primary,
    kind: "resolved",
    protocol: "DeveloperSeatCatalogConsumptionV1",
    resolvedAt: primary.binding.resolvedAt,
    sequence: primary.binding.sequence,
    source,
  }) as DeveloperSeatCatalogConsumptionResolvedV1;
}
