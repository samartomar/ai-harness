import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegularFile } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { hasSymlinkParent, occupied, withExpectedContents } from "../mcp/managed-projection.js";
import { stableJson } from "./effective.js";
import {
  type HookRegistration,
  HookRegistrationSchema,
  hookCommandDigest,
  hookRegistrationSetIssues,
  OrgPolicyError,
  type ResolvedHookRegistration,
  type ThirdPartyLauncherPin,
  ThirdPartyLauncherPinSchema,
} from "./schema.js";

export {
  type HookRegistration,
  type HookRegistrationOwner,
  hookCommandDigest,
  type ThirdPartyLauncherPin,
} from "./schema.js";

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
 * The largest destination the receipt can carry as prior evidence — ONE
 * constant, used by both the read that captures those bytes and the schema that
 * has to parse them back. The two paths disagreeing is not a cosmetic defect:
 * a receipt recorded above what the schema accepts can never be read again, and
 * a receipt that cannot be read is a projected third-party entry that can never
 * be revoked. A4 keeps the prior bytes as evidence, so dropping them silently is
 * not an alternative; a destination this large is refused up front instead.
 *
 * The read is capped in BYTES and the schema in UTF-16 code units, which is safe
 * in this direction: UTF-8 never spends fewer bytes than the code units it
 * encodes, so bytes within the cap can never decode to a longer string than it.
 */
export const HOOK_REGISTRAR_MAX_DESTINATION_BYTES = 4 * 1024 * 1024;

/**
 * Claude is the only supported target. Codex publishes no per-event hook output
 * contract AIH has evidence for, and inventing one would be a guess — the same
 * reason the ECC composite dispatcher was deliberately left Codex-unchanged.
 */
export const HOOK_REGISTRAR_TARGETS = ["claude"] as const;

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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hookRegistrationOwnerId(registration: ResolvedHookRegistration): string {
  return registration.owner.kind === "third-party"
    ? registration.owner.framework
    : registration.owner.kind;
}

/**
 * Validate a registration set at the boundary, and prove every third-party
 * launcher still matches its pin. A launcher whose hash moved is DRIFT — it is
 * refused here rather than projected. The checks are the grammar's own
 * `hookRegistrationSetIssues` — one copy, shared with `governance.hookRegistrations`.
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
  const [issue] = hookRegistrationSetIssues(parsed);
  if (issue !== undefined) throw new OrgPolicyError(issue.message);
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
  timeout?: number;
}

/**
 * The ownership key for one native entry. It carries EVERY field the projector
 * emits, because the projection writes `hooks` as a whole-key replace: a field
 * left out of this key is a field the destination can hold, AIH can then call
 * already-known, and the replace can drop — a silent rewrite of a hook AIH
 * never emitted.
 */
function destinationEntryKey(entry: { event: string; command: string; timeout?: number }): string {
  return `${entry.event}\u0000${entry.command}\u0000${entry.timeout ?? ""}`;
}

/** The exact group and hook shapes {@link projectedHookSettings} emits. */
const PROJECTED_GROUP_KEYS = new Set(["hooks"]);
const PROJECTED_HOOK_KEYS = new Set(["type", "command", "timeout"]);

/** How much destination-read text may reach a message, a report field, or a digest row. */
const MAX_REPORTED_DESTINATION_TEXT = 200;
/** U+FFFD REPLACEMENT CHARACTER — what a neutralized control character becomes. */
const CONTROL_REPLACEMENT = String.fromCodePoint(0xfffd);

/**
 * Make one destination-read string safe to PRINT. A policy-authored launcher is
 * bounded and control-character-free by the grammar; a string read from the
 * destination is bounded only by file size, and it reaches the operator's
 * terminal, the `--json` envelope and the governance digest — where control
 * characters repaint the screen, a CR/LF forges a digest row, and a megabyte of
 * launcher makes one error message unreadable.
 *
 * Display only. Every hash, comparison and captured launcher keeps the ORIGINAL
 * bytes: ownership turns on exactness, so neutralizing what is shown must never
 * touch what is compared.
 */
function displayableDestinationText(value: string): string {
  const neutralized = value.replace(/\p{C}/gu, CONTROL_REPLACEMENT);
  if (neutralized.length <= MAX_REPORTED_DESTINATION_TEXT) return neutralized;
  const dropped = neutralized.length - MAX_REPORTED_DESTINATION_TEXT;
  return `${neutralized.slice(0, MAX_REPORTED_DESTINATION_TEXT)} [+${dropped} characters not shown]`;
}

/**
 * Refuse destination content AIH cannot re-emit verbatim. Skipping it silently
 * is not an option: the projection replaces the whole `hooks` key, so anything
 * this flattening cannot see is deleted without ever reaching the unowned-entry
 * refusal — and H1 forbids silently deleting an entry as firmly as absorbing
 * one. AIH does not invent a matcher grammar for a policy-authored
 * registration; it names what it cannot represent and stops.
 */
function refuseUnrepresentable(event: string, what: string): never {
  throw new OrgPolicyError(
    `${HOOK_REGISTRAR_DESTINATION}.hooks.${displayableDestinationText(event)} carries ${what}, which AIH cannot re-emit verbatim; ` +
      `projecting replaces the whole hooks key, so AIH refuses rather than delete it — remove it first`,
  );
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
      throw new OrgPolicyError(
        `${HOOK_REGISTRAR_DESTINATION}.hooks.${displayableDestinationText(event)} is not an array`,
      );
    }
    if (groups.length === 0) refuseUnrepresentable(event, "an empty group list");
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        throw new OrgPolicyError(
          `${HOOK_REGISTRAR_DESTINATION}.hooks.${displayableDestinationText(event)} has a malformed hook group`,
        );
      }
      const groupExtras = Object.keys(group)
        .filter((key) => !PROJECTED_GROUP_KEYS.has(key))
        .sort((a, b) => a.localeCompare(b));
      if (groupExtras.length > 0) {
        refuseUnrepresentable(event, `a hook group scoped by ${groupExtras.join(", ")}`);
      }
      if (group.hooks.length === 0) refuseUnrepresentable(event, "an empty hook group");
      for (const hook of group.hooks) {
        if (!isPlainObject(hook)) {
          refuseUnrepresentable(event, "a hook entry that is not an object");
        }
        if (typeof hook.command !== "string") {
          refuseUnrepresentable(event, "a hook entry whose command is not a string");
        }
        const hookExtras = Object.keys(hook)
          .filter((key) => !PROJECTED_HOOK_KEYS.has(key))
          .sort((a, b) => a.localeCompare(b));
        if (hookExtras.length > 0) {
          refuseUnrepresentable(event, `a hook entry carrying ${hookExtras.join(", ")}`);
        }
        if (hook.type !== undefined && hook.type !== "command") {
          refuseUnrepresentable(event, "a hook entry that is not a command hook");
        }
        if (hook.timeout !== undefined && typeof hook.timeout !== "number") {
          refuseUnrepresentable(event, "a hook entry whose timeout is not a number");
        }
        entries.push({
          event,
          command: hook.command,
          ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
        });
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
    parsed.map((registration) => [destinationEntryKey(registration), registration]),
  );
  const seen = new Set<string>();
  const unowned: UnownedHookEntry[] = [];
  const adoption: HookAdoptionOffer[] = [];
  for (const entry of onDisk) {
    const key = destinationEntryKey(entry);
    if (expected.has(key)) {
      seen.add(key);
      continue;
    }
    // Attribution is only as good as a declared pin. Guessing an owner from a
    // command AIH does not interpret would be a fabricated claim.
    // The digest is taken from the ORIGINAL bytes; only what is reported is
    // neutralized, so an adoption declaration still names the exact launcher.
    const digest = hookCommandDigest(entry.command);
    const attributed = parsed.find(
      (registration) =>
        registration.owner.kind === "third-party" &&
        registration.owner.pin.launcherSha256 === digest,
    );
    const reported = {
      event: displayableDestinationText(entry.event),
      command: displayableDestinationText(entry.command),
    };
    unowned.push({
      ...reported,
      owner: attributed === undefined ? "unknown" : hookRegistrationOwnerId(attributed),
    });
    adoption.push({ ...reported, commandSha256: digest });
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
    if (!seen.has(destinationEntryKey(registration))) {
      drifted.push({ id: registration.id, event: registration.event, reason: "missing" });
    }
  }
  return { destination: HOOK_REGISTRAR_DESTINATION, unowned, drifted, adoption };
}

export interface HookAdoptionProvenance {
  repository: string;
  commit: string;
  path: string;
  runtimeVersion: string;
}

/**
 * An administrator's answer to an adoption offer. It names the offered entry by
 * event and captured-byte hash — never by launcher text, because an
 * administrator never hand-types a launcher; a hand-typed launcher means
 * adoption was not run. Everything AIH must not infer is declared here:
 * identity, function tags, the spawn measurement, and provenance. Declaring no
 * provenance leaves the owner `unknown`.
 */
export interface HookAdoptionDeclaration {
  event: string;
  commandSha256: string;
  id: string;
  functionTags: readonly string[];
  spawns: number;
  timeout?: number;
  sourceDisabled?: boolean;
  owner:
    | {
        kind: "third-party";
        framework: string;
        declaredControls?: readonly string[];
        pin: HookAdoptionProvenance;
      }
    | { kind: "unknown" };
}

/**
 * A1: capture each named launcher byte-for-byte from the destination, hash
 * those exact bytes, and emit the policy entries the grammar accepts. This is
 * the only path from an unowned destination entry to a policy registration —
 * and adoption is a transfer of ownership: once emitted and projected, the
 * entry is revocable through the receipt and never comes back on uninstall.
 */
export function adoptedHookRegistrations(
  root: string,
  declarations: readonly HookAdoptionDeclaration[],
): ResolvedHookRegistration[] {
  const read = readDestination(root);
  if (read.state !== "present") {
    throw new OrgPolicyError(
      read.state === "absent"
        ? `refusing hook adoption: ${HOOK_REGISTRAR_DESTINATION} is absent, so there is nothing to capture`
        : `refusing hook adoption: ${read.reason}`,
    );
  }
  const bytes = read.contents;
  const receipt = readHookRegistrarReceipt(root);
  const ownedKeys = new Set((receipt?.entries ?? []).map(destinationEntryKey));
  const unowned = new Map<string, string>();
  for (const entry of destinationHookEntries(parseJsoncText(bytes))) {
    if (ownedKeys.has(destinationEntryKey(entry))) continue;
    unowned.set(`${entry.event}\u0000${hookCommandDigest(entry.command)}`, entry.command);
  }
  const claimed = new Set<string>();
  const adopted = declarations.map((declaration) => {
    const key = `${declaration.event}\u0000${declaration.commandSha256}`;
    if (claimed.has(key)) {
      throw new OrgPolicyError(
        `hook adoption ${declaration.id}: the ${declaration.event} entry ${declaration.commandSha256} is declared twice`,
      );
    }
    claimed.add(key);
    const command = unowned.get(key);
    if (command === undefined) {
      const alreadyOwned = (receipt?.entries ?? []).some(
        (entry) =>
          entry.event === declaration.event && entry.commandSha256 === declaration.commandSha256,
      );
      throw new OrgPolicyError(
        alreadyOwned
          ? `hook adoption ${declaration.id}: AIH already owns the ${declaration.event} entry ${declaration.commandSha256}; adoption is for entries AIH did not emit`
          : `hook adoption ${declaration.id}: no unowned ${declaration.event} entry with hash ${declaration.commandSha256} exists in ${HOOK_REGISTRAR_DESTINATION}; adoption captures bytes from the destination, never from the declaration`,
      );
    }
    // The hash of the exact captured bytes binds the policy entry to the
    // launcher, whoever the administrator says owns it.
    const launcherSha256 = hookCommandDigest(command);
    return {
      id: declaration.id,
      event: declaration.event,
      command,
      functionTags: [...declaration.functionTags],
      spawns: declaration.spawns,
      ...(declaration.timeout === undefined ? {} : { timeout: declaration.timeout }),
      ...(declaration.sourceDisabled === undefined
        ? {}
        : { sourceDisabled: declaration.sourceDisabled }),
      owner:
        declaration.owner.kind === "unknown"
          ? { kind: "unknown" as const, launcherSha256 }
          : {
              kind: "third-party" as const,
              framework: declaration.owner.framework,
              declaredControls: [...(declaration.owner.declaredControls ?? [])],
              pin: { ...declaration.owner.pin, launcherSha256 },
            },
    };
  });
  return assertHookRegistrations(adopted);
}

export interface HookReceiptEntry {
  id: string;
  event: string;
  owner: "aih" | "third-party" | "unknown";
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
    owner: registration.owner.kind,
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

/**
 * The registration a receipt entry proves AIH owns, owner partition intact.
 * The schema below refuses a third-party entry with no pin before this runs, so
 * the `aih` fallback can only be reached by an entry that genuinely records AIH
 * ownership — never by a third-party claim whose pin went missing.
 */
function receiptRegistration(entry: HookReceiptEntry): ResolvedHookRegistration {
  return {
    id: entry.id,
    event: entry.event,
    command: entry.command,
    functionTags: entry.functionTags,
    spawns: entry.spawns,
    sourceDisabled: entry.sourceDisabled,
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    owner:
      entry.owner === "third-party" && entry.pin !== undefined
        ? {
            kind: "third-party" as const,
            framework: entry.ownerId,
            declaredControls: entry.declaredControls ?? [],
            pin: entry.pin,
          }
        : entry.owner === "unknown"
          ? { kind: "unknown" as const, launcherSha256: entry.commandSha256 }
          : { kind: "aih" as const },
  };
}

// The grammar's own scalar schemas (schema.ts), referenced — not restated — so
// the receipt contract cannot drift from the registration contract.
const IdSchema = HookRegistrationSchema.shape.id;
const EventSchema = HookRegistrationSchema.shape.event;
const LauncherCommandSchema = HookRegistrationSchema.shape.command;
const Sha256Schema = ThirdPartyLauncherPinSchema.shape.launcherSha256;

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
          contents: z.string().max(HOOK_REGISTRAR_MAX_DESTINATION_BYTES),
        })
        .strict(),
    ]),
    entries: z
      .array(
        z
          .object({
            id: IdSchema,
            event: EventSchema,
            owner: z.enum(["aih", "third-party", "unknown"]),
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
  .strict()
  /**
   * A receipt that contradicts itself is refused, not believed in part. It is
   * the only removal authority a projected third-party entry has, so an entry
   * that cannot be reconstructed into the registration it claims to own is
   * worthless: a `commandSha256` that does not hash its own command proves
   * nothing, and third-party ownership with no pin used to reconstruct as
   * `{kind: "aih"}` — the receipt saying a third party owns the entry while the
   * reconstruction claimed AIH does, which dropped it out of the launcher-pin
   * drift check and out of refusal attribution (H2).
   *
   * The set-level checks are the grammar's own `hookRegistrationSetIssues` —
   * the one copy the policy grammar and the projector already share, not a
   * second implementation of the same rules.
   */
  .superRefine((receipt, ctx) => {
    const reconstructable: HookReceiptEntry[] = [];
    for (const [index, entry] of receipt.entries.entries()) {
      if (entry.owner === "third-party" && entry.pin === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "pin"],
          message: `hook receipt entry ${entry.id} records third-party ownership without its launcher pin`,
        });
        continue;
      }
      if (entry.commandSha256 !== hookCommandDigest(entry.command)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "commandSha256"],
          message: `hook receipt entry ${entry.id} records a command hash that does not match its recorded command`,
        });
        continue;
      }
      reconstructable.push(entry as HookReceiptEntry);
    }
    for (const issue of hookRegistrationSetIssues(reconstructable.map(receiptRegistration))) {
      ctx.addIssue({ code: "custom", path: ["entries", issue.index], message: issue.message });
    }
  });

function destinationPath(root: string): string {
  return join(root, ...HOOK_REGISTRAR_DESTINATION.split("/"));
}

/**
 * What the destination read found. `unreadable` is deliberately NOT collapsed
 * into `absent`: `absent` is the flag that authorizes deleting the destination
 * on revocation and the flag that skips the unowned-entry check, so a path AIH
 * merely failed to read must never reach either. Every caller refuses on it.
 */
type DestinationRead =
  | { state: "absent" }
  | { state: "present"; contents: string }
  | { state: "unreadable"; reason: string };

/** The size of a regular file at `abs`, or `undefined` for anything else. */
function regularFileSize(abs: string): number | undefined {
  try {
    const stats = lstatSync(abs);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why a path under `root` cannot be read as AIH's own, or `undefined` when it
 * can. The no-follow read guards the leaf; this guards the parents, which the
 * executor refuses outright — so a verdict reached through a redirected `.aih`
 * or `.claude` would name a removal that is guaranteed to fail in the action
 * loop, and would report content from outside the root as if it were in it.
 */
function symlinkedParentReason(root: string, rel: string): string | undefined {
  return hasSymlinkParent(root, rel)
    ? `${rel} is reached through a symlinked parent directory, and AIH never reads or edits through one`
    : undefined;
}

function readDestination(root: string): DestinationRead {
  const unsafeParent = symlinkedParentReason(root, HOOK_REGISTRAR_DESTINATION);
  if (unsafeParent !== undefined) return { state: "unreadable", reason: unsafeParent };
  const abs = destinationPath(root);
  const contents = readRegularFile(abs, {
    maxBytes: HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  })?.toString("utf8");
  if (contents !== undefined) return { state: "present", contents };
  const size = regularFileSize(abs);
  if (size !== undefined && size > HOOK_REGISTRAR_MAX_DESTINATION_BYTES) {
    return {
      state: "unreadable",
      reason:
        `${HOOK_REGISTRAR_DESTINATION} is ${size} bytes, larger than the ` +
        `${HOOK_REGISTRAR_MAX_DESTINATION_BYTES} bytes a hook registrar receipt can carry as prior evidence`,
    };
  }
  // PRESENCE only, and NO-FOLLOW — the peer's shape (`occupied`, used by the
  // managed-MCP projection for exactly this). A directory, a symlink, a FIFO or
  // an unreadable file all fail the regular-file read, and calling any of them
  // `absent` would record the one prior state that authorizes deleting the
  // destination and would skip the unowned-entry check on the way there.
  if (occupied(abs)) {
    return {
      state: "unreadable",
      reason:
        `${HOOK_REGISTRAR_DESTINATION} is not a readable regular file (a directory, a symlink, ` +
        `a special file, or one AIH cannot read), and AIH never records or edits through one`,
    };
  }
  return { state: "absent" };
}

export function readHookRegistrarReceipt(root: string): HookRegistrarReceipt | undefined {
  // Refused, never treated as "no receipt": a receipt read as absent would let
  // the next projection overwrite a destination AIH still owns.
  const unsafeParent = symlinkedParentReason(root, HOOK_REGISTRAR_RECEIPT_PATH);
  if (unsafeParent !== undefined) {
    throw new OrgPolicyError(`${unsafeParent}; refusing hook ownership`);
  }
  const raw = receiptRawBytes(root);
  return raw === undefined ? undefined : parseHookRegistrarReceipt(raw);
}

/** Parse receipt bytes a caller has already read, so one read can serve every use. */
function parseHookRegistrarReceipt(raw: string): HookRegistrarReceipt {
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
  if (symlinkedParentReason(root, HOOK_REGISTRAR_RECEIPT_PATH) !== undefined) return undefined;
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
  const read = readDestination(root);
  if (read.state !== "present") return { ...state, unowned: [], adoption: [] };
  const bytes = read.contents;
  let receipt: HookRegistrarReceipt | undefined;
  try {
    receipt = readHookRegistrarReceipt(root);
  } catch {
    return { ...state, unowned: [], adoption: [] };
  }
  const owned: HookRegistration[] = (receipt?.entries ?? []).map(receiptRegistration);
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
  return hookRegistrarVerdict(receipt, readDestination(root));
}

/**
 * The verdict over bytes the CALLER read. Revocation proves ownership and then
 * pins the write it emits, and both have to come from the same read: with a
 * second read, a write landing between them was baked into the pin, passed at
 * apply, and the whole-key subtraction then deleted the entry that had just
 * arrived — the deletion the single-registrar contract forbids (H1).
 */
function hookRegistrarVerdict(
  receipt: HookRegistrarReceipt | undefined,
  read: DestinationRead,
): HookRegistrarStateReport {
  if (read.state === "unreadable") return { state: "invalid", detail: read.reason };
  const bytes = read.state === "present" ? read.contents : undefined;
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
  const read = readDestination(ctx.root);
  if (read.state === "unreadable") {
    throw new OrgPolicyError(`refusing hook registrar projection: ${read.reason}`);
  }
  const bytes = read.state === "present" ? read.contents : undefined;
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
      ...parsed.map(destinationEntryKey),
      ...(existingReceipt?.entries ?? []).map(destinationEntryKey),
    ]);
    const foreign = onDisk.filter((entry) => !known.has(destinationEntryKey(entry)));
    if (foreign.length > 0) {
      // A3: refusal names each unowned entry by owner and event. Attribution
      // is only as good as a declared pin — selected or receipt-owned — and an
      // entry nothing attributes stays `unknown`.
      const attributable = [
        ...parsed,
        ...(existingReceipt?.entries ?? []).map(receiptRegistration),
      ];
      const named = foreign.map((entry) => {
        const digest = hookCommandDigest(entry.command);
        const attributed = attributable.find(
          (registration) =>
            registration.owner.kind === "third-party" &&
            registration.owner.pin.launcherSha256 === digest,
        );
        const owner =
          attributed?.owner.kind === "third-party" ? attributed.owner.framework : "unknown";
        // The owner side is policy-authored and already bounded; the event side
        // is destination-read and is neutralized before it reaches the terminal.
        return `${owner}/${displayableDestinationText(entry.event)}`;
      });
      throw new OrgPolicyError(
        `${HOOK_REGISTRAR_DESTINATION} carries ${foreign.length} hook entr${foreign.length === 1 ? "y" : "ies"} AIH did not emit ` +
          `(${named.join(", ")}); adopt or remove them before projecting`,
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
  // Owned content FIRST, ownership record SECOND — the order every sibling
  // lifecycle uses (`src/mcp/index.ts` writes the managed pair, then its
  // ownership marker) and the order revocation reverses. The executor stages
  // both in one filesystem transaction, so an interrupted apply rolls back;
  // what survives a hard kill between the two renames is content with no
  // receipt, and uninstall reports that as an advisory rather than silence.
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
  // ONE read of each file. The ownership verdict, the sole-key decision, the
  // apply-time pin and the merge base all come from these exact bytes, so a
  // write landing after the verdict can never be pinned as if it had been
  // proved: it fails the pin at apply instead of being subtracted away.
  const unsafeReceiptParent = symlinkedParentReason(ctx.root, HOOK_REGISTRAR_RECEIPT_PATH);
  if (unsafeReceiptParent !== undefined) {
    throw new OrgPolicyError(
      `refusing hook registrar revocation: ${unsafeReceiptParent}; refusing hook ownership`,
    );
  }
  const receiptRaw = receiptRawBytes(ctx.root);
  if (receiptRaw === undefined) return [];
  const receipt = parseHookRegistrarReceipt(receiptRaw);
  const read = readDestination(ctx.root);
  const state = hookRegistrarVerdict(receipt, read);
  if (state.state !== "active" || read.state !== "present") {
    throw new OrgPolicyError(
      `refusing hook registrar revocation: ${state.detail}; repair the owned destination or remove the receipt only after manual remediation`,
    );
  }
  const bytes = read.contents;
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
