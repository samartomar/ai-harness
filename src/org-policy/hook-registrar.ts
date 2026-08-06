import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readRegularFile } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { withExpectedContents } from "../mcp/managed-projection.js";
import { stableJson } from "./effective.js";
import { OrgPolicyError } from "./schema.js";

/**
 * The `hook-managed-settings` projector.
 *
 * AIH is the sole REGISTRAR of client hook entries; third-party runtimes stay
 * the EXECUTORS. Those are different ownerships, and the whole module turns on
 * keeping them apart:
 *
 *  - Activating a registry — executing a third party's handlers under AIH's
 *    dispatcher identity — is forbidden. Nothing here loads, parses, interprets
 *    or re-emits a third party's command.
 *  - Projecting a registration — writing a third party's own launcher into a
 *    destination AIH owns, with a receipt that can revoke it — is what this
 *    module does. It is the only way an installed third-party hook can ever be
 *    uninstalled. Where a source ships no removal path of its own, the receipt
 *    is the only removal authority there is. The specific third-party
 *    observation behind that lives in the decision log, not here: this file
 *    holds no evidence for it and must not assert it as fact.
 *
 * A projected third-party command is transported, never transformed. The only
 * thing AIH computes about it is a hash, and the only thing that hash is used
 * for is proving it did not change.
 */

/** The one destination this projector owns. */
export const HOOK_REGISTRAR_DESTINATION = ".claude/settings.json";
export const HOOK_REGISTRAR_RECEIPT_PATH = ".aih/org-policy-hook-registrar-receipt.json";
export const HOOK_REGISTRAR_RECEIPT_FORMAT = "aih-org-policy-hook-registrar-receipt";

/**
 * Claude is the only supported target. Codex publishes no per-event hook output
 * contract AIH has evidence for, and inventing one would be a guess — the same
 * reason the ECC composite dispatcher was deliberately left Codex-unchanged.
 */
export const HOOK_REGISTRAR_TARGETS = ["claude"] as const;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be a sha256 digest");
const EventSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, "must be a native client hook event name");
const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,119}$/, "must be a safe registration identifier");

/**
 * A launcher is opaque bytes. It is length-bounded and rejected when it carries
 * control or hidden-Unicode characters, because those cannot survive a JSON
 * round trip into a client configuration intact — but it is never otherwise
 * inspected, and never rewritten.
 */
const LauncherCommandSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) => !/\p{C}/u.test(value),
    "must not contain control or hidden Unicode characters",
  );

const ThirdPartyLauncherPinSchema = z
  .object({
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be an owner/repository identity"),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be an exact commit"),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) => !value.includes("..") && !value.startsWith("/") && !value.startsWith("\\"),
        "must be a contained component path",
      ),
    launcherSha256: Sha256Schema,
    runtimeVersion: z.string().min(1).max(120),
  })
  .strict();

const HookRegistrationOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("aih") }).strict(),
  z
    .object({
      kind: z.literal("third-party"),
      framework: IdSchema,
      /**
       * Controls the source declares for its own hooks — recorded read-only.
       * AIH never implements, mirrors, or overrides them.
       */
      declaredControls: z.array(z.string().min(1).max(120)).max(20).default([]),
      pin: ThirdPartyLauncherPinSchema,
    })
    .strict(),
]);

const HookRegistrationSchema = z
  .object({
    id: IdSchema,
    event: EventSchema,
    command: LauncherCommandSchema,
    /**
     * Declared overlap keys. AIH never infers a function by reading a command:
     * one AIH composite dispatcher carries several, which is exactly why the
     * overlap key is per-function and not per-entry.
     */
    functionTags: z.array(IdSchema).min(1).max(20),
    /**
     * Operating-system processes ONE firing costs, including nested launcher
     * spawns. Never zero: a source that gates its own hooks does so inside the
     * launcher, after the process already exists.
     */
    spawns: z.number().int().min(1).max(64),
    timeout: z.number().int().min(1).max(600).optional(),
    /** The source's own controls report this hook off. It still costs a process. */
    sourceDisabled: z.boolean().default(false),
    owner: HookRegistrationOwnerSchema,
  })
  .strict();

export type ThirdPartyLauncherPin = z.infer<typeof ThirdPartyLauncherPinSchema>;
export type HookRegistrationOwner = z.infer<typeof HookRegistrationOwnerSchema>;
export interface HookRegistration extends z.input<typeof HookRegistrationSchema> {}
type ResolvedHookRegistration = z.infer<typeof HookRegistrationSchema>;

export interface ProjectedHookCommand {
  type: "command";
  command: string;
  timeout?: number;
}
export interface ProjectedHookGroup {
  hooks: ProjectedHookCommand[];
}
export interface ProjectedHookSettings {
  hooks: Record<string, ProjectedHookGroup[]>;
}

export function hookCommandDigest(command: string): string {
  return `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hookRegistrationOwnerId(registration: ResolvedHookRegistration): string {
  return registration.owner.kind === "aih" ? "aih" : registration.owner.framework;
}

/**
 * Validate a registration set at the boundary, and prove every third-party
 * launcher still matches its pin. A launcher whose hash moved is DRIFT — it is
 * refused here rather than projected, because projecting it would be a silent
 * update of code AIH cannot read.
 */
export function assertHookRegistrations(
  registrations: readonly HookRegistration[],
): ResolvedHookRegistration[] {
  const parsed = registrations.map((registration) => {
    const result = HookRegistrationSchema.safeParse(registration);
    if (!result.success) {
      throw new OrgPolicyError(
        `hook registration ${String(registration.id)} is invalid: ${result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  });
  const ids = new Set<string>();
  for (const registration of parsed) {
    if (ids.has(registration.id)) {
      throw new OrgPolicyError(`hook registration ${registration.id} is declared twice`);
    }
    ids.add(registration.id);
    if (registration.owner.kind !== "third-party") continue;
    const actual = hookCommandDigest(registration.command);
    if (actual !== registration.owner.pin.launcherSha256) {
      throw new OrgPolicyError(
        `hook registration ${registration.id} launcher hash ${actual} no longer matches its pin ` +
          `${registration.owner.pin.launcherSha256}; this is drift, not a silent update`,
      );
    }
  }
  return parsed;
}

function orderedEvents(registrations: readonly ResolvedHookRegistration[]): string[] {
  return [...new Set(registrations.map((registration) => registration.event))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Every selected registration becomes exactly one native entry. Overlapping
 * entries are BOTH projected: silent merging causes capability loss nothing
 * downstream can diagnose from the resulting configuration.
 */
export function projectedHookSettings(
  registrations: readonly HookRegistration[],
): ProjectedHookSettings {
  const parsed = assertHookRegistrations(registrations);
  const hooks: Record<string, ProjectedHookGroup[]> = {};
  for (const event of orderedEvents(parsed)) {
    hooks[event] = parsed
      .filter((registration) => registration.event === event)
      .map((registration) => ({
        hooks: [
          {
            type: "command" as const,
            // Verbatim. The source's own launcher, transported unchanged.
            command: registration.command,
            ...(registration.timeout === undefined ? {} : { timeout: registration.timeout }),
          },
        ],
      }));
  }
  return { hooks };
}

export interface HookOverlap {
  event: string;
  functionTag: string;
  owners: string[];
  registrations: string[];
}

/**
 * Two selected hooks on the same event that declare the same function overlap.
 * Reported with both owners named, and never auto-resolved: the administrator
 * decides, which trades convenience for diagnosability on purpose.
 */
export function hookOverlaps(registrations: readonly HookRegistration[]): HookOverlap[] {
  const parsed = assertHookRegistrations(registrations);
  const byKey = new Map<string, ResolvedHookRegistration[]>();
  for (const registration of parsed) {
    for (const tag of registration.functionTags) {
      const key = `${registration.event}\u0000${tag}`;
      byKey.set(key, [...(byKey.get(key) ?? []), registration]);
    }
  }
  const overlaps: HookOverlap[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const [event, functionTag] = key.split("\u0000");
    if (event === undefined || functionTag === undefined) continue;
    overlaps.push({
      event,
      functionTag,
      owners: [...new Set(members.map(hookRegistrationOwnerId))].sort((a, b) => a.localeCompare(b)),
      registrations: members.map((member) => member.id).sort((a, b) => a.localeCompare(b)),
    });
  }
  return overlaps.sort((a, b) =>
    a.event === b.event
      ? a.functionTag.localeCompare(b.functionTag)
      : a.event.localeCompare(b.event),
  );
}

export interface HookEventSpawnCost {
  event: string;
  entries: number;
  spawns: number;
}
export interface HookSpawnProjection {
  events: HookEventSpawnCost[];
  totalEntries: number;
  totalSpawns: number;
  /**
   * Processes spent on hooks the source's own controls report as off. This is
   * not zero and must never be modelled as zero: a source that evaluates its
   * disable list inside its launcher has already paid for the process.
   */
  sourceDisabledSpawns: number;
}

/** Per event, entries and expected process spawns — reported before apply. */
export function hookSpawnProjection(
  registrations: readonly HookRegistration[],
): HookSpawnProjection {
  const parsed = assertHookRegistrations(registrations);
  const events = orderedEvents(parsed).map((event) => {
    const members = parsed.filter((registration) => registration.event === event);
    return {
      event,
      entries: members.length,
      spawns: members.reduce((total, member) => total + member.spawns, 0),
    };
  });
  return {
    events,
    totalEntries: events.reduce((total, event) => total + event.entries, 0),
    totalSpawns: events.reduce((total, event) => total + event.spawns, 0),
    sourceDisabledSpawns: parsed
      .filter((registration) => registration.sourceDisabled)
      .reduce((total, registration) => total + registration.spawns, 0),
  };
}

export interface UnownedHookEntry {
  event: string;
  /** Attributed only where a declared launcher pin matches; otherwise `unknown`. */
  owner: string;
  command: string;
}
export interface DriftedHookEntry {
  id: string;
  event: string;
  reason: "missing" | "launcher-pin-mismatch";
}
export interface HookAdoptionOffer {
  event: string;
  command: string;
  commandSha256: string;
}
export interface HookDriftReport {
  destination: string;
  unowned: UnownedHookEntry[];
  drifted: DriftedHookEntry[];
  /** What AIH offers to take ownership of. It never absorbs one silently. */
  adoption: HookAdoptionOffer[];
}

interface DestinationEntry {
  event: string;
  command: string;
}

/** Flatten a native hook configuration into entries. Malformed shapes are refused. */
export function destinationHookEntries(destination: unknown): DestinationEntry[] {
  if (destination === undefined) return [];
  if (!isPlainObject(destination)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION} is not a JSON object`);
  }
  const hooks = destination.hooks;
  if (hooks === undefined) return [];
  if (!isPlainObject(hooks)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION}.hooks is not an object`);
  }
  const entries: DestinationEntry[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION}.hooks.${event} is not an array`);
    }
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        throw new OrgPolicyError(
          `${HOOK_REGISTRAR_DESTINATION}.hooks.${event} has a malformed hook group`,
        );
      }
      for (const hook of group.hooks) {
        if (!isPlainObject(hook) || typeof hook.command !== "string") continue;
        entries.push({ event, command: hook.command });
      }
    }
  }
  return entries;
}

/**
 * A destination containing entries AIH did not emit is drift. AIH reports them
 * by owner and event and offers adoption; it never silently absorbs one.
 */
export function hookRegistrarDrift(input: {
  destination: unknown;
  registrations: readonly HookRegistration[];
}): HookDriftReport {
  const parsed = input.registrations.map((registration) =>
    HookRegistrationSchema.parse(registration),
  );
  const onDisk = destinationHookEntries(input.destination);
  const expected = new Map(
    parsed.map((registration) => [
      `${registration.event}\u0000${registration.command}`,
      registration,
    ]),
  );
  const seen = new Set<string>();
  const unowned: UnownedHookEntry[] = [];
  const adoption: HookAdoptionOffer[] = [];
  for (const entry of onDisk) {
    const key = `${entry.event}\u0000${entry.command}`;
    if (expected.has(key)) {
      seen.add(key);
      continue;
    }
    // Attribution is only as good as a declared pin. Guessing an owner from a
    // command AIH does not interpret would be a fabricated claim.
    const digest = hookCommandDigest(entry.command);
    const attributed = parsed.find(
      (registration) =>
        registration.owner.kind === "third-party" &&
        registration.owner.pin.launcherSha256 === digest,
    );
    unowned.push({
      event: entry.event,
      owner: attributed === undefined ? "unknown" : hookRegistrationOwnerId(attributed),
      command: entry.command,
    });
    adoption.push({ event: entry.event, command: entry.command, commandSha256: digest });
  }
  const drifted: DriftedHookEntry[] = [];
  for (const registration of parsed) {
    if (
      registration.owner.kind === "third-party" &&
      hookCommandDigest(registration.command) !== registration.owner.pin.launcherSha256
    ) {
      drifted.push({
        id: registration.id,
        event: registration.event,
        reason: "launcher-pin-mismatch",
      });
      continue;
    }
    if (!seen.has(`${registration.event}\u0000${registration.command}`)) {
      drifted.push({ id: registration.id, event: registration.event, reason: "missing" });
    }
  }
  return { destination: HOOK_REGISTRAR_DESTINATION, unowned, drifted, adoption };
}

export interface HookReceiptEntry {
  id: string;
  event: string;
  owner: "aih" | "third-party";
  ownerId: string;
  command: string;
  commandSha256: string;
  spawns: number;
  functionTags: string[];
  sourceDisabled: boolean;
  declaredControls?: string[];
  pin?: ThirdPartyLauncherPin;
  timeout?: number;
}

export type HookReceiptPrior =
  | { state: "absent" }
  | { state: "present"; sha256: string; contents: string };

export interface HookRegistrarReceipt {
  format: typeof HOOK_REGISTRAR_RECEIPT_FORMAT;
  version: 1;
  destination: string;
  policyVersion?: string;
  /**
   * The bytes found before AIH first projected. EVIDENCE ONLY — the record of
   * what was there, readable during an investigation. Revocation subtracts the
   * owned key and never replays these bytes, which would reinstate every
   * adopted entry (governing ADR, A4).
   */
  prior: HookReceiptPrior;
  entries: HookReceiptEntry[];
}

function receiptEntry(registration: ResolvedHookRegistration): HookReceiptEntry {
  return {
    id: registration.id,
    event: registration.event,
    owner: registration.owner.kind === "aih" ? "aih" : "third-party",
    ownerId: hookRegistrationOwnerId(registration),
    command: registration.command,
    commandSha256: hookCommandDigest(registration.command),
    spawns: registration.spawns,
    functionTags: [...registration.functionTags],
    sourceDisabled: registration.sourceDisabled,
    ...(registration.owner.kind === "third-party"
      ? { declaredControls: [...registration.owner.declaredControls], pin: registration.owner.pin }
      : {}),
    ...(registration.timeout === undefined ? {} : { timeout: registration.timeout }),
  };
}

const HookReceiptSchema = z
  .object({
    format: z.literal(HOOK_REGISTRAR_RECEIPT_FORMAT),
    version: z.literal(1),
    destination: z.literal(HOOK_REGISTRAR_DESTINATION),
    policyVersion: z.string().min(1).max(200).optional(),
    prior: z.discriminatedUnion("state", [
      z.object({ state: z.literal("absent") }).strict(),
      z
        .object({
          state: z.literal("present"),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          contents: z.string().max(4 * 1024 * 1024),
        })
        .strict(),
    ]),
    entries: z
      .array(
        z
          .object({
            id: IdSchema,
            event: EventSchema,
            owner: z.enum(["aih", "third-party"]),
            ownerId: IdSchema,
            command: LauncherCommandSchema,
            commandSha256: Sha256Schema,
            spawns: z.number().int().min(1).max(64),
            functionTags: z.array(IdSchema).min(1).max(20),
            sourceDisabled: z.boolean(),
            declaredControls: z.array(z.string().min(1).max(120)).max(20).optional(),
            pin: ThirdPartyLauncherPinSchema.optional(),
            timeout: z.number().int().min(1).max(600).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(512),
  })
  .strict();

function destinationPath(root: string): string {
  return join(root, ...HOOK_REGISTRAR_DESTINATION.split("/"));
}

function readDestinationBytes(root: string): string | undefined {
  return readRegularFile(destinationPath(root))?.toString("utf8");
}

export function readHookRegistrarReceipt(root: string): HookRegistrarReceipt | undefined {
  const raw = readRegularFile(join(root, ...HOOK_REGISTRAR_RECEIPT_PATH.split("/")))?.toString(
    "utf8",
  );
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OrgPolicyError(
      `${HOOK_REGISTRAR_RECEIPT_PATH} is malformed; refusing hook ownership`,
    );
  }
  const result = HookReceiptSchema.safeParse(value);
  if (!result.success) {
    throw new OrgPolicyError(
      `${HOOK_REGISTRAR_RECEIPT_PATH} is not an AIH hook registrar receipt: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data as HookRegistrarReceipt;
}

function receiptRawBytes(root: string): string | undefined {
  return readRegularFile(join(root, ...HOOK_REGISTRAR_RECEIPT_PATH.split("/")))?.toString("utf8");
}

/** Rebuild the exact hook value a receipt says AIH owns. */
function expectedHooksFromReceipt(receipt: HookRegistrarReceipt): Record<string, unknown> {
  const hooks: Record<string, ProjectedHookGroup[]> = {};
  for (const event of [...new Set(receipt.entries.map((entry) => entry.event))].sort((a, b) =>
    a.localeCompare(b),
  )) {
    hooks[event] = receipt.entries
      .filter((entry) => entry.event === event)
      .map((entry) => ({
        hooks: [
          {
            type: "command" as const,
            command: entry.command,
            ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
          },
        ],
      }));
  }
  return hooks;
}

/**
 * What `repair` reports about this destination: the ownership verdict plus every
 * entry AIH did not emit, listed by owner and event. AIH never silently absorbs
 * one — each is offered for adoption, which is the act that gives AIH the
 * authority to revoke it later.
 */
export function hookRegistrarReport(root: string): {
  state: HookRegistrarStateReport["state"];
  detail: string;
  unowned: UnownedHookEntry[];
  adoption: HookAdoptionOffer[];
} {
  const state = hookRegistrarState(root);
  if (state.state === "invalid") return { ...state, unowned: [], adoption: [] };
  const bytes = readDestinationBytes(root);
  if (bytes === undefined) return { ...state, unowned: [], adoption: [] };
  let receipt: HookRegistrarReceipt | undefined;
  try {
    receipt = readHookRegistrarReceipt(root);
  } catch {
    return { ...state, unowned: [], adoption: [] };
  }
  const owned: HookRegistration[] = (receipt?.entries ?? []).map((entry) => ({
    id: entry.id,
    event: entry.event,
    command: entry.command,
    functionTags: entry.functionTags,
    spawns: entry.spawns,
    sourceDisabled: entry.sourceDisabled,
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    owner:
      entry.owner === "aih" || entry.pin === undefined
        ? { kind: "aih" as const }
        : {
            kind: "third-party" as const,
            framework: entry.ownerId,
            declaredControls: entry.declaredControls ?? [],
            pin: entry.pin,
          },
  }));
  let drift: HookDriftReport;
  try {
    drift = hookRegistrarDrift({ destination: parseJsoncText(bytes), registrations: owned });
  } catch (error) {
    return { state: "invalid", detail: (error as Error).message, unowned: [], adoption: [] };
  }
  return {
    state: state.state,
    detail:
      drift.unowned.length === 0
        ? state.detail
        : `${state.detail}; unowned: ${drift.unowned
            .map((entry) => `${entry.owner}/${entry.event}`)
            .join(", ")}`,
    unowned: drift.unowned,
    adoption: drift.adoption,
  };
}

export interface HookRegistrarStateReport {
  state: "absent" | "unowned" | "active" | "drifted" | "invalid";
  detail: string;
}

/** Read-only ownership verdict. It never mutates the destination. */
export function hookRegistrarState(root: string): HookRegistrarStateReport {
  let receipt: HookRegistrarReceipt | undefined;
  try {
    receipt = readHookRegistrarReceipt(root);
  } catch (error) {
    return { state: "invalid", detail: (error as Error).message };
  }
  const bytes = readDestinationBytes(root);
  if (receipt === undefined) {
    if (bytes === undefined) {
      return { state: "absent", detail: "no hook registrar receipt and no projected destination" };
    }
    let entries: DestinationEntry[];
    try {
      entries = destinationHookEntries(parseJsoncText(bytes));
    } catch (error) {
      return { state: "invalid", detail: (error as Error).message };
    }
    return entries.length === 0
      ? { state: "absent", detail: "no hook registrar receipt and no hook entries on disk" }
      : {
          state: "unowned",
          detail: `${entries.length} hook entr${entries.length === 1 ? "y" : "ies"} AIH did not emit; repair reports them and offers adoption`,
        };
  }
  if (bytes === undefined) {
    return { state: "drifted", detail: "receipt-owned hook destination is absent" };
  }
  let actual: unknown;
  try {
    actual = parseJsoncText(bytes);
  } catch {
    return { state: "drifted", detail: `${HOOK_REGISTRAR_DESTINATION} cannot be parsed safely` };
  }
  const hooks = isPlainObject(actual) ? actual.hooks : undefined;
  if (stableJson(hooks) !== stableJson(expectedHooksFromReceipt(receipt))) {
    return {
      state: "drifted",
      detail: `${HOOK_REGISTRAR_DESTINATION} hooks changed since AIH projected them`,
    };
  }
  return { state: "active", detail: "receipt and every projected hook entry match" };
}

/**
 * Emit every selected hook entry into the destination AIH owns, and record the
 * receipt that can revoke them. Entries AIH did not emit are refused rather than
 * absorbed — adoption is an explicit act, never a side effect of projecting.
 */
export function hookRegistrarProjectionActions(
  ctx: PlanContext,
  registrations: readonly HookRegistration[],
  options: { policyVersion?: string } = {},
): Action[] {
  const parsed = assertHookRegistrations(registrations);
  if (parsed.length === 0) return hookRegistrarRevocationActions(ctx);
  const existingReceipt = readHookRegistrarReceipt(ctx.root);
  const bytes = readDestinationBytes(ctx.root);
  const prior: HookReceiptPrior =
    existingReceipt?.prior ??
    (bytes === undefined
      ? { state: "absent" }
      : { state: "present", sha256: sha256(bytes), contents: bytes });
  // Checked on EVERY projection, not only the first. Gating this on the receipt
  // being absent let a third party reinstall after AIH took ownership and have
  // its entries silently replaced by the whole-key write below. H1 forbids
  // silently absorbing an unowned entry; silently deleting one is worse, and a
  // source with no removal path of its own provokes exactly that.
  if (bytes !== undefined) {
    const onDisk = destinationHookEntries(parseJsoncText(bytes));
    // An already-owned entry is not foreign: the administrator may legally drop
    // one by changing the selection.
    const known = new Set([
      ...parsed.map((registration) => `${registration.event}\u0000${registration.command}`),
      ...(existingReceipt?.entries ?? []).map((entry) => `${entry.event}\u0000${entry.command}`),
    ]);
    const foreign = onDisk.filter((entry) => !known.has(`${entry.event}\u0000${entry.command}`));
    if (foreign.length > 0) {
      throw new OrgPolicyError(
        `${HOOK_REGISTRAR_DESTINATION} carries ${foreign.length} hook entr${foreign.length === 1 ? "y" : "ies"} AIH did not emit ` +
          `(${foreign.map((entry) => entry.event).join(", ")}); adopt or remove them before projecting`,
      );
    }
  }
  const receipt: HookRegistrarReceipt = {
    format: HOOK_REGISTRAR_RECEIPT_FORMAT,
    version: 1,
    destination: HOOK_REGISTRAR_DESTINATION,
    ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
    prior,
    entries: parsed.map(receiptEntry),
  };
  return [
    withExpectedContents(
      writeJson(
        HOOK_REGISTRAR_DESTINATION,
        { hooks: projectedHookSettings(parsed).hooks },
        "project AIH-registered hook entries, third-party launchers verbatim",
        { merge: true, replaceJsonKeys: ["hooks"] },
      ),
      bytes,
    ),
    withExpectedContents(
      writeJson(
        HOOK_REGISTRAR_RECEIPT_PATH,
        receipt,
        "record the hook registrar receipt that can revoke every projected entry",
      ),
      receiptRawBytes(ctx.root),
    ),
  ];
}

/**
 * Remove every projected entry — third-party ones included — and restore the
 * bytes the destination had before AIH first projected. No hand editing, and no
 * dependence on the source shipping an uninstall path of its own.
 */
export function hookRegistrarRevocationActions(ctx: PlanContext): Action[] {
  const receipt = readHookRegistrarReceipt(ctx.root);
  if (receipt === undefined) return [];
  const state = hookRegistrarState(ctx.root);
  if (state.state !== "active") {
    throw new OrgPolicyError(
      `refusing hook registrar revocation: ${state.detail}; repair the owned destination or remove the receipt only after manual remediation`,
    );
  }
  const bytes = readDestinationBytes(ctx.root);
  if (bytes === undefined) {
    throw new OrgPolicyError(
      `refusing hook registrar revocation: ${HOOK_REGISTRAR_DESTINATION} is absent`,
    );
  }
  const receiptRaw = receiptRawBytes(ctx.root);
  /**
   * `hooks` is the only key the receipt proves AIH owns, so it is the only key
   * revocation touches — every other byte the operator has in this file is
   * merge-preserved, which is what restoring the prior destination means here.
   *
   * Entries AIH adopted from a third party do NOT come back. Adoption is a
   * transfer of ownership, and the case that motivated this ADR is precisely a
   * source that wrote entries into a client's settings and shipped no way to
   * remove them. Reinstating them on uninstall would rebuild the defect.
   */
  // Creating the file does not make AIH the owner of everything later written
  // into it. Removal is authorized only while `hooks` is still the only key
  // present; one operator key and the file is preserved and merely subtracted.
  // Lifecycle rule R8: preserve conflicts and user-owned config.
  const current = parseJsoncText(bytes);
  const onlyHooksRemain =
    isPlainObject(current) && Object.keys(current).length === 1 && Object.hasOwn(current, "hooks");
  const restore: Action =
    receipt.prior.state === "absent" && onlyHooksRemain
      ? remove(HOOK_REGISTRAR_DESTINATION, "remove the hook destination AIH created", {
          expect: { sha256: sha256(bytes) },
        })
      : withExpectedContents(
          writeJson(
            HOOK_REGISTRAR_DESTINATION,
            {},
            "subtract every AIH-registered hook entry and restore the prior destination",
            { merge: true, removeJsonTopLevelKeys: ["hooks"] },
          ),
          bytes,
        );
  return [
    restore,
    remove(HOOK_REGISTRAR_RECEIPT_PATH, "remove the completed hook registrar receipt", {
      ...(receiptRaw === undefined ? {} : { expect: { sha256: sha256(receiptRaw) } }),
    }),
  ];
}
