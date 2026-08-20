import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { command as doctorCommand } from "../doctor.js";
import type { CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { policyEvaluateCommand } from "../org-policy/validate.js";
import { structuredVerificationRunToCheck } from "../verification/legacy.js";
import type { VerificationPipelineRun } from "../verification/types.js";
import {
  createGovernanceDoctorDiagnosticRegistryV1,
  type GovernanceDoctorAuditRefusalStateV1,
  type GovernanceDoctorAuditV1Result,
  type GovernanceDoctorGuideV1,
  isGovernanceDoctorProfileCompatibleV1,
  renderGovernanceDoctorGuideV1,
  runGovernanceDoctorAuditV1,
} from "./audit-guide-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertNotProxyV1,
  assertRecordV1,
  assertSha256V1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES,
  GOVERNANCE_DOCTOR_READ_ONLY_PROBES_COMPLETED_V1,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import {
  createGovernanceDoctorOperationV1Record,
  type GovernanceDoctorOperationRecordV1,
} from "./operation-record-v1.js";
import { type GovernanceDoctorProfileV1, governanceDoctorProfileV1Sha256 } from "./profile-v1.js";

export {
  canonicalGovernanceDoctorOperationV1Bytes,
  type GovernanceDoctorOperationCompletedV1,
  type GovernanceDoctorOperationRecordV1,
  type GovernanceDoctorOperationRefusedV1,
} from "./operation-record-v1.js";

/**
 * The AIH-owned outer operational adapter for the Governance Doctor Audit and
 * Guide.
 *
 * The foundation in `audit-guide-v1.ts` consumes precomputed diagnostic data and
 * nothing else. This adapter is the layer above it: it decides which frozen
 * read-only diagnostic names a run is allowed to consult, converts each one's
 * validated result into a fixed safe foundation outcome, and binds the
 * resulting Audit and Guide to the exact profile, root, target, evaluation
 * context, and committed read-only surface revision they were produced for.
 *
 * What it deliberately cannot do matters as much as what it does. A diagnostic
 * name is dispatchable only when it appears in
 * {@link GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES}, whose every entry is
 * pinned to a command spec independently recorded as read-only. No schema field
 * is able to carry a raw command line, an interpreter, a filesystem location, a
 * caller-supplied function, or a name resolved at run time, so a mutation-class
 * surface has no representation to occupy. Widening the boundary is a reviewed
 * edit to that frozen table, never a value a caller can supply.
 *
 * Policy denial and profile incompatibility are decided before any diagnostic is
 * planned or run. On that path the adapter hands the foundation a value carrying no
 * registry brand: the foundation refuses first and never reaches it, and if that
 * ordering ever regressed the missing brand would fail the run closed instead of
 * letting an ungated audit proceed.
 *
 * The record it mints is a binding, not a permission. It names no action, and the
 * Guide it accompanies still marks its next action non-runnable.
 */
export interface GovernanceDoctorOperationV1 {
  readonly audit: GovernanceDoctorAuditV1Result;
  readonly guide: GovernanceDoctorGuideV1;
  readonly record: GovernanceDoctorOperationRecordV1;
}

type Json = Record<string, unknown>;
type ReadOnlySurfaceV1 = (typeof GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES)[number];

interface ExecutableDiagnosticAdapterV1 {
  readonly capability: string;
  readonly command: CommandSpec;
  readonly commandPath: readonly string[];
  readonly diagnosticId: string;
}

const CONTEXT_DOMAIN = "aih.governance-doctor-operational-context-v1";
const SURFACE_DOMAIN = "aih.governance-doctor-read-only-surface-v1";
const PROTOCOL = "GovernanceDoctorOperationV1";
/** Every finding this adapter emits is attributed to the adapter, never to a probe. */
const OPERATIONAL_ATTRIBUTION = "aih:governance-doctor-operational";

const POLICY_DECISIONS = ["allowed", "denied"] as const;
const MAX_DIAGNOSTIC_CHECKS = 96;
const MAX_DIAGNOSTIC_CHECK_BYTES = 8 * 1024;

/**
 * The committed identity of the read-only surface this adapter may consult. The
 * adapter records it on every run, so a record minted against one revision of
 * the frozen table can never be presented as evidence for another.
 */
export const GOVERNANCE_DOCTOR_READ_ONLY_SURFACE_REVISION_V1 = governanceDoctorSha256V1(
  SURFACE_DOMAIN,
  {
    surfaces: GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES.map((surface) => ({
      commandPath: [...surface.commandPath],
      diagnosticId: surface.diagnosticId,
      readOnly: true,
    })),
  },
);

const DISPATCH: ReadonlyMap<string, ReadOnlySurfaceV1> = new Map(
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES.map((surface): [string, ReadOnlySurfaceV1] => [
    surface.diagnosticId,
    surface,
  ]),
);

/** The reviewed initial operational subset; other frozen IDs remain missing adapters. */
const EXECUTABLE_DIAGNOSTIC_ADAPTERS: readonly ExecutableDiagnosticAdapterV1[] = Object.freeze([
  Object.freeze({
    capability: "doctor",
    command: doctorCommand,
    commandPath: Object.freeze(["doctor"]),
    diagnosticId: "aih.doctor.root",
  }),
  Object.freeze({
    capability: "policy evaluate",
    command: policyEvaluateCommand,
    commandPath: Object.freeze(["policy", "evaluate"]),
    diagnosticId: "aih.policy.evaluate",
  }),
]);

const operationalContexts = new WeakMap<object, PlanContext>();

/** Validates an adapter/env object without reading a caller-defined property. */
function assertOwnDataObject(value: unknown, label: string): Record<string, unknown> {
  assertNotProxyV1(value, label);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    failGovernanceDoctorV1(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") failGovernanceDoctorV1(`${label} must not carry symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
      failGovernanceDoctorV1(`${label} must contain only own data properties`);
  }
  return value as Record<string, unknown>;
}

/** Reads an own or prototype data descriptor without invoking an accessor. */
function dataMember(value: object, key: string, label: string): unknown {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value"))
        failGovernanceDoctorV1(`${label} must not expose accessors`);
      return descriptor.value;
    }
    current = Object.getPrototypeOf(current);
  }
  failGovernanceDoctorV1(`${label} is missing a required member`);
}

function hostMethod(value: object, key: string): (...args: readonly unknown[]) => unknown {
  const candidate = dataMember(value, key, "operational host");
  if (typeof candidate !== "function")
    failGovernanceDoctorV1("operational host must expose data-method members");
  return candidate.bind(value) as (...args: readonly unknown[]) => unknown;
}

function snapshotHost(value: PlanContext["host"]): PlanContext["host"] {
  assertOwnDataObject(value, "operational host");
  const platform = dataMember(value, "platform", "operational host");
  const verified = dataMember(value, "verified", "operational host");
  if (platform !== "darwin" && platform !== "linux" && platform !== "windows")
    failGovernanceDoctorV1("operational host platform is invalid");
  if (typeof verified !== "boolean") failGovernanceDoctorV1("operational host verified is invalid");
  return Object.freeze({
    cpuPhysicalCores: hostMethod(value, "cpuPhysicalCores"),
    detectVdi: hostMethod(value, "detectVdi"),
    envShell: hostMethod(value, "envShell"),
    gpu: hostMethod(value, "gpu"),
    lockDownFileArgv: hostMethod(value, "lockDownFileArgv"),
    npmCliPath: hostMethod(value, "npmCliPath"),
    persistentEnvArgv: hostMethod(value, "persistentEnvArgv"),
    platform,
    scratchDir: hostMethod(value, "scratchDir"),
    shellProfilePaths: hostMethod(value, "shellProfilePaths"),
    symlinkDirArgv: hostMethod(value, "symlinkDirArgv"),
    tlsProbeArgv: hostMethod(value, "tlsProbeArgv"),
    totalRamGb: hostMethod(value, "totalRamGb"),
    trustStoreCerts: hostMethod(value, "trustStoreCerts"),
    trustStoreRoots: hostMethod(value, "trustStoreRoots"),
    verified,
  } as PlanContext["host"]);
}

function snapshotEnvironment(value: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const record = assertOwnDataObject(value, "operational environment");
  const snapshot = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (typeof entry !== "string" && entry !== undefined)
      failGovernanceDoctorV1("operational environment values must be strings");
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: entry,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function sanitizedOperationalContext(value: PlanContext): PlanContext {
  return Object.freeze({
    apply: false,
    contextDir: value.contextDir,
    env: snapshotEnvironment(value.env),
    host: snapshotHost(value.host),
    json: true,
    options: Object.freeze({}),
    ...(value.posture === undefined ? {} : { posture: value.posture }),
    ...(value.postureSource === undefined ? {} : { postureSource: value.postureSource }),
    root: value.root,
    run: value.run,
    verify: true,
  });
}

/**
 * Opaque operational context minted from an AIH-owned read-only PlanContext.
 * It snapshots only the execution necessities and deliberately drops caller
 * options, targets, prompting, progress, cleanup, and orchestration seams.
 */
export function createGovernanceDoctorOperationalContextV1(
  value: PlanContext,
): Readonly<{ readonly protocol: "GovernanceDoctorOperationalContextV1" }> {
  const contextValue = assertRecordV1(value, "operational context");
  if (contextValue.apply !== false || contextValue.verify !== true)
    failGovernanceDoctorV1("operational context must be read-only and verifying");
  if (typeof contextValue.root !== "string" || typeof contextValue.contextDir !== "string")
    failGovernanceDoctorV1("operational context root and context directory must be strings");
  if (typeof contextValue.run !== "function")
    failGovernanceDoctorV1("operational context must provide a runner");
  assertNotProxyV1(contextValue.run, "operational runner");
  const context = Object.freeze({ protocol: "GovernanceDoctorOperationalContextV1" as const });
  operationalContexts.set(
    context,
    sanitizedOperationalContext(contextValue as unknown as PlanContext),
  );
  return context;
}

function operationalContext(value: unknown): PlanContext {
  const context =
    typeof value === "object" && value !== null ? operationalContexts.get(value) : undefined;
  if (context === undefined)
    failGovernanceDoctorV1("operation requires an AIH-owned operational context");
  return context;
}

/** Returns only the descriptor-validated snapshot behind an opaque context brand. */
export function governanceDoctorOperationalPlanContextV1(value: unknown): PlanContext {
  return operationalContext(value);
}

/** Anti-forgery brand: a hand-built look-alike is not an operation record. */

/**
 * The single dispatch gate. A name absent from the frozen table -- including
 * every decision, destructive, publication, and acquisition surface -- resolves
 * to nothing and is refused here rather than downstream.
 */
function dispatch(value: unknown): ReadOnlySurfaceV1 {
  const surface = typeof value === "string" ? DISPATCH.get(value) : undefined;
  if (surface === undefined)
    failGovernanceDoctorV1("operational dispatch is not a registered read-only AIH diagnostic");
  return surface;
}

/**
 * The read-only command ownership a dispatchable diagnostic name is pinned to.
 * This is recorded evidence for review. The adapter's fixed dispatch table below
 * selects a bounded subset of these entries; callers cannot select a command.
 */
export function governanceDoctorOperationalCommandPathV1(value: unknown): readonly string[] {
  return dispatch(value).commandPath;
}

/**
 * Not a diagnostic registry, and deliberately unbranded. It stands in for the
 * registry on the refusal path, where the foundation returns before reading it.
 */
const NO_DIAGNOSTIC_REGISTRY = Object.freeze({});

interface OperationBindingV1 {
  readonly contextSha256: string;
  readonly rootSha256: string;
  readonly surfaceRevisionSha256: string;
  readonly targetId: string;
}

/** The operation-record root digest for one resolved root/context pair. */
export function governanceDoctorOperationalRootSha256V1(input: unknown): string {
  const request = assertRecordV1(input, "operational root digest request");
  assertExactKeysV1(request, ["contextDir", "root"], "operational root digest request");
  if (typeof request.contextDir !== "string" || typeof request.root !== "string")
    failGovernanceDoctorV1("operational root digest request is malformed");
  return governanceDoctorSha256V1("aih.governance-doctor-operational-root-v1", {
    contextDir: request.contextDir,
    root: request.root,
  });
}

/**
 * Binds one run to one root, one evaluation context, and one surface revision.
 * The root arrives already reduced to a digest, so this adapter holds no location
 * to resolve, open, or hand onwards.
 */
function operationBinding(
  context: PlanContext,
  profile: GovernanceDoctorProfileV1,
): OperationBindingV1 {
  return {
    contextSha256: governanceDoctorSha256V1(CONTEXT_DOMAIN, {
      contextDir: context.contextDir,
      platform: context.host.platform,
      posture: context.posture ?? null,
      postureSource: context.postureSource ?? null,
      verified: context.host.verified,
    }),
    rootSha256: governanceDoctorOperationalRootSha256V1({
      contextDir: context.contextDir,
      root: context.root,
    }),
    surfaceRevisionSha256: GOVERNANCE_DOCTOR_READ_ONLY_SURFACE_REVISION_V1,
    targetId: profile.targetId,
  };
}

function boundedCanonical(value: unknown, label: string): void {
  if (canonicalStrictJsonBytesV1(value).length > MAX_DIAGNOSTIC_CHECK_BYTES)
    failGovernanceDoctorV1(`${label} exceeds its canonical byte bound`);
}

/**
 * What one validated read-only check reported. The verdict drives the audit; the
 * name and code are retained only to be compared against the code-owned table
 * below, and neither is ever carried into an audit, a guide, or a plan.
 */
interface ProbeOutcomeV1 {
  readonly code: string | undefined;
  readonly name: string;
  readonly verdict: "pass" | "fail" | "skip";
}

function probeVerdict(value: unknown): ProbeOutcomeV1 {
  const check = assertRecordV1(value, "read-only diagnostic output");
  const allowed = new Set(["code", "detail", "fingerprint", "location", "name", "verdict"]);
  if (Object.keys(check).some((key) => !allowed.has(key)))
    failGovernanceDoctorV1("read-only diagnostic output has an unsupported field");
  if (typeof check.name !== "string" || check.name.length === 0)
    failGovernanceDoctorV1("read-only diagnostic output is malformed");
  const verdict = assertEnumV1(
    check.verdict,
    ["pass", "fail", "skip"] as const,
    "read-only diagnostic verdict",
  );
  for (const field of ["code", "detail", "fingerprint"] as const) {
    if (check[field] !== undefined && typeof check[field] !== "string")
      failGovernanceDoctorV1("read-only diagnostic output is malformed");
  }
  let location: Record<string, unknown> | undefined;
  if (check.location !== undefined) {
    const rawLocation = assertRecordV1(check.location, "read-only diagnostic location");
    const locationKeys = Object.keys(rawLocation);
    if (
      locationKeys.some((key) => key !== "startLine" && key !== "uri") ||
      typeof rawLocation.uri !== "string" ||
      (rawLocation.startLine !== undefined &&
        (!Number.isInteger(rawLocation.startLine) || (rawLocation.startLine as number) < 1))
    )
      failGovernanceDoctorV1("read-only diagnostic location is malformed");
    location = {
      ...(rawLocation.startLine === undefined ? {} : { startLine: rawLocation.startLine }),
      uri: rawLocation.uri,
    };
  }
  boundedCanonical(
    {
      ...(check.code === undefined ? {} : { code: check.code }),
      ...(check.detail === undefined ? {} : { detail: check.detail }),
      ...(check.fingerprint === undefined ? {} : { fingerprint: check.fingerprint }),
      ...(location === undefined ? {} : { location }),
      name: check.name,
      verdict,
    },
    "read-only diagnostic output",
  );
  return {
    code: typeof check.code === "string" ? check.code : undefined,
    name: check.name,
    verdict,
  };
}

function probeVerdicts(value: unknown, label: string): ProbeOutcomeV1[] {
  const checks = assertArrayV1(value, 1, MAX_DIAGNOSTIC_CHECKS, label);
  return checks.map(probeVerdict);
}

function structuredOptions(
  value: unknown,
  describe: unknown,
): {
  readonly includeMetadata?: boolean;
  readonly name: string;
  readonly passDetail?: string;
  readonly warnAs?: "fail" | "pass" | "skip";
} {
  if (typeof describe !== "string")
    failGovernanceDoctorV1("read-only diagnostic action is malformed");
  if (value === undefined) return { name: describe };
  const options = assertRecordV1(value, "read-only structured diagnostic options");
  const allowed = new Set(["includeMetadata", "name", "passDetail", "warnAs"]);
  if (Object.keys(options).some((key) => !allowed.has(key)))
    failGovernanceDoctorV1("read-only structured diagnostic options have an unsupported field");
  if (options.includeMetadata !== undefined && typeof options.includeMetadata !== "boolean")
    failGovernanceDoctorV1("read-only structured diagnostic options are malformed");
  if (options.name !== undefined && typeof options.name !== "string")
    failGovernanceDoctorV1("read-only structured diagnostic options are malformed");
  if (options.passDetail !== undefined && typeof options.passDetail !== "string")
    failGovernanceDoctorV1("read-only structured diagnostic options are malformed");
  if (
    options.warnAs !== undefined &&
    options.warnAs !== "fail" &&
    options.warnAs !== "pass" &&
    options.warnAs !== "skip"
  )
    failGovernanceDoctorV1("read-only structured diagnostic options are malformed");
  return { name: options.name ?? describe, ...options };
}

async function actionVerdicts(value: unknown, context: PlanContext): Promise<ProbeOutcomeV1[]> {
  const action = assertRecordV1(value, "read-only diagnostic action");
  if (
    action.kind !== "probe" ||
    typeof action.describe !== "string" ||
    typeof action.run !== "function"
  )
    failGovernanceDoctorV1("read-only diagnostic action is not a probe");
  if (typeof action.runStructuredLegacy === "function") {
    assertExactKeysV1(
      action,
      ["describe", "kind", "run", "runMany", "runStructuredLegacy"],
      "read-only structured legacy diagnostic action",
    );
    if (typeof action.runMany !== "function")
      failGovernanceDoctorV1("read-only structured legacy diagnostic action is malformed");
    const output = assertRecordV1(
      await (action.runStructuredLegacy as NonNullable<ProbeAction["runStructuredLegacy"]>)(
        context,
      ),
      "read-only structured legacy diagnostic output",
    );
    assertExactKeysV1(
      output,
      ["reportChecks", "verification"],
      "read-only structured legacy diagnostic output",
    );
    return probeVerdicts(output.reportChecks, "read-only structured legacy report checks");
  }
  if (typeof action.runStructured === "function") {
    const expected = Object.hasOwn(action, "structured")
      ? ["describe", "kind", "run", "runStructured", "structured"]
      : ["describe", "kind", "run", "runStructured"];
    assertExactKeysV1(action, expected, "read-only structured diagnostic action");
    const output = assertRecordV1(
      await (action.runStructured as NonNullable<ProbeAction["runStructured"]>)(context),
      "read-only structured diagnostic output",
    );
    assertExactKeysV1(
      output,
      ["evidenceGraph", "results", "summary"],
      "read-only structured diagnostic output",
    );
    assertArrayV1(
      output.results,
      1,
      MAX_DIAGNOSTIC_CHECKS,
      "read-only structured diagnostic results",
    );
    return [
      probeVerdict(
        structuredVerificationRunToCheck(
          output as unknown as VerificationPipelineRun,
          structuredOptions(action.structured, action.describe),
        ),
      ),
    ];
  }
  if (typeof action.runMany === "function") {
    assertExactKeysV1(
      action,
      ["describe", "kind", "run", "runMany"],
      "read-only many diagnostic action",
    );
    return probeVerdicts(
      await (action.runMany as NonNullable<ProbeAction["runMany"]>)(context),
      "read-only many diagnostic output",
    );
  }
  assertExactKeysV1(action, ["describe", "kind", "run"], "read-only diagnostic action");
  return [probeVerdict(await (action.run as ProbeAction["run"])(context))];
}

/**
 * The code-owned table of diagnostic outcomes that survive as findings instead
 * of collapsing the whole diagnostic into an evidence gap.
 *
 * Every entry names an exact four-part tuple: which code-owned diagnostic, which
 * check within it, which verdict, and which code that diagnostic emits. A
 * diagnostic's own code is *compared* here and then discarded -- the finding
 * this adapter emits carries an AIH-owned code and AIH-authored prose, so no
 * string a probe authors ever reaches an audit, a guide, or a plan as data.
 *
 * This is deliberately not a passthrough and not configurable. There is no entry
 * a caller, a profile, an option, or an environment value can add: widening the
 * table is a reviewed edit to this list, and each new entry has to be justified
 * against what a consumer may then mechanically derive from it.
 *
 * The mapping is also all-or-nothing per diagnostic. A run whose non-pass
 * verdicts are not *entirely* covered by this table keeps the pre-existing
 * `evidence-gap` refusal, because a partially understood diagnostic is exactly
 * the state that must not be reported as a completed observation.
 */
const MECHANICAL_DIAGNOSTIC_FINDINGS_V1 = Object.freeze([
  Object.freeze({
    check: "context-dir",
    code: "canon.context-dir-missing",
    diagnosticId: "aih.doctor.root",
    findingCode: "AIH_CANON_CONTEXT_DIR_MISSING",
    severity: "low",
    // "The configured directory", not "the canonical directory": this tuple is
    // what Doctor reports for whichever context directory the run resolved, so a
    // marker naming a custom directory produces the identical check. Only the
    // preview's separate eligibility gate distinguishes the canonical one, and
    // this finding must not assert a distinction the diagnostic never made.
    text: "The configured AIH context directory is not present in this repository.",
    verdict: "skip",
  }),
] as const);

/**
 * Maps this diagnostic's non-pass outcomes to AIH-owned findings, or reports
 * nothing when even one of them is absent from the table above.
 */
function mechanicalFindings(
  diagnosticId: string,
  unresolved: readonly ProbeOutcomeV1[],
): Json[] | undefined {
  const findings = new Map<string, Json>();
  for (const outcome of unresolved) {
    const entry = MECHANICAL_DIAGNOSTIC_FINDINGS_V1.find(
      (candidate) =>
        candidate.diagnosticId === diagnosticId &&
        candidate.check === outcome.name &&
        candidate.verdict === outcome.verdict &&
        candidate.code === outcome.code,
    );
    if (entry === undefined) return undefined;
    findings.set(entry.findingCode, {
      code: entry.findingCode,
      severity: entry.severity,
      summary: { attribution: OPERATIONAL_ATTRIBUTION, text: entry.text },
    });
  }
  return [...findings.values()];
}

/**
 * Executes one code-owned diagnostic adapter. It accepts only ordinary,
 * `runMany`, structured-legacy, and structured probe actions under a sanitized
 * read-only context; planning, command identity, and every probe invocation are
 * code-owned. No request field can supply a command, callback, path, or coded
 * result.
 */
async function diagnosticObservation(
  context: PlanContext,
  profile: GovernanceDoctorProfileV1,
  adapter: ExecutableDiagnosticAdapterV1,
): Promise<Json | undefined> {
  const { capability, command, commandPath, diagnosticId } = adapter;
  if (!profile.diagnosticIds.includes(diagnosticId)) return undefined;
  const surface = dispatch(diagnosticId);
  if (
    command.readOnly !== true ||
    command.plan === undefined ||
    surface.commandPath.length !== commandPath.length ||
    surface.commandPath.some((segment, index) => segment !== commandPath[index])
  )
    return undefined;
  try {
    const planned = await command.plan(context);
    const planRecord = assertRecordV1(planned, "read-only diagnostic plan");
    assertExactKeysV1(planRecord, ["actions", "capability"], "read-only diagnostic plan");
    if (planRecord.capability !== capability)
      failGovernanceDoctorV1("read-only diagnostic plan has an unexpected capability");
    const actions = assertArrayV1(planRecord.actions, 1, 64, "read-only diagnostic actions");
    const outcomes: ProbeOutcomeV1[] = [];
    for (const value of actions) {
      outcomes.push(...(await actionVerdicts(value, context)));
      if (outcomes.length > MAX_DIAGNOSTIC_CHECKS)
        failGovernanceDoctorV1("read-only diagnostic checks exceed their bounded cardinality");
    }
    const unresolved = outcomes.filter((outcome) => outcome.verdict !== "pass");
    if (unresolved.length > 0) {
      const findings = mechanicalFindings(diagnosticId, unresolved);
      return findings === undefined
        ? { diagnosticId, outcome: { kind: "refusal", state: "evidence-gap" } }
        : { diagnosticId, outcome: { findings, kind: "findings" } };
    }
  } catch {
    return undefined;
  }
  return {
    diagnosticId,
    outcome: {
      findings: [
        {
          code: GOVERNANCE_DOCTOR_READ_ONLY_PROBES_COMPLETED_V1,
          severity: "info",
          summary: {
            attribution: OPERATIONAL_ATTRIBUTION,
            text: "AIH read-only diagnostic probes completed.",
          },
        },
      ],
      kind: "findings",
    },
  };
}

/**
 * Builds the foundation's branded registry from this run's fixed safe outcomes,
 * dispatching the code-owned adapters in stable table order. A failed adapter is
 * an `evidence-gap`; `missing-adapter` remains reserved for a declared frozen ID
 * that has no code-owned adapter.
 */
async function diagnosticRegistry(context: PlanContext, profile: GovernanceDoctorProfileV1) {
  const diagnostics: Json[] = [];
  for (const adapter of EXECUTABLE_DIAGNOSTIC_ADAPTERS) {
    if (!profile.diagnosticIds.includes(adapter.diagnosticId)) continue;
    const result = await diagnosticObservation(context, profile, adapter);
    diagnostics.push(
      result ?? {
        diagnosticId: adapter.diagnosticId,
        outcome: { kind: "refusal", state: "evidence-gap" },
      },
    );
  }
  if (diagnostics.length === 0)
    failGovernanceDoctorV1("operational profile has no code-owned diagnostic adapter");
  return createGovernanceDoctorDiagnosticRegistryV1({
    diagnostics,
  });
}

/**
 * The audit-level refusal this run already knows about, decided from the policy
 * decision and the profile's declared versions alone -- before any diagnostic is
 * planned or run.
 */
function precondition(
  decision: "allowed" | "denied",
  profile: GovernanceDoctorProfileV1,
): GovernanceDoctorAuditRefusalStateV1 | undefined {
  if (decision === "denied") return "policy-denied";
  if (!isGovernanceDoctorProfileCompatibleV1(profile)) return "compatibility-required";
  return undefined;
}

/**
 * Runs one Governance Doctor operation: gate the policy and the profile, dispatch
 * only a code-owned bounded subset of frozen read-only diagnostics, convert their
 * fixed safe outcomes into the foundation's registry, then produce the Audit, the Guide, and the record
 * that binds all three to this exact run.
 */
export async function runGovernanceDoctorOperationV1(
  input: unknown,
): Promise<GovernanceDoctorOperationV1> {
  const request = assertRecordV1(input, "governance doctor operation request");
  assertExactKeysV1(
    request,
    ["context", "policy", "profile"],
    "governance doctor operation request",
  );

  const profileSha256 = governanceDoctorProfileV1Sha256(request.profile);
  const profile = request.profile as GovernanceDoctorProfileV1;

  const policy = assertRecordV1(request.policy, "policy state");
  assertExactKeysV1(policy, ["decision", "revisionSha256"], "policy state");
  const decision = assertEnumV1(policy.decision, POLICY_DECISIONS, "policy decision");
  const policyRevisionSha256 = assertSha256V1(policy.revisionSha256, "policy revision");

  const context = operationalContext(request.context);
  const binding = operationBinding(context, profile);

  // Refusal is settled here, so a denied or incompatible run executes no
  // diagnostic plan or probe.
  const registry =
    precondition(decision, profile) === undefined
      ? await diagnosticRegistry(context, profile)
      : undefined;

  const audit = runGovernanceDoctorAuditV1({
    policy: { decision, revisionSha256: policyRevisionSha256 },
    profile,
    registry: registry ?? NO_DIAGNOSTIC_REGISTRY,
  });
  const guide = renderGovernanceDoctorGuideV1({ audit, profile });
  const dispatchedDiagnosticIds = registry === undefined ? [] : [...registry.diagnosticIds];

  const identities = {
    auditSha256: audit.auditSha256,
    contextSha256: binding.contextSha256,
    guideSha256: guide.guideSha256,
    policyRevisionSha256,
    profileSha256,
    protocol: PROTOCOL,
    rootSha256: binding.rootSha256,
    surfaceRevisionSha256: binding.surfaceRevisionSha256,
    targetId: binding.targetId,
  };
  const record = createGovernanceDoctorOperationV1Record({
    audit,
    guide,
    record:
      audit.kind === "refused"
        ? { ...identities, actionable: false, kind: "refused", state: audit.state }
        : { ...identities, dispatchedDiagnosticIds, kind: "completed" },
  });
  return Object.freeze({ audit, guide, record });
}
