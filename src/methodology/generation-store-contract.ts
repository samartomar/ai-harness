import { createHash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";
import { z } from "zod";
import { ProjectionPlanResultSchema, type planSyntheticProjection } from "./projection-planner.js";

export const STORE_SCHEMA_VERSION = 1 as const;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 64;
export const MAX_TARGET_BYTES = 240;
export const MAX_TOTAL_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_TARGET_SEGMENTS = 32;
export const MAX_GENERATED_DIRECTORIES = 512;
export const MAX_WALK_ENTRIES = 1024;
export const MAX_WALK_BYTES = 64 * 1024 * 1024;
export const MAX_RECOVERY_RECORDS = 128;
export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_FINDING_SUBJECT_BYTES = 240;
export const MAX_PID = 4_294_967_295;

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const STORE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const ROOT_DEVICE_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SOURCE_LOCATOR_PATTERN = /^synthetic:[a-z][a-z0-9-]{0,63}$/;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const RESERVED_TARGET_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;
const MAX_FINDINGS = 64;
const MAX_ROOT_DEVICE = 18_446_744_073_709_551_615n;

const DigestSchema = z.string().regex(DIGEST_PATTERN);
const StoreIdSchema = z.string().regex(STORE_ID_PATTERN);
const RootDeviceSchema = z
  .string()
  .refine((value) => ROOT_DEVICE_PATTERN.test(value) && BigInt(value) <= MAX_ROOT_DEVICE);
const ArtifactIdSchema = z.string().regex(ARTIFACT_ID_PATTERN);
const SourceLocatorSchema = z.string().regex(SOURCE_LOCATOR_PATTERN);
const ProjectRootSchema = z.string().min(1);
const ExpectedActiveDigestSchema = DigestSchema.nullable();

export function isCanonicalProjectionTarget(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_TARGET_BYTES || !TARGET_PATTERN.test(value)) {
    return false;
  }
  const segments = value.split("/");
  if (segments.length > MAX_TARGET_SEGMENTS) return false;
  for (const segment of segments) {
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      RESERVED_TARGET_SEGMENT_PATTERN.test(segment)
    ) {
      return false;
    }
  }
  return true;
}

const TargetSchema = z.string().refine(isCanonicalProjectionTarget, {
  message: "target must use the closed canonical relative form",
});

export const STORE_FINDING_CODES = [
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
  "METHODOLOGY_STORE_PAYLOAD_DIGEST",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_LOCK_HELD",
  "METHODOLOGY_STORE_LOCK_INVALID",
  "METHODOLOGY_STORE_PLAN_STALE",
  "METHODOLOGY_STORE_DESTINATION_COLLISION",
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_CLEAN_ACTIVE",
  "METHODOLOGY_STORE_CLEAN_RETAINED",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
] as const;

export const StoreFindingCodeSchema = z.enum(STORE_FINDING_CODES);

export const StoreFindingSchema = z
  .object({
    code: StoreFindingCodeSchema,
    subject: z
      .string()
      .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_FINDING_SUBJECT_BYTES, {
        message: "finding subject exceeds the UTF-8 byte limit",
      })
      .optional(),
  })
  .strict();

export const RootRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    rootId: StoreIdSchema,
    rootDevice: RootDeviceSchema,
  })
  .strict();

export const ReceiptEntrySchema = z
  .object({
    artifactId: ArtifactIdSchema,
    target: TargetSchema,
    sourceLocator: SourceLocatorSchema,
    contentDigest: DigestSchema,
    bytes: z.number().int().nonnegative().max(MAX_PAYLOAD_BYTES),
  })
  .strict();

const ReceiptEntriesSchema = z
  .array(ReceiptEntrySchema)
  .min(1)
  .max(MAX_MANIFEST_ENTRIES)
  .superRefine((entries, context) => {
    const artifactIds = new Set<string>();
    const targets = new Set<string>();
    const targetList: string[] = [];
    let totalBytes = 0;
    for (const [index, entry] of entries.entries()) {
      if (artifactIds.has(entry.artifactId)) {
        context.addIssue({
          code: "custom",
          path: [index, "artifactId"],
          message: "entry artifact ids must be unique",
        });
      }
      if (targets.has(entry.target)) {
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: "entry targets must be unique",
        });
      }
      artifactIds.add(entry.artifactId);
      targets.add(entry.target);
      targetList.push(entry.target);
      totalBytes += entry.bytes;
    }
    if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      context.addIssue({
        code: "custom",
        message: "entries exceed the aggregate byte limit",
      });
    }
    if (hasTargetCollision(targetList)) {
      context.addIssue({
        code: "custom",
        message: "entries contain a destination collision",
      });
    }
    if (hasTooManyGeneratedDirectories(targetList)) {
      context.addIssue({
        code: "custom",
        message: "entries exceed the generated directory limit",
      });
    }
  });

export const GenerationReceiptSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    rootId: StoreIdSchema,
    manifestDigest: DigestSchema,
    entries: ReceiptEntriesSchema,
  })
  .strict();

export const ActivationRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    manifestDigest: DigestSchema,
    receiptDigest: DigestSchema,
    generation: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.generation !== `generations/${value.manifestDigest}/content`) {
      context.addIssue({
        code: "custom",
        path: ["generation"],
        message: "activation generation must bind its manifest digest",
      });
    }
  });

const OwnedWorkRecordShape = {
  schemaVersion: z.literal(STORE_SCHEMA_VERSION),
  rootId: StoreIdSchema,
  transactionId: StoreIdSchema,
  manifestDigest: DigestSchema,
} as const;

export const IncompleteRecordSchema = z.object(OwnedWorkRecordShape).strict();

export const StagingRecordSchema = z.object(OwnedWorkRecordShape).strict();

export const LockOwnerRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    rootId: StoreIdSchema,
    token: StoreIdSchema,
    pid: z.number().int().min(1).max(MAX_PID),
    transactionId: StoreIdSchema,
  })
  .strict();

export const ApplyTransactionPhaseSchema = z.enum([
  "prepared",
  "staged",
  "generation-reserved",
  "generation-verified",
  "activation-committed",
  "committed",
]);

export const CleanTransactionPhaseSchema = z.enum([
  "prepared",
  "quarantined",
  "deleting",
  "committed",
]);

const ApplyTransactionRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    operation: z.literal("apply"),
    rootId: StoreIdSchema,
    transactionId: StoreIdSchema,
    phase: ApplyTransactionPhaseSchema,
    manifestDigest: DigestSchema,
    oldActivation: ActivationRecordSchema.nullable(),
    newActivation: ActivationRecordSchema,
    entries: ReceiptEntriesSchema,
  })
  .strict();

const CleanTransactionRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    operation: z.literal("clean"),
    rootId: StoreIdSchema,
    transactionId: StoreIdSchema,
    phase: CleanTransactionPhaseSchema,
    generationDigest: DigestSchema,
    oldActivation: ActivationRecordSchema.nullable(),
    entries: ReceiptEntriesSchema,
  })
  .strict();

export const TransactionRecordSchema = z
  .discriminatedUnion("operation", [ApplyTransactionRecordSchema, CleanTransactionRecordSchema])
  .superRefine((value, context) => {
    if (
      value.operation === "apply" &&
      value.manifestDigest !== value.newActivation.manifestDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["manifestDigest"],
        message: "apply transaction manifest digest must match its new activation",
      });
    }
  });

const GenerationStoreCommonBoundarySchema = {
  providerRead: z.literal(false),
  providerExecution: z.literal(false),
  hostExecution: z.literal(false),
  network: z.literal(false),
  packageManager: z.literal(false),
  cli: z.literal(false),
} as const;

export const GENERATION_STORE_READ_BOUNDARY = Object.freeze({
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  cli: false,
  writeCapability: "none" as const,
});

export const GENERATION_STORE_MUTATION_BOUNDARY = Object.freeze({
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  cli: false,
  writeCapability: "aih-owned-project-root" as const,
});

const GenerationStoreReadBoundarySchema = z
  .object({
    ...GenerationStoreCommonBoundarySchema,
    writeCapability: z.literal("none"),
  })
  .strict();

const GenerationStoreMutationBoundarySchema = z
  .object({
    ...GenerationStoreCommonBoundarySchema,
    writeCapability: z.literal("aih-owned-project-root"),
  })
  .strict();

const FindingsSchema = z.array(StoreFindingSchema).max(MAX_FINDINGS);

const APPLY_BLOCKED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
  "METHODOLOGY_STORE_PAYLOAD_DIGEST",
  "METHODOLOGY_STORE_LOCK_HELD",
  "METHODOLOGY_STORE_PLAN_STALE",
  "METHODOLOGY_STORE_DESTINATION_COLLISION",
]);
const APPLY_FAILED_CLOSED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_LOCK_INVALID",
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
]);
const INSPECTION_DRIFT_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
]);
const INSPECTION_FAILED_CLOSED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
]);
const RECOVERY_BLOCKED_CODES = new Set<StoreFindingCode>(["METHODOLOGY_STORE_LOCK_HELD"]);
const RECOVERY_FAILED_CLOSED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_LOCK_INVALID",
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
]);
const CLEAN_BLOCKED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_LOCK_HELD",
  "METHODOLOGY_STORE_CLEAN_ACTIVE",
]);
const CLEAN_RETAINED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_CLEAN_RETAINED",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
]);
const CLEAN_FAILED_CLOSED_CODES = new Set<StoreFindingCode>([
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_LOCK_INVALID",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
]);

type FindingConstraints = Readonly<Record<string, ReadonlySet<StoreFindingCode>>>;

function findingDispositionIssue(
  state: string,
  findings: readonly StoreFinding[],
  successfulStates: ReadonlySet<string>,
  constraints: FindingConstraints,
): string | undefined {
  if (successfulStates.has(state)) {
    return findings.length === 0 ? undefined : "successful results must not contain findings";
  }
  if (findings.length === 0) {
    return "non-success results must contain at least one finding";
  }
  const allowed = constraints[state];
  if (allowed === undefined) {
    return "result state has no finding disposition";
  }
  for (const finding of findings) {
    if (!allowed.has(finding.code)) {
      return "finding code is not valid for the result state";
    }
  }
  return undefined;
}

export const ProjectionInspectionResultSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    state: z.enum(["empty", "verified", "drifted", "failed-closed"]),
    activeDigest: DigestSchema.nullable(),
    boundary: GenerationStoreReadBoundarySchema,
    findings: FindingsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = findingDispositionIssue(
      value.state,
      value.findings,
      new Set(["empty", "verified"]),
      {
        drifted: INSPECTION_DRIFT_CODES,
        "failed-closed": INSPECTION_FAILED_CLOSED_CODES,
      },
    );
    if (issue !== undefined) {
      context.addIssue({ code: "custom", path: ["findings"], message: issue });
    }
    if (
      (value.state === "empty" && value.activeDigest !== null) ||
      ((value.state === "verified" || value.state === "drifted") && value.activeDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeDigest"],
        message: "inspection state and active digest disagree",
      });
    }
  });

export const ApplyProjectionResultSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    state: z.enum(["applied", "already-active", "blocked", "failed-closed"]),
    previousActiveDigest: DigestSchema.nullable(),
    activeDigest: DigestSchema.nullable(),
    boundary: GenerationStoreMutationBoundarySchema,
    findings: FindingsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = findingDispositionIssue(
      value.state,
      value.findings,
      new Set(["applied", "already-active"]),
      {
        blocked: APPLY_BLOCKED_CODES,
        "failed-closed": APPLY_FAILED_CLOSED_CODES,
      },
    );
    if (issue !== undefined) {
      context.addIssue({ code: "custom", path: ["findings"], message: issue });
    }
    if (
      (value.state === "applied" || value.state === "already-active") &&
      value.activeDigest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["activeDigest"],
        message: "successful apply must name its active digest",
      });
    }
    if (value.state === "already-active" && value.previousActiveDigest !== value.activeDigest) {
      context.addIssue({
        code: "custom",
        path: ["previousActiveDigest"],
        message: "already-active must preserve the observed digest",
      });
    }
  });

export const RecoveryProjectionResultSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    state: z.enum(["recovered", "nothing-to-recover", "blocked", "failed-closed"]),
    activeDigest: DigestSchema.nullable(),
    boundary: GenerationStoreMutationBoundarySchema,
    findings: FindingsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = findingDispositionIssue(
      value.state,
      value.findings,
      new Set(["recovered", "nothing-to-recover"]),
      {
        blocked: RECOVERY_BLOCKED_CODES,
        "failed-closed": RECOVERY_FAILED_CLOSED_CODES,
      },
    );
    if (issue !== undefined) {
      context.addIssue({ code: "custom", path: ["findings"], message: issue });
    }
  });

export const CleanProjectionResultSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    state: z.enum(["cleaned", "retained", "blocked", "failed-closed"]),
    generationDigest: DigestSchema.nullable(),
    boundary: GenerationStoreMutationBoundarySchema,
    findings: FindingsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = findingDispositionIssue(value.state, value.findings, new Set(["cleaned"]), {
      blocked: CLEAN_BLOCKED_CODES,
      retained: CLEAN_RETAINED_CODES,
      "failed-closed": CLEAN_FAILED_CLOSED_CODES,
    });
    if (issue !== undefined) {
      context.addIssue({ code: "custom", path: ["findings"], message: issue });
    }
    if (
      (value.state === "cleaned" || value.state === "retained") &&
      value.generationDigest === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["generationDigest"],
        message: "cleaned or retained results must name a generation",
      });
    }
  });

export const InspectProjectionInputSchema = z.object({ projectRoot: ProjectRootSchema }).strict();

export const RecoverProjectionInputSchema = z.object({ projectRoot: ProjectRootSchema }).strict();

export const CleanProjectionInputSchema = z
  .object({
    projectRoot: ProjectRootSchema,
    generationDigest: DigestSchema,
  })
  .strict();

export type PlannedProjection = Extract<
  ReturnType<typeof planSyntheticProjection>,
  { state: "planned" }
>;

export type ProjectionPayload = Readonly<{
  artifactId: string;
  bytes: Uint8Array;
}>;

export type ValidatedProjectionPayload = Readonly<{
  artifactId: string;
  bytes: Buffer;
}>;

export type ApplyProjectionInput = Readonly<{
  mode: "apply";
  projectRoot: string;
  plan: unknown;
  payloads: readonly unknown[];
  expectedActiveDigest: string | null;
}>;

export type ValidatedApplyProjectionInput = Readonly<{
  mode: "apply";
  projectRoot: string;
  plan: PlannedProjection;
  payloads: readonly ValidatedProjectionPayload[];
  expectedActiveDigest: string | null;
}>;

export type InspectProjectionInput = z.infer<typeof InspectProjectionInputSchema>;
export type RecoverProjectionInput = z.infer<typeof RecoverProjectionInputSchema>;
export type CleanProjectionInput = z.infer<typeof CleanProjectionInputSchema>;
export type StoreFindingCode = z.infer<typeof StoreFindingCodeSchema>;
export type StoreFinding = z.infer<typeof StoreFindingSchema>;
export type RootRecord = z.infer<typeof RootRecordSchema>;
export type ReceiptEntry = z.infer<typeof ReceiptEntrySchema>;
export type GenerationReceipt = z.infer<typeof GenerationReceiptSchema>;
export type ActivationRecord = z.infer<typeof ActivationRecordSchema>;
export type IncompleteRecord = z.infer<typeof IncompleteRecordSchema>;
export type StagingRecord = z.infer<typeof StagingRecordSchema>;
export type LockOwnerRecord = z.infer<typeof LockOwnerRecordSchema>;
export type ApplyTransactionPhase = z.infer<typeof ApplyTransactionPhaseSchema>;
export type CleanTransactionPhase = z.infer<typeof CleanTransactionPhaseSchema>;
export type TransactionRecord = z.infer<typeof TransactionRecordSchema>;
export type GenerationStoreBoundary =
  | typeof GENERATION_STORE_READ_BOUNDARY
  | typeof GENERATION_STORE_MUTATION_BOUNDARY;
export type ProjectionInspectionResult = Readonly<{
  schemaVersion: 1;
  state: "empty" | "verified" | "drifted" | "failed-closed";
  activeDigest: string | null;
  boundary: typeof GENERATION_STORE_READ_BOUNDARY;
  findings: readonly StoreFinding[];
}>;
export type ApplyProjectionResult = Readonly<{
  schemaVersion: 1;
  state: "applied" | "already-active" | "blocked" | "failed-closed";
  previousActiveDigest: string | null;
  activeDigest: string | null;
  boundary: typeof GENERATION_STORE_MUTATION_BOUNDARY;
  findings: readonly StoreFinding[];
}>;
export type RecoveryProjectionResult = Readonly<{
  schemaVersion: 1;
  state: "recovered" | "nothing-to-recover" | "blocked" | "failed-closed";
  activeDigest: string | null;
  boundary: typeof GENERATION_STORE_MUTATION_BOUNDARY;
  findings: readonly StoreFinding[];
}>;
export type CleanProjectionResult = Readonly<{
  schemaVersion: 1;
  state: "cleaned" | "retained" | "blocked" | "failed-closed";
  generationDigest: string | null;
  boundary: typeof GENERATION_STORE_MUTATION_BOUNDARY;
  findings: readonly StoreFinding[];
}>;

export class GenerationStoreContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationStoreContractError";
  }
}

type ContractParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: Error }>;

export type ContractSchema<T> = Readonly<{
  parse: (value: unknown) => T;
  safeParse: (value: unknown) => ContractParseResult<T>;
}>;

function contractFailure(message: string): never {
  throw new GenerationStoreContractError(message);
}

function requireClosedRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    return contractFailure(`${label} must be a closed record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return contractFailure(`${label} must be a plain record`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length) {
    return contractFailure(`${label} must contain exactly its closed fields`);
  }
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) {
      return contractFailure(`${label} contains an unknown field`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      return contractFailure(`${label} is missing ${field}`);
    }
  }
  return value as Record<string, unknown>;
}

function ownData(record: Record<string, unknown>, field: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (descriptor === undefined || !("value" in descriptor)) {
    return contractFailure(`${label}.${field} must be an own data field`);
  }
  return descriptor.value;
}

function parsePayloadArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || isProxy(value)) {
    return contractFailure("payloads must be a closed array");
  }
  if (value.length > MAX_MANIFEST_ENTRIES) {
    return contractFailure("payload count exceeds the manifest limit");
  }
  const result: Record<string, unknown>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return contractFailure("payloads must not contain holes or accessors");
    }
    result.push(requireClosedRecord(descriptor.value, ["artifactId", "bytes"], "payload"));
  }
  return result;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasTargetCollision(targets: readonly string[]): boolean {
  const targetSet = new Set(targets);
  if (targetSet.size !== targets.length) {
    return true;
  }
  for (const target of targets) {
    let separator = target.indexOf("/");
    while (separator !== -1) {
      if (targetSet.has(target.slice(0, separator))) {
        return true;
      }
      separator = target.indexOf("/", separator + 1);
    }
    if (target.length === 0) {
      return true;
    }
  }
  return false;
}

function hasTooManyGeneratedDirectories(targets: readonly string[]): boolean {
  const directories = new Set<string>();
  for (const target of targets) {
    const segments = target.split("/");
    let current = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = current.length === 0 ? segment : `${current}/${segment}`;
      directories.add(current);
      if (directories.size > MAX_GENERATED_DIRECTORIES) {
        return true;
      }
    }
  }
  return false;
}

function validateGeneratedDirectories(targets: readonly string[]): void {
  if (hasTooManyGeneratedDirectories(targets)) {
    contractFailure("generated directory count exceeds its limit");
  }
}

export function parseApplyProjectionInput(value: unknown): ValidatedApplyProjectionInput {
  const input = requireClosedRecord(
    value,
    ["mode", "projectRoot", "plan", "payloads", "expectedActiveDigest"],
    "apply input",
  );
  if (ownData(input, "mode", "apply input") !== "apply") {
    return contractFailure("apply input mode must be apply");
  }
  const projectRoot = ProjectRootSchema.parse(ownData(input, "projectRoot", "apply input"));
  const parsedPlan = ProjectionPlanResultSchema.parse(ownData(input, "plan", "apply input"));
  if (parsedPlan.state !== "planned") {
    return contractFailure("Phase 4 requires a planned Phase 3 result");
  }
  if (parsedPlan.manifest.entries.length > MAX_MANIFEST_ENTRIES) {
    return contractFailure("manifest entry count exceeds its limit");
  }

  const targets: string[] = [];
  const expectedByArtifact = new Map<string, (typeof parsedPlan.manifest.entries)[number]>();
  for (const entry of parsedPlan.manifest.entries) {
    if (!isCanonicalProjectionTarget(entry.target)) {
      return contractFailure("manifest target is not canonical");
    }
    targets.push(entry.target);
    if (expectedByArtifact.has(entry.artifactId)) {
      return contractFailure("manifest artifact ids must be unique");
    }
    expectedByArtifact.set(entry.artifactId, entry);
  }
  if (hasTargetCollision(targets)) {
    return contractFailure("manifest contains a destination collision");
  }
  validateGeneratedDirectories(targets);

  const rawPayloads = parsePayloadArray(ownData(input, "payloads", "apply input"));
  if (rawPayloads.length !== parsedPlan.manifest.entries.length) {
    return contractFailure("payload coverage does not match the manifest");
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  const payloads: ValidatedProjectionPayload[] = [];
  for (const rawPayload of rawPayloads) {
    const artifactId = ArtifactIdSchema.parse(ownData(rawPayload, "artifactId", "payload"));
    if (seen.has(artifactId)) {
      return contractFailure("payload artifact ids must be unique");
    }
    seen.add(artifactId);
    const rawBytes = ownData(rawPayload, "bytes", "payload");
    if (
      rawBytes === null ||
      typeof rawBytes !== "object" ||
      isProxy(rawBytes) ||
      !isUint8Array(rawBytes)
    ) {
      return contractFailure("payload bytes must be a Uint8Array");
    }
    if (rawBytes.byteLength > MAX_PAYLOAD_BYTES) {
      return contractFailure("payload exceeds its individual byte limit");
    }
    totalBytes += rawBytes.byteLength;
    if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      return contractFailure("payloads exceed the total byte limit");
    }
    const bytes = Buffer.from(rawBytes);
    const expected = expectedByArtifact.get(artifactId);
    if (expected === undefined) {
      return contractFailure("payload artifact is not in the manifest");
    }
    if (sha256Bytes(bytes) !== expected.contentDigest) {
      return contractFailure("payload digest does not match the manifest");
    }
    payloads.push(Object.freeze({ artifactId, bytes }));
  }
  for (const artifactId of expectedByArtifact.keys()) {
    if (!seen.has(artifactId)) {
      return contractFailure("manifest artifact has no payload");
    }
  }
  payloads.sort((left, right) => compareStrings(left.artifactId, right.artifactId));

  const expectedActiveDigest = ExpectedActiveDigestSchema.parse(
    ownData(input, "expectedActiveDigest", "apply input"),
  );
  return Object.freeze({
    mode: "apply" as const,
    projectRoot,
    plan: parsedPlan,
    payloads: Object.freeze(payloads),
    expectedActiveDigest,
  });
}

export const ApplyProjectionInputSchema: ContractSchema<ValidatedApplyProjectionInput> =
  Object.freeze({
    parse: parseApplyProjectionInput,
    safeParse(value: unknown): ContractParseResult<ValidatedApplyProjectionInput> {
      try {
        return Object.freeze({
          success: true as const,
          data: parseApplyProjectionInput(value),
        });
      } catch (error) {
        return Object.freeze({
          success: false as const,
          error:
            error instanceof Error
              ? error
              : new GenerationStoreContractError("invalid apply input"),
        });
      }
    },
  });

export type StoreRecordKind =
  | "root"
  | "receipt"
  | "activation"
  | "staging"
  | "incomplete"
  | "lock-owner"
  | "transaction";

function quoted(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return contractFailure("string cannot be serialized");
  }
  return encoded;
}

function receiptEntryJson(entry: ReceiptEntry): string {
  return (
    '{"artifactId":' +
    quoted(entry.artifactId) +
    ',"target":' +
    quoted(entry.target) +
    ',"sourceLocator":' +
    quoted(entry.sourceLocator) +
    ',"contentDigest":' +
    quoted(entry.contentDigest) +
    ',"bytes":' +
    String(entry.bytes) +
    "}"
  );
}

function canonicalReceiptEntries(entries: readonly ReceiptEntry[]): readonly ReceiptEntry[] {
  return [...entries].sort((left, right) => {
    const targetOrder = compareStrings(left.target, right.target);
    return targetOrder === 0 ? compareStrings(left.artifactId, right.artifactId) : targetOrder;
  });
}

function receiptEntriesJson(entries: readonly ReceiptEntry[]): string {
  return (
    "[" +
    canonicalReceiptEntries(entries)
      .map((entry) => receiptEntryJson(entry))
      .join(",") +
    "]"
  );
}

function activationJson(value: ActivationRecord): string {
  return (
    '{"schemaVersion":1,"manifestDigest":' +
    quoted(value.manifestDigest) +
    ',"receiptDigest":' +
    quoted(value.receiptDigest) +
    ',"generation":' +
    quoted(value.generation) +
    "}"
  );
}

function optionalActivationJson(value: ActivationRecord | null): string {
  return value === null ? "null" : activationJson(value);
}

export function canonicalRecordBytes(kind: StoreRecordKind, record: unknown): Buffer {
  let encoded: string;
  switch (kind) {
    case "root": {
      const value = RootRecordSchema.parse(record);
      encoded =
        '{"schemaVersion":1,"rootId":' +
        quoted(value.rootId) +
        ',"rootDevice":' +
        quoted(value.rootDevice) +
        "}";
      break;
    }
    case "receipt": {
      const value = GenerationReceiptSchema.parse(record);
      encoded =
        '{"schemaVersion":1,"rootId":' +
        quoted(value.rootId) +
        ',"manifestDigest":' +
        quoted(value.manifestDigest) +
        ',"entries":' +
        receiptEntriesJson(value.entries) +
        "}";
      break;
    }
    case "activation": {
      encoded = activationJson(ActivationRecordSchema.parse(record));
      break;
    }
    case "staging": {
      const value = StagingRecordSchema.parse(record);
      encoded =
        '{"schemaVersion":1,"rootId":' +
        quoted(value.rootId) +
        ',"transactionId":' +
        quoted(value.transactionId) +
        ',"manifestDigest":' +
        quoted(value.manifestDigest) +
        "}";
      break;
    }
    case "incomplete": {
      const value = IncompleteRecordSchema.parse(record);
      encoded =
        '{"schemaVersion":1,"rootId":' +
        quoted(value.rootId) +
        ',"transactionId":' +
        quoted(value.transactionId) +
        ',"manifestDigest":' +
        quoted(value.manifestDigest) +
        "}";
      break;
    }
    case "lock-owner": {
      const value = LockOwnerRecordSchema.parse(record);
      encoded =
        '{"schemaVersion":1,"rootId":' +
        quoted(value.rootId) +
        ',"token":' +
        quoted(value.token) +
        ',"pid":' +
        String(value.pid) +
        ',"transactionId":' +
        quoted(value.transactionId) +
        "}";
      break;
    }
    case "transaction": {
      const value = TransactionRecordSchema.parse(record);
      if (value.operation === "apply") {
        encoded =
          '{"schemaVersion":1,"operation":"apply","rootId":' +
          quoted(value.rootId) +
          ',"transactionId":' +
          quoted(value.transactionId) +
          ',"phase":' +
          quoted(value.phase) +
          ',"manifestDigest":' +
          quoted(value.manifestDigest) +
          ',"oldActivation":' +
          optionalActivationJson(value.oldActivation) +
          ',"newActivation":' +
          activationJson(value.newActivation) +
          ',"entries":' +
          receiptEntriesJson(value.entries) +
          "}";
      } else {
        encoded =
          '{"schemaVersion":1,"operation":"clean","rootId":' +
          quoted(value.rootId) +
          ',"transactionId":' +
          quoted(value.transactionId) +
          ',"phase":' +
          quoted(value.phase) +
          ',"generationDigest":' +
          quoted(value.generationDigest) +
          ',"oldActivation":' +
          optionalActivationJson(value.oldActivation) +
          ',"entries":' +
          receiptEntriesJson(value.entries) +
          "}";
      }
      break;
    }
  }
  return Buffer.from(`${encoded}\n`, "utf8");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isTransactionFilename(filename: string, transactionId: string): boolean {
  return STORE_ID_PATTERN.test(transactionId) && filename === `${transactionId}.json`;
}

export function isStagingDirectoryName(dirname: string, transactionId: string): boolean {
  return STORE_ID_PATTERN.test(transactionId) && dirname === transactionId;
}

export function isGenerationDirectoryName(dirname: string, manifestDigest: string): boolean {
  return DIGEST_PATTERN.test(manifestDigest) && dirname === manifestDigest;
}

export function isLockCandidateName(dirname: string, token: string, stale: boolean): boolean {
  return STORE_ID_PATTERN.test(token) && dirname === token + (stale ? ".stale" : "");
}

function freezeFindings(findings: readonly StoreFinding[]): readonly StoreFinding[] {
  return Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
}

export function inspectionResult(
  state: ProjectionInspectionResult["state"],
  activeDigest: string | null,
  findings: readonly StoreFinding[],
): ProjectionInspectionResult {
  const parsed = ProjectionInspectionResultSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    state,
    activeDigest,
    boundary: GENERATION_STORE_READ_BOUNDARY,
    findings,
  });
  return Object.freeze({
    ...parsed,
    boundary: GENERATION_STORE_READ_BOUNDARY,
    findings: freezeFindings(parsed.findings),
  });
}

export function applyResult(
  state: ApplyProjectionResult["state"],
  previousActiveDigest: string | null,
  activeDigest: string | null,
  findings: readonly StoreFinding[],
): ApplyProjectionResult {
  const parsed = ApplyProjectionResultSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    state,
    previousActiveDigest,
    activeDigest,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings,
  });
  return Object.freeze({
    ...parsed,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings: freezeFindings(parsed.findings),
  });
}

export function recoveryResult(
  state: RecoveryProjectionResult["state"],
  activeDigest: string | null,
  findings: readonly StoreFinding[],
): RecoveryProjectionResult {
  const parsed = RecoveryProjectionResultSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    state,
    activeDigest,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings,
  });
  return Object.freeze({
    ...parsed,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings: freezeFindings(parsed.findings),
  });
}

export function cleanResult(
  state: CleanProjectionResult["state"],
  generationDigest: string | null,
  findings: readonly StoreFinding[],
): CleanProjectionResult {
  const parsed = CleanProjectionResultSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    state,
    generationDigest,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings,
  });
  return Object.freeze({
    ...parsed,
    boundary: GENERATION_STORE_MUTATION_BOUNDARY,
    findings: freezeFindings(parsed.findings),
  });
}
