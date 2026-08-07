import { createHash } from "node:crypto";
import { isPlainObject } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { withExpectedContents } from "../mcp/managed-projection.js";
import { stableJson } from "./effective.js";
import type { HookAdoptionOffer } from "./hook-registrar-adoption.js";
import {
  assertHookRegistrations,
  boundedReportedEntries,
  carriesJsoncComments,
  claimOccurrence,
  composeProjectedHooks,
  destinationHookEntries,
  displayableDestinationText,
  entrylessGroups,
  mergedMaxCounts,
  type NativeHookEntry,
  nativeHookEntryKey,
  occurrenceCounts,
  type ProjectedHookGroup,
  type ProjectedHookSettings,
  parseDestinationSettings,
  projectedHookGroup,
  registrationKey,
  registrationNativeEntry,
  shadowedCommentKeys,
} from "./hook-registrar-native.js";
import {
  type GuardedRead,
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_RECEIPT_PATH,
  readDestination,
  readReceipt,
} from "./hook-registrar-read.js";
import {
  expectedHooksFromReceipt,
  type HookReceiptPrior,
  type HookRegistrarReceipt,
  hookRegistrationOwnerId,
  parseHookRegistrarReceipt,
  readHookRegistrarReceipt,
  receiptEntry,
  receiptNativeEntry,
  receiptRegistration,
} from "./hook-registrar-receipt.js";
import {
  type HookRegistration,
  HookRegistrationSchema,
  hookCommandDigest,
  OrgPolicyError,
  type ResolvedHookRegistration,
} from "./schema.js";

export {
  adoptedHookRegistrations,
  type HookAdoptionDeclaration,
  type HookAdoptionOffer,
  type HookAdoptionProvenance,
} from "./hook-registrar-adoption.js";
export {
  assertHookRegistrations,
  destinationHookEntries,
  MAX_REPORTED_HOOK_ENTRIES,
  type NativeHookEntry,
  nativeHookEntryKey,
  type ProjectedHookCommand,
  type ProjectedHookGroup,
  type ProjectedHookSettings,
} from "./hook-registrar-native.js";
export {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  HOOK_REGISTRAR_MAX_RECEIPT_BYTES,
  HOOK_REGISTRAR_RECEIPT_FORMAT,
  HOOK_REGISTRAR_RECEIPT_PATH,
} from "./hook-registrar-read.js";
export {
  type HookReceiptEntry,
  type HookReceiptPrior,
  type HookRegistrarReceipt,
  hookRegistrationOwnerId,
  readHookRegistrarReceipt,
} from "./hook-registrar-receipt.js";
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
 * A projected third-party entry is transported, never transformed — its command
 * and every native field around it alike. The only thing AIH computes about a
 * launcher is a hash, and the only thing that hash is used for is proving it did
 * not change.
 */

/**
 * Claude is the only supported target. Codex publishes no per-event hook output
 * contract AIH has evidence for, and inventing one would be a guess — the same
 * reason the ECC composite dispatcher was deliberately left Codex-unchanged.
 */
export const HOOK_REGISTRAR_TARGETS = ["claude"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
      .map((registration) => projectedHookGroup(registrationNativeEntry(registration)));
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
export interface HookDriftReport {
  destination: string;
  unowned: UnownedHookEntry[];
  drifted: DriftedHookEntry[];
  adoption: HookAdoptionOffer[];
  /** Entries beyond the reporting bound — counted, never silently dropped. */
  omitted: number;
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
    parsed.map((registration) => [registrationKey(registration), registration]),
  );
  const unclaimed = occurrenceCounts(parsed.map(registrationKey));
  const seen = new Set<string>();
  const foreign: NativeHookEntry[] = [];
  for (const entry of onDisk) {
    const key = nativeHookEntryKey(entry);
    if (expected.has(key) && claimOccurrence(unclaimed, key)) {
      seen.add(key);
      continue;
    }
    foreign.push(entry);
  }
  const bounded = boundedReportedEntries(foreign);
  const unowned: UnownedHookEntry[] = [];
  const adoption: HookAdoptionOffer[] = [];
  for (const entry of bounded.shown) {
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
    unowned.push({
      event: displayableDestinationText(entry.event),
      command: displayableDestinationText(entry.command),
      owner: attributed === undefined ? "unknown" : hookRegistrationOwnerId(attributed),
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
    if (!seen.has(registrationKey(registration))) {
      drifted.push({ id: registration.id, event: registration.event, reason: "missing" });
    }
  }
  return {
    destination: HOOK_REGISTRAR_DESTINATION,
    unowned,
    drifted,
    adoption,
    omitted: bounded.omitted,
  };
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
  // ONE read of each file: the verdict and the unowned list have to describe
  // the same bytes, or the report contradicts itself between its own lines.
  let receipt: HookRegistrarReceipt | undefined;
  const receiptRead = readReceipt(root);
  try {
    if (receiptRead.state === "unreadable") {
      throw new OrgPolicyError(`${receiptRead.reason}; refusing hook ownership`);
    }
    receipt =
      receiptRead.state === "absent" ? undefined : parseHookRegistrarReceipt(receiptRead.contents);
  } catch (error) {
    return { state: "invalid", detail: (error as Error).message, unowned: [], adoption: [] };
  }
  const read = readDestination(root);
  const state = hookRegistrarVerdict(receipt, read);
  if (state.state === "invalid" || read.state !== "present") {
    return { ...state, unowned: [], adoption: [] };
  }
  const owned: HookRegistration[] = (receipt?.entries ?? []).map(receiptRegistration);
  let drift: HookDriftReport;
  try {
    drift = hookRegistrarDrift({
      destination: parseDestinationSettings(read.contents),
      registrations: owned,
    });
  } catch (error) {
    return { state: "invalid", detail: (error as Error).message, unowned: [], adoption: [] };
  }
  const omitted = drift.omitted === 0 ? "" : ` (+${drift.omitted} more not listed)`;
  return {
    state: state.state,
    detail:
      drift.unowned.length === 0
        ? state.detail
        : `${state.detail}; unowned: ${drift.unowned
            .map((entry) => `${entry.owner}/${entry.event}`)
            .join(", ")}${omitted}`,
    unowned: drift.unowned,
    adoption: drift.adoption,
  };
}

export interface HookRegistrarStateReport {
  /**
   * `active` is an EXACT match: the `hooks` key holds what the receipt says AIH
   * wrote and nothing else. `cohabited` is the same ownership proof over a key
   * that also holds content AIH did not emit — the normal configuration of a
   * file a repository, a third-party framework and AIH all write, and a state
   * revocation acts on. Neither one widens the other: a surface that cannot tell
   * them apart cannot tell an operator what uninstall is about to preserve.
   */
  state: "absent" | "unowned" | "active" | "cohabited" | "drifted" | "invalid";
  detail: string;
}

/** The `hooks` value revocation writes back, and what it leaves behind. */
interface HookGroupSubtraction {
  /** Every group AIH did not emit, per event. Empty means the key itself goes. */
  remainder: Record<string, unknown[]>;
  /** Entries the destination keeps that the receipt does not prove AIH emitted. */
  foreignEntries: number;
}

/**
 * The destination's `hooks` key with exactly the groups the receipt proves AIH
 * emitted taken out of it, or `undefined` when no such subtraction can be
 * proved and the caller must fail closed.
 *
 * Ownership granularity is the projected GROUP. AIH projects single-entry groups
 * by construction, so a group that structurally equals the receipt's own
 * rendering — scoping fields included — is one AIH wrote, and dropping the whole
 * group drops exactly what it wrote. An operator entry inserted INTO an
 * AIH-written group makes that group unprovable: subtracting from inside it
 * would delete content AIH cannot prove it emitted, which is the deletion the
 * single-registrar contract forbids (H1).
 *
 * Groups AIH never emitted are NOT drift. Cohabitation is the measured baseline
 * of this destination, so they are counted, left where the operator put them,
 * and written back through the parse-and-re-serialize writer — value and key
 * preservation, never a byte-preservation claim.
 */
function ownedGroupSubtraction(
  destination: unknown,
  receipt: HookRegistrarReceipt,
): HookGroupSubtraction | undefined {
  let onDisk: NativeHookEntry[];
  try {
    onDisk = destinationHookEntries(destination);
  } catch {
    // A destination this module cannot read is not one it can prove it owns
    // part of. Refusing here keeps the verdict fail-closed on ambiguity.
    return undefined;
  }
  const hooks = isPlainObject(destination) ? destination.hooks : undefined;
  if (!isPlainObject(hooks)) return undefined;
  // The ONE composer the projection and the receipt's expectation already use,
  // asked for the owned groups alone. The rendering is never restated here.
  const owned = composeProjectedHooks(receipt.entries.map(receiptNativeEntry));
  if (Object.keys(owned).some((event) => !Object.hasOwn(hooks, event))) return undefined;
  const remainder: Record<string, unknown[]> = {};
  for (const event of Object.getOwnPropertyNames(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return undefined;
    // OWN-PROPERTY read. `event` is destination-controlled, and the owned groups
    // sit in a plain object: a bare `owned[event]` for an event named after an
    // `Object.prototype` member — `constructor`, `toString`, `valueOf` — resolves
    // to a function through the prototype chain, `?? []` never fires, and the
    // verdict throws an untyped TypeError instead of answering. That took the
    // whole uninstall plan down with it, advisory row included, stranding the
    // launchers this projector exists to be able to remove.
    const ownedForEvent = Object.hasOwn(owned, event) ? (owned[event] ?? []) : [];
    // Occurrence counts, not a membership set — the module's rule everywhere
    // else: N owned copies claim N groups on disk and no more, so a duplicate
    // nobody vouches for is preserved rather than subtracted away.
    const unclaimed = occurrenceCounts(ownedForEvent.map(stableJson));
    const kept = groups.filter((group) => !claimOccurrence(unclaimed, stableJson(group)));
    // An owned group the destination no longer holds: the entries the receipt
    // proves are gone, which is drift and not cohabitation.
    if ([...unclaimed.values()].some((count) => count > 0)) return undefined;
    // An event whose groups were ALL owned goes with them; one that already held
    // no group stays, exactly as the projection carried it through.
    if (kept.length > 0 || groups.length === 0) remainder[event] = kept;
  }
  // Every owned group carries exactly one hook by construction, so what the
  // destination holds beyond the receipt's own entries is what AIH did not emit.
  return { remainder, foreignEntries: onDisk.length - receipt.entries.length };
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
 * Why a write of `hooks` would destroy operator comments in these bytes, phrased
 * to follow the destination path, or undefined when it would not.
 *
 * Two shapes, one ruling — refusing beats silently stripping. The writer edits
 * only the keys it changes, so a comment is at risk when it sits inside `hooks`
 * (replaced whole), or when a duplicated top-level name forces the whole-file
 * render that drops every comment in the file.
 */
function commentStrippingHazard(bytes: string): string | undefined {
  const shadowed = shadowedCommentKeys(bytes);
  if (shadowed.length > 0) {
    const named = shadowed.map((key) => `\`${key}\``).join(", ");
    return (
      `declares ${named} more than once, which forces a whole-file rewrite that would strip ` +
      "its comments; AIH refuses rather than silently rewrite them"
    );
  }
  if (carriesJsoncComments(bytes)) {
    return (
      "carries comments inside its hook entries that writing the groups AIH owns would " +
      "strip; AIH refuses rather than silently rewrite them"
    );
  }
  return undefined;
}

/** A verdict, and — when one can be proved — the subtraction it authorizes. */
interface HookRegistrarOwnership {
  report: HookRegistrarStateReport;
  /** Present exactly when the report reads `active` or `cohabited`. */
  subtraction?: HookGroupSubtraction;
}

/**
 * The verdict over bytes the CALLER read, and the subtraction proved from those
 * same bytes. Revocation proves ownership and then pins the write it emits, and
 * both have to come from the same read: with a second read, a write landing
 * between them was baked into the pin, passed at apply, and was then subtracted
 * as though AIH had proved it owned the entry that had just arrived — the
 * deletion the single-registrar contract forbids (H1). One computation answers
 * both questions here so the two can never be asked of different bytes.
 */
function hookRegistrarOwnership(
  receipt: HookRegistrarReceipt | undefined,
  read: GuardedRead,
): HookRegistrarOwnership {
  if (read.state === "unreadable") return { report: { state: "invalid", detail: read.reason } };
  const bytes = read.state === "present" ? read.contents : undefined;
  if (receipt === undefined) {
    if (bytes === undefined) {
      return {
        report: {
          state: "absent",
          detail: "no hook registrar receipt and no projected destination",
        },
      };
    }
    let entries: NativeHookEntry[];
    try {
      entries = destinationHookEntries(parseDestinationSettings(bytes));
    } catch (error) {
      return { report: { state: "invalid", detail: (error as Error).message } };
    }
    return {
      report:
        entries.length === 0
          ? { state: "absent", detail: "no hook registrar receipt and no hook entries on disk" }
          : {
              state: "unowned",
              detail: `${entries.length} hook entr${entries.length === 1 ? "y" : "ies"} AIH did not emit; repair reports them and offers adoption`,
            },
    };
  }
  if (bytes === undefined) {
    return { report: { state: "drifted", detail: "receipt-owned hook destination is absent" } };
  }
  let actual: unknown;
  try {
    actual = parseDestinationSettings(bytes);
  } catch {
    return {
      report: { state: "drifted", detail: `${HOOK_REGISTRAR_DESTINATION} cannot be parsed safely` },
    };
  }
  const subtraction = ownedGroupSubtraction(actual, receipt);
  if (subtraction === undefined) {
    return {
      report: {
        state: "drifted",
        detail: `${HOOK_REGISTRAR_DESTINATION} hooks changed since AIH projected them`,
      },
    };
  }
  // Checked before the `active` split because BOTH routes below authorize a
  // write of `hooks`, and a comment changes no parsed value — an `active`
  // verdict says nothing about whether one is there.
  const hazard = commentStrippingHazard(bytes);
  if (hazard !== undefined) {
    return { report: { state: "drifted", detail: `${HOOK_REGISTRAR_DESTINATION} ${hazard}` } };
  }
  const hooks = isPlainObject(actual) ? actual.hooks : undefined;
  if (stableJson(hooks) === stableJson(expectedHooksFromReceipt(receipt))) {
    return {
      report: { state: "active", detail: "receipt and every projected hook entry match" },
      subtraction,
    };
  }
  const foreign = subtraction.foreignEntries;
  // The count is of flattened ENTRIES, and operator content can hold none — an
  // entry-less group carrying a `matcher`, an event with no group at all. Saying
  // "0 hook entries ... are preserved" while a real `matcher` IS being preserved
  // is a false claim about the file, so the number is only spent where it means
  // something, and the two contentless shapes say what is actually true.
  const beside =
    foreign > 0
      ? `beside ${foreign} hook entr${foreign === 1 ? "y" : "ies"} AIH did not emit`
      : Object.keys(subtraction.remainder).length > 0
        ? "beside operator hook configuration AIH did not emit"
        : "in a key that is no longer the exact rendering AIH wrote";
  return {
    report: {
      state: "cohabited",
      detail: `receipt and every projected hook entry match, ${beside}`,
    },
    subtraction,
  };
}

/** Read-only ownership verdict over bytes the caller read. It never mutates anything. */
function hookRegistrarVerdict(
  receipt: HookRegistrarReceipt | undefined,
  read: GuardedRead,
): HookRegistrarStateReport {
  return hookRegistrarOwnership(receipt, read).report;
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
  // ONE read of the receipt: the same bytes decide what AIH already owns and
  // pin the receipt write below.
  const receiptRead = readReceipt(ctx.root);
  if (receiptRead.state === "unreadable") {
    throw new OrgPolicyError(`refusing hook registrar projection: ${receiptRead.reason}`);
  }
  const existingReceiptRaw = receiptRead.state === "present" ? receiptRead.contents : undefined;
  const existingReceipt =
    existingReceiptRaw === undefined ? undefined : parseHookRegistrarReceipt(existingReceiptRaw);
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
    const onDisk = destinationHookEntries(parseDestinationSettings(bytes));
    // An already-owned entry is not foreign: the administrator may legally drop
    // one by changing the selection. Counted, not merely matched, so duplicate
    // copies of one owned entry cannot all claim the same single ownership.
    const known = mergedMaxCounts(
      occurrenceCounts(parsed.map(registrationKey)),
      occurrenceCounts(
        (existingReceipt?.entries ?? []).map((entry) =>
          nativeHookEntryKey(receiptNativeEntry(entry)),
        ),
      ),
    );
    const foreign = onDisk.filter((entry) => !claimOccurrence(known, nativeHookEntryKey(entry)));
    if (foreign.length > 0) {
      // A3: refusal names each unowned entry by owner and event. Attribution
      // is only as good as a declared pin — selected or receipt-owned — and an
      // entry nothing attributes stays `unknown`.
      const attributable = [
        ...parsed,
        ...(existingReceipt?.entries ?? []).map(receiptRegistration),
      ];
      const bounded = boundedReportedEntries(foreign);
      const named = bounded.shown.map((entry) => {
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
      const omitted = bounded.omitted === 0 ? "" : `, +${bounded.omitted} more`;
      throw new OrgPolicyError(
        `${HOOK_REGISTRAR_DESTINATION} carries ${foreign.length} hook entr${foreign.length === 1 ? "y" : "ies"} AIH did not emit ` +
          `(${named.join(", ")}${omitted}); adopt or remove them before projecting`,
      );
    }
  }
  // The projection reaches the same `hooks` write revocation does, so it refuses
  // on the same hazards rather than reporting success over stripped comments.
  const projectionHazard = bytes === undefined ? undefined : commentStrippingHazard(bytes);
  if (projectionHazard !== undefined) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION} ${projectionHazard}`);
  }
  // Groups that yield no entry are still content — `matcher`, `id`,
  // `description` — and the whole-key write would delete them. Carry them
  // through unchanged and record them, so the expectation matches what was
  // written and revocation can put them back.
  const carriedThrough =
    bytes === undefined ? {} : entrylessGroups(parseDestinationSettings(bytes));
  const receipt: HookRegistrarReceipt = {
    format: "aih-org-policy-hook-registrar-receipt",
    version: 1,
    destination: HOOK_REGISTRAR_DESTINATION,
    ...(options.policyVersion === undefined ? {} : { policyVersion: options.policyVersion }),
    prior,
    entries: parsed.map(receiptEntry),
    ...(Object.keys(carriedThrough).length === 0 ? {} : { carriedThrough }),
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
        { hooks: composeProjectedHooks(parsed.map(registrationNativeEntry), carriedThrough) },
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
      existingReceiptRaw,
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
  const receiptRead = readReceipt(ctx.root);
  // A receipt AIH cannot read is not a receipt AIH never wrote. Returning an
  // empty plan here would drop the registrar out of the uninstall silently and
  // orphan every projected launcher; a GENUINELY absent receipt still means
  // there is nothing to revoke, and stays silent.
  if (receiptRead.state === "unreadable") {
    throw new OrgPolicyError(`refusing hook registrar revocation: ${receiptRead.reason}`);
  }
  if (receiptRead.state === "absent") return [];
  const receiptRaw = receiptRead.contents;
  const receipt = parseHookRegistrarReceipt(receiptRaw);
  const read = readDestination(ctx.root);
  const ownership = hookRegistrarOwnership(receipt, read);
  if (ownership.subtraction === undefined || read.state !== "present") {
    throw new OrgPolicyError(
      `refusing hook registrar revocation: ${ownership.report.detail}; repair the owned destination or remove the receipt only after manual remediation`,
    );
  }
  const bytes = read.contents;
  /**
   * `hooks` is the only key the receipt proves AIH owns, so it is the only key
   * revocation touches — every other byte the operator has in this file is
   * merge-preserved, which is what restoring the prior destination means here.
   * Inside that key the unit is the projected GROUP: what AIH emitted is
   * subtracted, and every group it did not — content it carried through, and
   * anything an operator or a third party added afterwards — is written back.
   *
   * Entries AIH adopted from a third party do NOT come back. Adoption is a
   * transfer of ownership, and the case that motivated this ADR is precisely a
   * source that wrote entries into a client's settings and shipped no way to
   * remove them. Reinstating them on uninstall would rebuild the defect.
   * Subtraction changes what revocation can prove, never what it replays:
   * nothing here is ever replayed.
   */
  // Creating the file does not make AIH the owner of everything later written
  // into it. Removal is authorized only while `hooks` is still the only key
  // present AND nothing foreign is left inside it; one operator key or one
  // operator hook group and the file is preserved and merely subtracted.
  // Lifecycle rule R8: preserve conflicts and user-owned config.
  const current = parseDestinationSettings(bytes);
  const onlyHooksRemain =
    isPlainObject(current) && Object.keys(current).length === 1 && Object.hasOwn(current, "hooks");
  const { remainder } = ownership.subtraction;
  const restore: Action =
    Object.keys(remainder).length > 0
      ? withExpectedContents(
          writeJson(
            HOOK_REGISTRAR_DESTINATION,
            { hooks: remainder },
            "subtract every AIH-registered hook entry, keeping every group AIH did not emit",
            { merge: true, replaceJsonKeys: ["hooks"] },
          ),
          bytes,
        )
      : receipt.prior.state === "absent" && onlyHooksRemain
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
      expect: { sha256: sha256(receiptRaw) },
    }),
  ];
}
