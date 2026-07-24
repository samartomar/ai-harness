import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists, retryTransient } from "../internals/fsxn.js";
import { type HostTuple, SUPPORTED_HOST_TUPLE } from "./host-tuple.js";
import type { ContextCostReport } from "./hosts/claude/context-cost.js";
import { isHomeScopedTarget } from "./hosts/claude/plugin-identity.js";
import { type BindingLock, bindingDir } from "./lock.js";
import type {
  FrameworkCardDisclosure,
  RawSourceOutcome,
  SelectedProfileGate,
} from "./scan-gate.js";
import { type BindingSource, BindingSourceSchema, FRAMEWORK_IDS } from "./schema.js";

/**
 * The typed, versioned Framework Card (W7 design §A) — a single derived,
 * rebuildable evidence record that REPLACES the three ad-hoc `lines` formatters
 * the adapters shipped. Each `report()` builds a card; {@link renderFrameworkCard}
 * emits the human view from it. The committed DECLARATION stays the only
 * authority (D7); the card is regenerated on a `cardVersion` bump (O2 — no
 * migration machinery).
 *
 * H3/O3: the COMMITTED card carries NO machine-local path.
 * {@link assertNoMachineLocalPath} fails closed on any absolute path, drive
 * letter, `~/`, `$HOME`, or `%USERPROFILE%` in any string field, reusing the
 * lock's `home:`/repo-relative label convention (a `home:`-prefixed label is a
 * portable machine-scope MARKER, not a machine path, and is accepted).
 *
 * H4/O1: the support label is NOT self-asserted. A card build takes an optional
 * {@link DoctorCardInput}; STRICT is issued ONLY when the framework's
 * (aspirational) `targetLabel` is strict-capable AND the doctor reports
 * contamination-clean AND in-tuple. Absent input ⇒ never STRICT (falls to
 * `PROJECT_BINDING_CONFLICTED` / `HOST_BINDING_UNVALIDATED`).
 */

export const CARD_SCHEMA_VERSION = 1 as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The D13 support-label taxonomy (design §A.2). */
export const SUPPORT_LABELS = [
  "STRICT_PROJECT_BINDING_VERIFIED",
  "PROJECT_BINDING_CONFLICTED",
  "PROJECT_SELECTED_SHARED_RUNTIME",
  "REFERENCE_ONLY",
  "DEFERRED",
  "PACKAGE_CI_VALIDATED",
  "HOST_BINDING_UNVALIDATED",
] as const;
export type SupportLabel = (typeof SUPPORT_LABELS)[number];
const SupportLabelSchema = z.enum(SUPPORT_LABELS);

/** The one strict-capable label — every other target composes as its own support label. */
const STRICT_LABEL: SupportLabel = "STRICT_PROJECT_BINDING_VERIFIED";

const NonNegInt = z.number().int().nonnegative();

const HostTupleSchema = z
  .object({
    claudeCode: z.object({ measuredOn: z.string().min(1) }).strict(),
    windowsBuild: z.string().min(1),
    windowsUbr: z.string().min(1).optional(),
    arch: z.string().min(1),
    node: z.string().min(1),
    bun: z.string().min(1),
    ramClassGb: NonNegInt,
    vcpuClass: NonNegInt,
  })
  .strict();

/** Per-event hook chain entry (design §A.2 / §B.6). Populated by the Phase 1b hook probe. */
export const HookEntrySchema = z
  .object({
    event: z.string().min(1),
    matcher: z.string().min(1).optional(),
    commandOrigin: z.string().min(1),
    scope: z.enum(["home", "project", "local"]),
  })
  .strict();
export type HookEntry = z.infer<typeof HookEntrySchema>;

/** A shared-state / config / binary / backup surface the binding touches (design §A.2). */
export const SharedStateEntrySchema = z
  .object({
    label: z.string().min(1),
    kind: z.enum(["state-dir", "config", "binary", "backup"]),
    note: z.string().min(1).optional(),
  })
  .strict();
export type SharedStateEntry = z.infer<typeof SharedStateEntrySchema>;

/** Context-cost projection (design §A.2, wrapping `ContextCostReport`). */
export const ContextCostCardSchema = z
  .object({
    /** False when the evidence source could not produce a projection (e.g. install root absent). */
    available: z.boolean(),
    evidenceSource: z.enum(["host-reported", "aih-estimate"]),
    /** Non-authoritative human label / reason — MUST carry no machine-local path. */
    evidence: z.string().min(1),
    projectedTokens: NonNegInt.optional(),
    estimate: z.boolean(),
  })
  .strict();
export type ContextCostCard = z.infer<typeof ContextCostCardSchema>;

/**
 * The W8 Framework Value Gate disclosure (design §"New card fragment") — the
 * CREDIT side shown SIDE BY SIDE with the cost debit and scan/support risk, never
 * a composite. Surface deltas use `z.number().int()` (NOT NonNeg): a contaminated
 * baseline can drive a negative delta, and the honest measurement must survive
 * to drive INSUFFICIENT rather than be clamped to look clean (Q8).
 */
export const FrameworkValueCardSchema = z
  .object({
    verdict: z.enum(["DELIVERS_VALUE", "INSUFFICIENT_VALUE", "INCOMPLETE_MEASUREMENT"]),
    invocableSurfaceDelta: z.number().int(),
    governanceSurfaceDelta: z.number().int(),
    /** The context-cost debit (disclosed; its pass/fail lives in the cost gate, not here). */
    contextCostTokens: NonNegInt.optional(),
    characteristicWorkflow: z
      .object({
        name: z.string().min(1),
        succeeded: z.boolean(),
        baselineAbsent: z.boolean(),
      })
      .strict(),
    dimensionsDelivered: z.array(z.string().min(1)),
    minSurfaceDelta: NonNegInt,
    /** Project C evidence id (path-free per H3). */
    baselineRef: z.string().min(1),
  })
  .strict();
export type FrameworkValueCard = z.infer<typeof FrameworkValueCardSchema>;

const BySeveritySchema = z
  .object({
    info: NonNegInt,
    low: NonNegInt,
    medium: NonNegInt,
    high: NonNegInt,
    critical: NonNegInt,
  })
  .strict();

/**
 * The rule-9 five-way scan disclosure (design §A.2 — mirrors
 * `FrameworkCardDisclosure` at `scan-gate.ts:1009`, the never-surfaced type W7
 * surfaces). Kept structurally in sync via {@link scanCardIdentity}, whose typed
 * `disclosure` parameter is the real scan-gate type.
 */
export const FrameworkCardDisclosureSchema = z
  .object({
    rawFindings: z
      .object({ total: NonNegInt, high: NonNegInt, bySeverity: BySeveritySchema })
      .strict(),
    closureFindings: z
      .object({ total: NonNegInt, high: NonNegInt, unknownReachability: NonNegInt })
      .strict(),
    inertFindings: z.object({ total: NonNegInt, high: NonNegInt }).strict(),
    acceptedRuntimeFindings: z.object({ total: NonNegInt }).strict(),
    visibleTypographyAdvisories: z.object({ total: NonNegInt, files: NonNegInt }).strict(),
    residualRisk: z
      .object({
        blockingUnaccepted: NonNegInt,
        unknownReachability: NonNegInt,
        inertReported: NonNegInt,
      })
      .strict(),
  })
  .strict();

/** The scan-identity fragment (design §A.2). `deepScanKey`/`runtimeQualKey` are Phase-2. */
export const ScanCardIdentitySchema = z
  .object({
    rawSourceScan: z.enum(["FINDINGS_PRESENT", "CLEAN"]),
    selectedProfileGate: z.enum(["ALLOW", "ALLOW_WITH_CONDITIONS", "BLOCK"]),
    disclosure: FrameworkCardDisclosureSchema,
    deepScanKey: z.string().min(1).optional(),
    runtimeQualKey: z.string().min(1).optional(),
    coverage: z.array(
      z
        .object({
          dimension: z.string().min(1),
          status: z.enum(["produced", "missing"]),
          reason: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ScanCardIdentity = z.infer<typeof ScanCardIdentitySchema>;

const CountsSchema = z
  .object({
    skills: NonNegInt,
    agents: NonNegInt,
    commands: NonNegInt,
    rules: NonNegInt,
    hooks: NonNegInt,
    mcpServers: NonNegInt,
  })
  .strict();
export type FrameworkCardCounts = z.infer<typeof CountsSchema>;

/**
 * The typed Framework Card (design §A.2). Strict + versioned. The D7 identity
 * (`scannedDigest`/`loadedDigest`/`match`) is optional as a group — a
 * not-yet-provisioned preview card carries none of the three; a provisioned card
 * carries all three with `match === (scannedDigest === loadedDigest)`, mirroring
 * the lock's own invariant. `contextCost`/`scanCache` are optional: the scan
 * disclosure is a provision-time artifact (supplied by Phase 1b/provision), and a
 * preview has no cost projection.
 */
export const FrameworkCardSchema = z
  .object({
    cardVersion: z.literal(CARD_SCHEMA_VERSION),
    framework: z.enum(FRAMEWORK_IDS),
    mode: z.enum(["lean", "full"]).optional(),
    host: z.literal("claude"),
    scope: z.enum(["project", "shared-runtime"]),
    supportLabel: SupportLabelSchema,
    targetLabel: SupportLabelSchema,
    source: BindingSourceSchema,
    scannedDigest: z.string().regex(SHA256_HEX).optional(),
    loadedDigest: z.string().regex(SHA256_HEX).optional(),
    match: z.boolean().optional(),
    installMechanism: z.string().min(1),
    verifiedHostTuple: HostTupleSchema,
    counts: CountsSchema,
    hooks: z.array(HookEntrySchema),
    mcpServers: z.array(z.string().min(1)),
    scriptsBinariesDeps: z.array(z.string().min(1)),
    network: z.string().min(1),
    update: z.string().min(1),
    telemetry: z.string().min(1),
    lockdown: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()),
    sharedState: z.array(SharedStateEntrySchema),
    contextCost: ContextCostCardSchema.optional(),
    scanCache: ScanCardIdentitySchema.optional(),
    valueGate: FrameworkValueCardSchema.optional(),
    residualRisks: z.array(z.string().min(1)),
    enterpriseDisposition: z.string(),
  })
  .strict()
  .superRefine((card, ctx) => {
    const present = [card.scannedDigest, card.loadedDigest, card.match].filter(
      (value) => value !== undefined,
    ).length;
    if (present !== 0 && present !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message:
          "the D7 identity (scannedDigest, loadedDigest, match) must be all present or all absent",
      });
    }
    if (
      card.scannedDigest !== undefined &&
      card.match !== (card.scannedDigest === card.loadedDigest)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["match"],
        message: "match must equal (scannedDigest === loadedDigest)",
      });
    }
  });

export type FrameworkCard = z.infer<typeof FrameworkCardSchema>;

/** Corrupt / schema-invalid / machine-path-carrying card — fail closed, never guess. */
export class FrameworkCardError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_CARD");
  }
}

export function parseFrameworkCard(value: unknown): FrameworkCard {
  return FrameworkCardSchema.parse(value);
}

// -- no-machine-local-path validator (H3, enforced at build) -----------------

/**
 * True for a string that embeds a machine-local path shape the committed card
 * must never carry (H3): a POSIX/UNC absolute path, a Windows drive letter, or a
 * literal `~/`, `$HOME`, or `%USERPROFILE%`. The `home:`-prefixed label
 * convention is deliberately ACCEPTED — it is a portable machine-scope marker,
 * not a resolved path (mirrors what `isSafeRelPosixPath` rejects for writes).
 */
function isMachineLocalString(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(value)) return true;
  if (value.includes("~/")) return true;
  if (value.includes("$HOME")) return true;
  if (value.includes("%USERPROFILE%")) return true;
  return false;
}

function walkForMachineLocalPath(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (isMachineLocalString(value)) {
      throw new FrameworkCardError(
        `Framework Card carries a machine-local path at ${path || "(root)"}: ${JSON.stringify(value)} ` +
          "(absolute paths, drive letters, ~/, $HOME, and %USERPROFILE% are rejected; use a home: or repo-relative label)",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkForMachineLocalPath(item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walkForMachineLocalPath(child, path === "" ? key : `${path}.${key}`);
    }
  }
}

/**
 * Fail closed unless EVERY string field of the card is free of a machine-local
 * path (H3). Enforced at card build (not just at serialize) so a leaked path is
 * refused before it can reach the committed file.
 */
export function assertNoMachineLocalPath(card: FrameworkCard): void {
  walkForMachineLocalPath(card, "");
}

// -- support-label derivation (H4/O1) ----------------------------------------

/** The doctor's two D13 inputs — contamination-clean AND in-tuple gate STRICT (H4). */
export interface DoctorCardInput {
  contaminationClean: boolean;
  inTuple: boolean;
}

/**
 * Downgrade the framework's aspirational `targetLabel` to the actual support
 * label (O1). STRICT is issued ONLY when the target is strict-capable AND the
 * doctor reports both contamination-clean and in-tuple. Contamination downgrades
 * to `PROJECT_BINDING_CONFLICTED` (O4); off-tuple to `HOST_BINDING_UNVALIDATED`
 * (O5, §B.3) — for a non-strict target too. Absent input never issues STRICT.
 */
export function deriveSupportLabel(
  targetLabel: SupportLabel,
  doctor: DoctorCardInput | undefined,
): SupportLabel {
  // A not-yet-provisioned preview stays deferred — there is nothing to verify.
  if (targetLabel === "DEFERRED") return "DEFERRED";
  const strictCapable = targetLabel === STRICT_LABEL;
  if (doctor === undefined) {
    return strictCapable ? "PROJECT_BINDING_CONFLICTED" : targetLabel;
  }
  if (!doctor.contaminationClean) return "PROJECT_BINDING_CONFLICTED";
  if (!doctor.inTuple) return "HOST_BINDING_UNVALIDATED";
  return strictCapable ? STRICT_LABEL : targetLabel;
}

// -- shared card fragments (design §A.3.1) -----------------------------------

/** The D7 identity fragment (source + scanned/loaded/match) recovered from a lock. */
export function sourceIdentityFromLock(lock: BindingLock): {
  source: BindingSource;
  identity: { scannedDigest: string; loadedDigest: string; match: boolean };
} {
  return {
    source: lock.declaration.source,
    identity: {
      scannedDigest: lock.scannedDigest,
      loadedDigest: lock.loadedDigest,
      match: lock.match,
    },
  };
}

/**
 * The D18 ownership-target split every adapter report already computed
 * (`isHomeScopedTarget`): repo-relative targets vs `home:`-prefixed machine-scope
 * targets. Both sorted for determinism; both are portable labels (no abs path).
 */
export function d18SurfaceLabels(lock: BindingLock): {
  repoRelative: string[];
  homeScope: string[];
} {
  const repoRelative = lock.ownership
    .filter((entry) => !isHomeScopedTarget(entry.target))
    .map((entry) => entry.target)
    .sort();
  const homeScope = lock.ownership
    .filter((entry) => isHomeScopedTarget(entry.target))
    .map((entry) => entry.target)
    .sort();
  return { repoRelative, homeScope };
}

/** Wrap a produced `ContextCostReport` into the card's cost + counts fragment. */
export function contextCostCard(report: ContextCostReport): {
  contextCost: ContextCostCard;
  counts: FrameworkCardCounts;
} {
  return {
    contextCost: {
      available: true,
      evidenceSource: report.source,
      evidence: report.evidence,
      ...(report.projectedTokens !== undefined ? { projectedTokens: report.projectedTokens } : {}),
      estimate: report.estimate,
    },
    counts: { ...report.counts },
  };
}

/**
 * A cost fragment for the case the evidence source could not project (install
 * root absent, resolved checkout path not recorded, …). The `reason` MUST be a
 * clean, path-free label — a raw estimator error message may embed an absolute
 * path and must NOT be threaded through here.
 */
export function contextCostUnavailable(reason: string): ContextCostCard {
  return { available: false, evidenceSource: "aih-estimate", evidence: reason, estimate: true };
}

/**
 * The scan-identity fragment (design §A.2), the seam Phase 1b/provision fills
 * from a live `ScanDisposition`. The `disclosure` parameter is the real
 * `FrameworkCardDisclosure` (scan-gate.ts:1009) so the card schema and the
 * disposition stay structurally in sync.
 */
export function scanCardIdentity(input: {
  rawSourceScan: RawSourceOutcome;
  selectedProfileGate: SelectedProfileGate;
  disclosure: FrameworkCardDisclosure;
  coverage?: { dimension: string; status: "produced" | "missing"; reason?: string }[];
  deepScanKey?: string;
  runtimeQualKey?: string;
}): ScanCardIdentity {
  return ScanCardIdentitySchema.parse({
    rawSourceScan: input.rawSourceScan,
    selectedProfileGate: input.selectedProfileGate,
    disclosure: input.disclosure,
    coverage: input.coverage ?? [],
    ...(input.deepScanKey !== undefined ? { deepScanKey: input.deepScanKey } : {}),
    ...(input.runtimeQualKey !== undefined ? { runtimeQualKey: input.runtimeQualKey } : {}),
  });
}

// -- card build --------------------------------------------------------------

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Build input — the typed facts an adapter `report()`/`provision()` supplies. */
export interface FrameworkCardBuildInput {
  framework: FrameworkCard["framework"];
  mode?: "lean" | "full";
  scope: "project" | "shared-runtime";
  /** The framework's aspirational label; downgraded to the support label via `doctor`. */
  targetLabel: SupportLabel;
  source: BindingSource;
  /** The D7 identity, when provisioned (all three or none). */
  identity?: { scannedDigest: string; loadedDigest: string; match: boolean };
  installMechanism: string;
  /** Defaults to `SUPPORTED_HOST_TUPLE` (the pinned tuple the binding targets). */
  verifiedHostTuple?: HostTuple;
  counts?: Partial<FrameworkCardCounts>;
  hooks?: HookEntry[];
  mcpServers?: string[];
  scriptsBinariesDeps?: string[];
  network?: string;
  update?: string;
  telemetry?: string;
  lockdown?: { key: string; value: string }[];
  sharedState?: SharedStateEntry[];
  contextCost?: ContextCostCard;
  scanCache?: ScanCardIdentity;
  valueGate?: FrameworkValueCard;
  residualRisks?: string[];
  enterpriseDisposition?: string;
  /** Absent ⇒ support label is NEVER STRICT (O1). Supplied by the Phase 1b doctor. */
  doctor?: DoctorCardInput;
}

const ZERO_COUNTS: FrameworkCardCounts = {
  skills: 0,
  agents: 0,
  commands: 0,
  rules: 0,
  hooks: 0,
  mcpServers: 0,
};

/**
 * Assemble a validated, canonical, machine-path-free {@link FrameworkCard}.
 * Arrays are canonicalized (sorted, deduped) at build so the card itself is
 * deterministic, and the zod schema + {@link assertNoMachineLocalPath} both run
 * before it is returned — an invalid or path-leaking card can never escape.
 */
export function buildFrameworkCard(input: FrameworkCardBuildInput): FrameworkCard {
  const supportLabel = deriveSupportLabel(input.targetLabel, input.doctor);
  const candidate = {
    cardVersion: CARD_SCHEMA_VERSION,
    framework: input.framework,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    host: "claude" as const,
    scope: input.scope,
    supportLabel,
    targetLabel: input.targetLabel,
    source: input.source,
    ...(input.identity !== undefined
      ? {
          scannedDigest: input.identity.scannedDigest,
          loadedDigest: input.identity.loadedDigest,
          match: input.identity.match,
        }
      : {}),
    installMechanism: input.installMechanism,
    verifiedHostTuple: input.verifiedHostTuple ?? SUPPORTED_HOST_TUPLE,
    counts: { ...ZERO_COUNTS, ...input.counts },
    hooks: [...(input.hooks ?? [])].sort((left, right) =>
      JSON.stringify([left.event, left.matcher ?? "", left.commandOrigin]).localeCompare(
        JSON.stringify([right.event, right.matcher ?? "", right.commandOrigin]),
      ),
    ),
    mcpServers: uniqueSorted(input.mcpServers ?? []),
    scriptsBinariesDeps: uniqueSorted(input.scriptsBinariesDeps ?? []),
    network: input.network ?? "unspecified",
    update: input.update ?? "unspecified",
    telemetry: input.telemetry ?? "unspecified",
    lockdown: [...(input.lockdown ?? [])].sort((left, right) => left.key.localeCompare(right.key)),
    sharedState: [...(input.sharedState ?? [])].sort((left, right) =>
      JSON.stringify([left.label, left.kind]).localeCompare(
        JSON.stringify([right.label, right.kind]),
      ),
    ),
    ...(input.contextCost !== undefined ? { contextCost: input.contextCost } : {}),
    ...(input.scanCache !== undefined ? { scanCache: input.scanCache } : {}),
    ...(input.valueGate !== undefined ? { valueGate: input.valueGate } : {}),
    residualRisks: uniqueSorted(input.residualRisks ?? []),
    enterpriseDisposition: input.enterpriseDisposition ?? "",
  };
  const card = FrameworkCardSchema.parse(candidate);
  assertNoMachineLocalPath(card);
  return card;
}

// -- deterministic renderer (single replacement for the three ad-hoc formatters) --

function pinLabel(source: BindingSource): string {
  return source.kind === "git"
    ? `${source.repository}@${source.commitSha}`
    : `${source.package}@${source.exactVersion}`;
}

function hostTupleLine(tuple: HostTuple): string {
  return (
    `verified host tuple: claudeCode ${tuple.claudeCode.measuredOn} (provenance), ` +
    `windowsBuild ${tuple.windowsBuild}, arch ${tuple.arch}, node ${tuple.node}, bun ${tuple.bun}, ` +
    `ram-class ${tuple.ramClassGb}gb, vcpu-class ${tuple.vcpuClass}`
  );
}

function costLines(card: FrameworkCard): string[] {
  const cost = card.contextCost;
  if (cost === undefined) return [];
  if (!cost.available) return [`context-cost estimate: unavailable (${cost.evidence})`];
  const tokens =
    cost.projectedTokens !== undefined ? `~${cost.projectedTokens} tokens` : "unknown tokens";
  const label = cost.estimate ? `${cost.evidence}, labeled estimate` : cost.evidence;
  const { skills, agents, commands, rules, hooks, mcpServers } = card.counts;
  return [
    `context-cost estimate (${label}): ${tokens} ` +
      `(skills ${skills}, agents ${agents}, commands ${commands}, rules ${rules}, ` +
      `hooks ${hooks}, mcpServers ${mcpServers})`,
  ];
}

function scanCacheLines(card: FrameworkCard): string[] {
  const scan = card.scanCache;
  if (scan === undefined) return [];
  const lines = [
    `raw source scan: ${scan.rawSourceScan}`,
    `selected-profile gate: ${scan.selectedProfileGate}`,
    `scan disclosure: raw ${scan.disclosure.rawFindings.total} (high ${scan.disclosure.rawFindings.high}), ` +
      `closure ${scan.disclosure.closureFindings.total} (high ${scan.disclosure.closureFindings.high}, ` +
      `unknown-reachability ${scan.disclosure.closureFindings.unknownReachability}), ` +
      `inert ${scan.disclosure.inertFindings.total}, accepted-runtime ${scan.disclosure.acceptedRuntimeFindings.total}, ` +
      `visible-typography ${scan.disclosure.visibleTypographyAdvisories.total}, ` +
      `residual blocking-unaccepted ${scan.disclosure.residualRisk.blockingUnaccepted}`,
  ];
  for (const entry of [...scan.coverage].sort((left, right) =>
    left.dimension.localeCompare(right.dimension),
  )) {
    lines.push(
      `coverage ${entry.dimension}: ${entry.status}${entry.reason !== undefined ? ` (${entry.reason})` : ""}`,
    );
  }
  return lines;
}

/** A signed integer label, e.g. `+5` / `-3` / `0` (deltas may be negative, Q8). */
function signedDelta(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

/**
 * The W8 value-gate disclosure lines. HONEST framing (Q6/D13): the workflow line
 * names the framework-DELIVERED SURFACE that is absent in no-framework — it NEVER
 * claims the base model cannot review/plan ad hoc — and carries NO composite
 * score, ratio, or "best" wording (the value verdict is orthogonal to cost/risk,
 * which are disclosed on their own lines).
 */
function valueLines(card: FrameworkCard): string[] {
  const value = card.valueGate;
  if (value === undefined) return [];
  const workflow = value.characteristicWorkflow;
  const lines = [
    `value gate: ${value.verdict} ` +
      `(invocable surface delta ${signedDelta(value.invocableSurfaceDelta)}, ` +
      `governance surface delta ${signedDelta(value.governanceSurfaceDelta)}, ` +
      `min surface delta ${value.minSurfaceDelta})`,
  ];
  if (workflow.succeeded && workflow.baselineAbsent) {
    lines.push(
      `characteristic workflow: delivers the ${workflow.name} workflow surface, absent in no-framework`,
    );
  } else if (!workflow.succeeded) {
    lines.push(`characteristic workflow ${workflow.name}: did not succeed in the bound session`);
  } else {
    lines.push(
      `characteristic workflow ${workflow.name} surface: also present in the no-framework baseline`,
    );
  }
  if (value.dimensionsDelivered.length > 0) {
    lines.push(`dimensions delivered: ${value.dimensionsDelivered.join(", ")}`);
  }
  if (value.contextCostTokens !== undefined) {
    lines.push(
      `context-cost debit: ~${value.contextCostTokens} tokens (disclosed; gated by the cost gate)`,
    );
  }
  lines.push(`value baseline: ${value.baselineRef}`);
  return lines;
}

/**
 * The single deterministic renderer that REPLACES the three ad-hoc `lines`
 * builders. A pure function of the card (arrays already canonical), so two
 * renders of the same card are byte-identical.
 */
export function renderFrameworkCard(card: FrameworkCard): string[] {
  const lines: string[] = [`framework: ${card.framework}`];
  if (card.mode !== undefined) lines.push(`mode: ${card.mode}`);
  lines.push(`host: ${card.host}`);
  lines.push(`scope: ${card.scope}`);
  lines.push(`pin: ${pinLabel(card.source)}`);
  lines.push(`support label: ${card.supportLabel}`);
  lines.push(`target label: ${card.targetLabel}`);
  lines.push(`install mechanism: ${card.installMechanism}`);

  if (card.scannedDigest !== undefined && card.loadedDigest !== undefined) {
    lines.push(`scannedDigest: ${card.scannedDigest}`);
    lines.push(`loadedDigest: ${card.loadedDigest}`);
    lines.push(`match: ${String(card.match)}`);
  } else {
    lines.push("binding lock: absent (not yet provisioned)");
  }

  lines.push(hostTupleLine(card.verifiedHostTuple));
  lines.push(
    `mcp connectors selected (${card.mcpServers.length}): ` +
      `${card.mcpServers.length > 0 ? card.mcpServers.join(", ") : "(none)"}`,
  );

  for (const hook of card.hooks) {
    lines.push(
      `hook ${hook.event}${hook.matcher !== undefined ? ` [${hook.matcher}]` : ""}: ` +
        `${hook.commandOrigin} (${hook.scope})`,
    );
  }

  lines.push(
    `surface labels: ${card.scriptsBinariesDeps.length > 0 ? card.scriptsBinariesDeps.join(", ") : "(none)"}`,
  );

  lines.push(`network: ${card.network}`);
  lines.push(`update: ${card.update}`);
  lines.push(`telemetry: ${card.telemetry}`);

  for (const entry of card.lockdown) lines.push(`lockdown ${entry.key}: ${entry.value}`);

  for (const entry of card.sharedState) {
    lines.push(
      `shared state [${entry.kind}] ${entry.label}${entry.note !== undefined ? `: ${entry.note}` : ""}`,
    );
  }

  lines.push(...costLines(card));
  lines.push(...scanCacheLines(card));
  lines.push(...valueLines(card));

  for (const risk of card.residualRisks) lines.push(risk);
  if (card.enterpriseDisposition.length > 0) lines.push(card.enterpriseDisposition);

  return lines;
}

// -- committed-card read/write (O8 — mirrors writeBindingLockAtomic) ----------

/** `<root>/.aih/binding/framework-card.json` — beside the lock (O8). */
export function frameworkCardPath(root: string): string {
  return join(bindingDir(root), "framework-card.json");
}

function assertNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new FrameworkCardError(`refusing symlinked framework-card path: ${path}`);
  }
}

function prepareBindingDir(root: string): string {
  let current = root;
  for (const segment of [".aih", "binding"]) {
    current = join(current, segment);
    assertNotSymlink(current);
    if (!existsSync(current)) mkdirSync(current, { recursive: false, mode: 0o700 });
  }
  return current;
}

/**
 * Atomically write the committed card (validate + no-machine-path -> temp file
 * with owner-only mode -> rename), mirroring `writeBindingLockAtomic`
 * (`lock.ts:180`). The card is O8's provision output; the provision-side CALL
 * SITE is Phase 1b — this is the function it wires to.
 */
export function writeFrameworkCardAtomic(root: string, card: FrameworkCard): void {
  const parsed = parseFrameworkCard(card);
  assertNoMachineLocalPath(parsed);
  const contents = `${JSON.stringify(parsed, null, 2)}\n`;
  const directory = prepareBindingDir(root);
  const path = frameworkCardPath(root);
  assertNotSymlink(path);
  const temporary = join(directory, `.framework-card.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    retryTransient(() => renameSync(temporary, path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Read the committed card. Absent => `undefined`. A present-but-unparseable /
 * schema-invalid / machine-path-carrying card FAILS CLOSED with
 * {@link FrameworkCardError} — a damaged derived record is never silently
 * treated as empty (mirrors `readBindingLock`).
 */
export function readFrameworkCard(root: string): FrameworkCard | undefined {
  const path = frameworkCardPath(root);
  assertNotSymlink(path);
  const raw = readIfExists(path);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FrameworkCardError(`framework card is not valid JSON: ${path}`);
  }
  const result = FrameworkCardSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new FrameworkCardError(`invalid framework card ${path}${where}`);
  }
  assertNoMachineLocalPath(result.data);
  return result.data;
}
