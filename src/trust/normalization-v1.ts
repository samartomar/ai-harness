import { createHash } from "node:crypto";
import {
  type Node as JsonNode,
  type ParseError,
  parse as parseJson,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { z } from "zod";
import { canonicalJson, codeUnitCompare } from "../capability/package-graph/canonical.js";

export const NORMALIZATION_TARGET_CODES_V1 = Object.freeze([
  "trust.auto-exec-hook",
  "trust.cisco-finding",
  "trust.dependency-confusion",
  "trust.detector-finding",
  "trust.external-egress",
  "trust.hidden-unicode",
  "trust.legal-text-detector-finding",
  "trust.malicious-code",
  "trust.prompt-injection",
  "trust.skill-metadata-license",
  "trust.typosquat",
  "trust.visible-unicode",
] as const);

export type NormalizationTargetCodeV1 = (typeof NORMALIZATION_TARGET_CODES_V1)[number];

export interface NormalizationCompatibilityV1 {
  readonly scannerManifestSha256: string;
  readonly analyzerIdentitySha256: string;
  readonly normalizationConfigurationSha256: string;
}

export interface NormalizationMappingV1 {
  readonly detectorClass: string;
  readonly nativeRuleId: string;
  readonly canonicalCode: NormalizationTargetCodeV1;
  readonly compatibility: NormalizationCompatibilityV1;
}

export interface NormalizationProfileV1 {
  readonly protocol: "NormalizationProfileV1";
  readonly mappings: readonly NormalizationMappingV1[];
}

export interface RawOccurrenceDiagnosticsV1 {
  readonly analyzerVersion?: string;
  readonly severity?: string;
  readonly message?: string;
  readonly timestamp?: string;
  readonly runIdentifier?: string;
  readonly rawFormatting?: string;
  readonly displayLine?: number;
}

export interface RawOccurrenceFingerprintV1Input {
  readonly protocol: "RawOccurrenceFingerprintV1";
  readonly detectorClass: string;
  readonly nativeRuleId: string;
  readonly path: string;
  readonly fileSha256: string;
  readonly canonicalOrdinal: number;
  readonly diagnostics: RawOccurrenceDiagnosticsV1;
}

export interface RawOccurrenceFingerprintV1 extends RawOccurrenceFingerprintV1Input {
  readonly fingerprint: string;
}

export type NormalizationResolutionV1 =
  | {
      readonly kind: "mapped";
      readonly canonicalCode: NormalizationTargetCodeV1;
      readonly acceptanceRequired: false;
      readonly normalizationEntryDigest: string;
    }
  | {
      readonly kind: "unmapped";
      readonly canonicalCode: "trust.unmapped-external-rule";
      readonly acceptanceRequired: true;
      readonly normalizationEntryDigest: null;
    };

export type ContextualEvaluationOutcomeV1 =
  | "suppressed-non-actionable"
  | "review-required"
  | "mapping-required";

export interface CanonicalFindingIdentityV1 {
  readonly protocol: "CanonicalFindingIdentityV1";
  readonly kind: "mapped" | "unmapped";
  readonly canonicalCode: NormalizationTargetCodeV1 | "trust.unmapped-external-rule";
  readonly rawOccurrenceFingerprint: string;
  readonly normalizationEntryDigest: string | null;
  readonly contextualEvaluationOutcome: ContextualEvaluationOutcomeV1;
  readonly acceptanceRequired: boolean;
  readonly fingerprint: string;
}

export interface NormalizationCompatibilityDescriptorV1 {
  readonly detectorClass: string;
  readonly analyzerLabel: string;
  readonly analyzerIdentity: string;
  readonly scannerManifestIdentityDescriptor: {
    readonly protocol: "NormalizationCompatibilityScannerIdentityV1";
    readonly detectorClass: string;
    readonly analyzerLabel: string;
    readonly analyzerIdentity: string;
    readonly adapterIdentity: "aih.trust.sarif-normalizer.current";
  };
  readonly normalizationConfigurationIdentityDescriptor: {
    readonly protocol: "NormalizationCompatibilityConfigurationIdentityV1";
    readonly detectorClass: string;
    readonly evaluatorIdentity: "aih.trust.detectors.ruleCode+evidence.policy-v3";
    readonly nativeRuleIds: readonly string[];
  };
}

interface ResolutionState {
  detectorClass: string;
  nativeRuleId: string;
}

interface RawState {
  canonicalJson: string;
}

interface FindingState {
  canonicalJson: string;
}

const parsedProfiles = new WeakSet<object>();
const parsedEntries = new WeakSet<object>();
const resolutionStates = new WeakMap<object, ResolutionState>();
const rawStates = new WeakMap<object, RawState>();
const findingStates = new WeakMap<object, FindingState>();

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function assertWellFormedNfc(value: string, label: string, requireNfc = true): void {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains malformed Unicode (a lone high surrogate)`);
      }
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      throw new TypeError(`${label} contains malformed Unicode (a lone low surrogate)`);
    }
  }
  if (requireNfc && value.normalize("NFC") !== value) {
    throw new TypeError(`${label} must already be NFC; normalization is not performed`);
  }
}

function assertUnicodeTree(
  value: unknown,
  label: string,
  active = new WeakSet<object>(),
  requireNfc = true,
): void {
  if (typeof value === "string") {
    assertWellFormedNfc(value, label, requireNfc);
    return;
  }
  if (!isObject(value)) return;
  if (active.has(value)) throw new TypeError(`${label} must not contain a cycle`);
  active.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError(`${label} has an unsupported array prototype`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError(`${label} arrays must contain only data properties and no holes`);
      }
      assertUnicodeTree(descriptor.value, `${label}[${String(index)}]`, active, requireNfc);
    }
    active.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} has an unsupported object prototype`);
  }
  for (const key of Object.keys(value)) {
    assertWellFormedNfc(key, `${label} key`, requireNfc);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    assertUnicodeTree(descriptor.value, `${label}.${key}`, active, requireNfc);
  }
  active.delete(value);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isObject(value) || seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function addUnicodeIssue(value: string, label: string, context: z.RefinementCtx): void {
  try {
    assertWellFormedNfc(value, label);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : `${label} has invalid Unicode`,
    });
  }
}

function boundedUnicodeString(label: string, maximum: number) {
  return z
    .string()
    .min(1, `${label} must not be empty`)
    .max(maximum, `${label} is oversized`)
    .superRefine((value, context) => addUnicodeIssue(value, label, context));
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function selectorSchema(label: string, maximum: number) {
  return boundedUnicodeString(label, maximum).superRefine((value, context) => {
    if (value.trim() !== value || hasControlCharacter(value)) {
      context.addIssue({ code: "custom", message: `${label} selector has invalid whitespace` });
    }
    if (/[\\/*?[\]{}()+|^$]/.test(value)) {
      context.addIssue({
        code: "custom",
        message: `${label} selector cannot be wildcard or regex`,
      });
    }
  });
}

const DetectorClassSchema = selectorSchema("detector class", 256);
const NativeRuleIdSchema = selectorSchema("native rule ID", 1_024);
const LowerSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-hex SHA-256 digest");

const CompatibilitySchema = z
  .object({
    scannerManifestSha256: LowerSha256Schema,
    analyzerIdentitySha256: LowerSha256Schema,
    normalizationConfigurationSha256: LowerSha256Schema,
  })
  .strict();

const MappingSchema = z
  .object({
    detectorClass: DetectorClassSchema,
    nativeRuleId: NativeRuleIdSchema,
    canonicalCode: z.enum(NORMALIZATION_TARGET_CODES_V1),
    compatibility: CompatibilitySchema,
  })
  .strict();

const ProfileSchema = z
  .object({
    protocol: z.literal("NormalizationProfileV1"),
    mappings: z.array(MappingSchema).max(4_096, "profile mappings must remain bounded"),
  })
  .strict();

const DiagnosticsSchema = z
  .object({
    analyzerVersion: boundedUnicodeString("diagnostics.analyzerVersion", 4_096).optional(),
    severity: boundedUnicodeString("diagnostics.severity", 1_024).optional(),
    message: boundedUnicodeString("diagnostics.message", 16_384).optional(),
    timestamp: boundedUnicodeString("diagnostics.timestamp", 4_096).optional(),
    runIdentifier: boundedUnicodeString("diagnostics.runIdentifier", 4_096).optional(),
    rawFormatting: boundedUnicodeString("diagnostics.rawFormatting", 65_536).optional(),
    displayLine: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

const RawInputSchema = z
  .object({
    protocol: z.literal("RawOccurrenceFingerprintV1"),
    detectorClass: DetectorClassSchema,
    nativeRuleId: NativeRuleIdSchema,
    path: boundedUnicodeString("path", 4_096),
    fileSha256: LowerSha256Schema,
    canonicalOrdinal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    diagnostics: DiagnosticsSchema,
  })
  .strict();

const LookupSchema = z
  .object({
    detectorClass: DetectorClassSchema,
    nativeRuleId: NativeRuleIdSchema,
    compatibility: CompatibilitySchema,
  })
  .strict();

const ScannerIdentityDescriptorSchema = z
  .object({
    protocol: z.literal("NormalizationCompatibilityScannerIdentityV1"),
    detectorClass: DetectorClassSchema,
    analyzerLabel: boundedUnicodeString("analyzer label", 1_024),
    analyzerIdentity: boundedUnicodeString("analyzer identity", 4_096),
    adapterIdentity: z.literal("aih.trust.sarif-normalizer.current"),
  })
  .strict();

const ConfigurationIdentityDescriptorSchema = z
  .object({
    protocol: z.literal("NormalizationCompatibilityConfigurationIdentityV1"),
    detectorClass: DetectorClassSchema,
    evaluatorIdentity: z.literal("aih.trust.detectors.ruleCode+evidence.policy-v3"),
    nativeRuleIds: z.array(NativeRuleIdSchema).min(1).max(4_096),
  })
  .strict();

const CompatibilityDescriptorSchema = z
  .object({
    detectorClass: DetectorClassSchema,
    analyzerLabel: boundedUnicodeString("analyzer label", 1_024),
    analyzerIdentity: boundedUnicodeString("analyzer identity", 4_096),
    scannerManifestIdentityDescriptor: ScannerIdentityDescriptorSchema,
    normalizationConfigurationIdentityDescriptor: ConfigurationIdentityDescriptorSchema,
  })
  .strict();

function compatibilityKey(compatibility: NormalizationCompatibilityV1): string {
  return [
    compatibility.scannerManifestSha256,
    compatibility.analyzerIdentitySha256,
    compatibility.normalizationConfigurationSha256,
  ].join("\u0000");
}

function mappingKey(mapping: NormalizationMappingV1): string {
  return [
    mapping.detectorClass,
    mapping.nativeRuleId,
    compatibilityKey(mapping.compatibility),
  ].join("\u0000");
}

function compareMappings(left: NormalizationMappingV1, right: NormalizationMappingV1): number {
  for (const [leftValue, rightValue] of [
    [left.detectorClass, right.detectorClass],
    [left.nativeRuleId, right.nativeRuleId],
    [left.compatibility.scannerManifestSha256, right.compatibility.scannerManifestSha256],
    [left.compatibility.analyzerIdentitySha256, right.compatibility.analyzerIdentitySha256],
    [
      left.compatibility.normalizationConfigurationSha256,
      right.compatibility.normalizationConfigurationSha256,
    ],
  ] as const) {
    const compared = codeUnitCompare(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return 0;
}

function assertNoDuplicateKeys(node: JsonNode): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const key = keyNode?.value;
      if (typeof key === "string") {
        if (seen.has(key)) throw new TypeError(`duplicate JSON object key: ${key}`);
        seen.add(key);
      }
      const valueNode = property.children?.[1];
      if (valueNode !== undefined) assertNoDuplicateKeys(valueNode);
    }
    return;
  }
  if (node.type === "array") {
    for (const child of node.children ?? []) assertNoDuplicateKeys(child);
  }
}

export function canonicalBytesV1(value: unknown): Buffer {
  assertUnicodeTree(value, "canonical JSON", new WeakSet<object>(), false);
  return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalSha256V1(value: unknown): string {
  return createHash("sha256").update(canonicalBytesV1(value)).digest("hex");
}

export function parseNormalizationProfileV1(value: unknown): NormalizationProfileV1 {
  assertUnicodeTree(value, "normalization profile");
  const parsed = ProfileSchema.parse(value);
  const mappings = parsed.mappings.sort(compareMappings);
  const byKey = new Map<string, NormalizationTargetCodeV1>();
  for (const mapping of mappings) {
    const key = mappingKey(mapping);
    const previous = byKey.get(key);
    if (previous !== undefined) {
      if (previous === mapping.canonicalCode) {
        throw new TypeError(
          `duplicate normalization mapping: ${mapping.detectorClass}/${mapping.nativeRuleId}`,
        );
      }
      throw new TypeError(
        `ambiguous normalization mapping: ${mapping.detectorClass}/${mapping.nativeRuleId}`,
      );
    }
    byKey.set(key, mapping.canonicalCode);
    parsedEntries.add(mapping);
  }
  const result: NormalizationProfileV1 = { protocol: "NormalizationProfileV1", mappings };
  parsedProfiles.add(result);
  return deepFreeze(result);
}

export function parseNormalizationProfileV1Json(text: string): NormalizationProfileV1 {
  assertWellFormedNfc(text, "normalization profile JSON text");
  const options = { allowTrailingComma: false, disallowComments: true } as const;
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, options);
  if (errors.length > 0 || tree === undefined) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${String(error.offset)}`)
      .join("; ");
    throw new TypeError(
      `invalid JSON normalization profile${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
  if (tree.type !== "object")
    throw new TypeError("normalization profile JSON root must be an object");
  assertNoDuplicateKeys(tree);
  const parseErrors: ParseError[] = [];
  const value = parseJson(text, parseErrors, options);
  if (parseErrors.length > 0) throw new TypeError("invalid JSON normalization profile");
  return parseNormalizationProfileV1(value);
}

export function normalizationEntryDigestV1(entry: NormalizationMappingV1): string {
  if (!isObject(entry) || !parsedEntries.has(entry)) {
    throw new TypeError("normalization entry digest requires a parsed validated mapping entry");
  }
  return canonicalSha256V1({
    domain: "aih.normalization-profile-v1.mapping-entry",
    entry,
  });
}

export function normalizationProfileDigestV1(profile: NormalizationProfileV1): string {
  if (!isObject(profile) || !parsedProfiles.has(profile)) {
    throw new TypeError("normalization profile digest requires a parsed validated profile");
  }
  return canonicalSha256V1({
    domain: "aih.normalization-profile-v1.profile",
    profile,
  });
}

function sameCompatibility(
  left: NormalizationCompatibilityV1,
  right: NormalizationCompatibilityV1,
): boolean {
  return compatibilityKey(left) === compatibilityKey(right);
}

function incompatibilityMessage(
  expected: NormalizationCompatibilityV1,
  actual: NormalizationCompatibilityV1,
): string {
  for (const field of [
    "scannerManifestSha256",
    "analyzerIdentitySha256",
    "normalizationConfigurationSha256",
  ] as const) {
    if (expected[field] !== actual[field]) return `compatibility ${field} mismatch`;
  }
  return "compatibility identity mismatch";
}

export function resolveNormalizationV1(
  profile: NormalizationProfileV1,
  lookup: {
    readonly detectorClass: string;
    readonly nativeRuleId: string;
    readonly compatibility: NormalizationCompatibilityV1;
  },
): NormalizationResolutionV1 {
  if (!isObject(profile) || !parsedProfiles.has(profile)) {
    throw new TypeError("resolver requires a parsed validated normalization profile");
  }
  assertUnicodeTree(lookup, "normalization lookup");
  const parsedLookup = LookupSchema.parse(lookup);
  const classEntries = profile.mappings.filter(
    (mapping) => mapping.detectorClass === parsedLookup.detectorClass,
  );
  if (classEntries.length > 0) {
    const firstClassEntry = classEntries[0];
    if (firstClassEntry === undefined) throw new TypeError("normalization class entry is missing");
    const selectorEntries = classEntries.filter(
      (mapping) => mapping.nativeRuleId === parsedLookup.nativeRuleId,
    );
    const compatibilityEntries = selectorEntries.length > 0 ? selectorEntries : classEntries;
    const compatibleEntry = compatibilityEntries.find((mapping) =>
      sameCompatibility(mapping.compatibility, parsedLookup.compatibility),
    );
    if (compatibleEntry === undefined) {
      const expectedEntry = compatibilityEntries[0] ?? firstClassEntry;
      throw new TypeError(
        incompatibilityMessage(expectedEntry.compatibility, parsedLookup.compatibility),
      );
    }
    if (selectorEntries.length > 0) {
      const result: NormalizationResolutionV1 = {
        kind: "mapped",
        canonicalCode: compatibleEntry.canonicalCode,
        acceptanceRequired: false,
        normalizationEntryDigest: normalizationEntryDigestV1(compatibleEntry),
      };
      resolutionStates.set(result, {
        detectorClass: parsedLookup.detectorClass,
        nativeRuleId: parsedLookup.nativeRuleId,
      });
      return deepFreeze(result);
    }
  }
  const result: NormalizationResolutionV1 = {
    kind: "unmapped",
    canonicalCode: "trust.unmapped-external-rule",
    acceptanceRequired: true,
    normalizationEntryDigest: null,
  };
  resolutionStates.set(result, {
    detectorClass: parsedLookup.detectorClass,
    nativeRuleId: parsedLookup.nativeRuleId,
  });
  return deepFreeze(result);
}

function assertSafeRelativePosixPath(path: string): void {
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    /[\\%?#:]/.test(path) ||
    hasControlCharacter(path)
  ) {
    throw new TypeError("path must be a safe relative POSIX filesystem path");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("path must not contain empty, dot, or traversal segments");
  }
}

export function createRawOccurrenceFingerprintV1(
  input: RawOccurrenceFingerprintV1Input,
): RawOccurrenceFingerprintV1 {
  assertUnicodeTree(input, "raw occurrence");
  const parsed = RawInputSchema.parse(input);
  assertSafeRelativePosixPath(parsed.path);
  const identity = {
    protocol: parsed.protocol,
    detectorClass: parsed.detectorClass,
    nativeRuleId: parsed.nativeRuleId,
    path: parsed.path,
    fileSha256: parsed.fileSha256,
    canonicalOrdinal: parsed.canonicalOrdinal,
  };
  const canonical = canonicalJson(identity);
  const fingerprint = `raw-occurrence-v1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
  const result: RawOccurrenceFingerprintV1 = { ...parsed, fingerprint };
  rawStates.set(result, { canonicalJson: canonical });
  return deepFreeze(result);
}

export function rawOccurrenceCanonicalBytesV1(value: RawOccurrenceFingerprintV1): Buffer {
  const state = isObject(value) ? rawStates.get(value) : undefined;
  if (state === undefined) {
    throw new TypeError("raw canonical bytes require a validated raw result and fingerprint");
  }
  return Buffer.from(state.canonicalJson, "utf8");
}

const BrandedRawSchema = z.custom<RawOccurrenceFingerprintV1>(
  (value) => isObject(value) && rawStates.has(value),
  "canonical finding requires a validated raw result",
);
const BrandedResolutionSchema = z.custom<NormalizationResolutionV1>(
  (value) => isObject(value) && resolutionStates.has(value),
  "canonical finding requires a validated resolver resolution",
);
const ContextualOutcomeSchema = z.enum([
  "suppressed-non-actionable",
  "review-required",
  "mapping-required",
]);
const FindingInputSchema = z
  .object({
    rawOccurrence: BrandedRawSchema,
    normalizationResolution: BrandedResolutionSchema,
    contextualEvaluationOutcome: ContextualOutcomeSchema,
  })
  .strict();

export function createCanonicalFindingIdentityV1(input: {
  readonly rawOccurrence: RawOccurrenceFingerprintV1;
  readonly normalizationResolution: NormalizationResolutionV1;
  readonly contextualEvaluationOutcome: ContextualEvaluationOutcomeV1;
}): CanonicalFindingIdentityV1 {
  assertUnicodeTree(input, "canonical finding input");
  const parsed = FindingInputSchema.parse(input);
  const resolutionState = resolutionStates.get(parsed.normalizationResolution);
  if (resolutionState === undefined) {
    throw new TypeError("canonical finding requires a validated resolver resolution");
  }
  if (
    resolutionState.detectorClass !== parsed.rawOccurrence.detectorClass ||
    resolutionState.nativeRuleId !== parsed.rawOccurrence.nativeRuleId
  ) {
    throw new TypeError("normalization resolution selector does not match the raw occurrence");
  }
  if (
    parsed.normalizationResolution.kind === "mapped" &&
    parsed.contextualEvaluationOutcome === "mapping-required"
  ) {
    throw new TypeError(
      "mapped contextual outcome must be suppressed-non-actionable or review-required",
    );
  }
  if (
    parsed.normalizationResolution.kind === "unmapped" &&
    parsed.contextualEvaluationOutcome !== "mapping-required"
  ) {
    throw new TypeError("unmapped contextual outcome must be mapping-required");
  }
  const canonicalIdentity = {
    protocol: "CanonicalFindingIdentityV1" as const,
    kind: parsed.normalizationResolution.kind,
    canonicalCode: parsed.normalizationResolution.canonicalCode,
    rawOccurrenceFingerprint: parsed.rawOccurrence.fingerprint,
    normalizationEntryDigest: parsed.normalizationResolution.normalizationEntryDigest,
    contextualEvaluationOutcome: parsed.contextualEvaluationOutcome,
  };
  const canonical = canonicalJson(canonicalIdentity);
  const fingerprint = `canonical-finding-v1:${canonicalIdentity.kind}:${createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")}`;
  const result: CanonicalFindingIdentityV1 = {
    ...canonicalIdentity,
    acceptanceRequired: parsed.normalizationResolution.acceptanceRequired,
    fingerprint,
  };
  findingStates.set(result, { canonicalJson: canonical });
  return deepFreeze(result);
}

export function canonicalFindingCanonicalBytesV1(value: CanonicalFindingIdentityV1): Buffer {
  const state = isObject(value) ? findingStates.get(value) : undefined;
  if (state === undefined) {
    throw new TypeError("canonical bytes require a validated canonical finding");
  }
  return Buffer.from(state.canonicalJson, "utf8");
}

export function deriveNormalizationCompatibilityV1(
  descriptor: NormalizationCompatibilityDescriptorV1,
): NormalizationCompatibilityV1 {
  assertUnicodeTree(descriptor, "normalization compatibility descriptor");
  const parsed = CompatibilityDescriptorSchema.parse(descriptor);
  if (
    parsed.scannerManifestIdentityDescriptor.detectorClass !== parsed.detectorClass ||
    parsed.normalizationConfigurationIdentityDescriptor.detectorClass !== parsed.detectorClass
  ) {
    throw new TypeError("compatibility descriptor detector class mismatch");
  }
  if (
    parsed.scannerManifestIdentityDescriptor.analyzerLabel !== parsed.analyzerLabel ||
    parsed.scannerManifestIdentityDescriptor.analyzerIdentity !== parsed.analyzerIdentity
  ) {
    throw new TypeError("compatibility descriptor analyzer identity mismatch");
  }
  const rules = parsed.normalizationConfigurationIdentityDescriptor.nativeRuleIds;
  const sortedRules = [...rules].sort(codeUnitCompare);
  if (
    new Set(rules).size !== rules.length ||
    rules.some((rule, index) => rule !== sortedRules[index])
  ) {
    throw new TypeError("compatibility descriptor native rule IDs must be unique and sorted");
  }
  return deepFreeze({
    scannerManifestSha256: canonicalSha256V1({
      domain: "aih.normalization-profile-v1.compatibility.scanner-manifest",
      descriptor: parsed.scannerManifestIdentityDescriptor,
    }),
    analyzerIdentitySha256: canonicalSha256V1({
      domain: "aih.normalization-profile-v1.compatibility.analyzer",
      analyzerLabel: parsed.analyzerLabel,
      analyzerIdentity: parsed.analyzerIdentity,
    }),
    normalizationConfigurationSha256: canonicalSha256V1({
      domain: "aih.normalization-profile-v1.compatibility.normalization-configuration",
      descriptor: parsed.normalizationConfigurationIdentityDescriptor,
    }),
  });
}
