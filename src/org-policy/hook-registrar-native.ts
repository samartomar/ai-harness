import { isPlainObject } from "../internals/merge.js";
import { stableJson } from "./effective.js";
import { HOOK_REGISTRAR_DESTINATION } from "./hook-registrar-read.js";
import {
  type HookRegistration,
  HookRegistrationSchema,
  hookRegistrationSetIssues,
  nativeHookFieldIssues,
  OrgPolicyError,
  type ResolvedHookRegistration,
} from "./schema.js";

/**
 * The native hook shape: what AIH emits, what it reads back, and the key that
 * decides whether those two are the same entry.
 *
 * The rule this module exists to keep: a projected `hooks` key is written as a
 * WHOLE-KEY REPLACE, so anything the flattening cannot see is destroyed. That
 * makes faithfulness a correctness property. AIH therefore carries every native
 * field it did not author — a group's `matcher` above all — verbatim through
 * capture, receipt and re-emission, exactly as it already carries the command.
 * It interprets none of them: AIH implements no scoping grammar.
 */

/** A hook entry as it appears in the client's own configuration. */
export interface ProjectedHookCommand {
  type?: unknown;
  command: string;
  timeout?: number;
  [field: string]: unknown;
}
export interface ProjectedHookGroup {
  hooks: ProjectedHookCommand[];
  [field: string]: unknown;
}
export interface ProjectedHookSettings {
  hooks: Record<string, ProjectedHookGroup[]>;
}

/** The captured native envelope of one entry, and everything needed to re-emit it. */
export interface NativeHookEntry {
  event: string;
  command: string;
  timeout?: number;
  /** The group's own fields, minus `hooks`. */
  nativeGroup?: Record<string, unknown>;
  /** The hook object's own fields, minus `command` and `timeout`. */
  nativeHook?: Record<string, unknown>;
}

/**
 * The fields a group carries besides its `hooks` array. An absent capture and an
 * empty capture mean the same thing here — a group with nothing but hooks.
 */
function groupEnvelope(entry: NativeHookEntry): Record<string, unknown> {
  return entry.nativeGroup ?? {};
}

/**
 * The fields a hook object carries besides its command and timeout. Absent means
 * AIH authored the entry, which is emitted as a plain command hook.
 * PRESENT-but-empty means the captured entry really had nothing else, and it is
 * re-emitted that way — so the two never normalize to the same entry, and an
 * adopted entry round-trips back to exactly the bytes it was captured from.
 */
function hookEnvelope(entry: NativeHookEntry): Record<string, unknown> {
  return entry.nativeHook ?? { type: "command" };
}

/** One native group carrying one hook — the shape every projected entry takes. */
export function projectedHookGroup(entry: NativeHookEntry): ProjectedHookGroup {
  return {
    ...groupEnvelope(entry),
    hooks: [
      {
        ...hookEnvelope(entry),
        // Verbatim. The source's own launcher, transported unchanged.
        command: entry.command,
        ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
      },
    ],
  } as ProjectedHookGroup;
}

/**
 * The ownership key for one native entry. It covers EVERY field
 * {@link projectedHookGroup} emits, because the projection replaces the whole
 * `hooks` key: a field left out of this key is a field the destination can
 * hold, AIH can then call already-known, and the replace can drop — a silent
 * rewrite of a hook AIH never emitted. `stableJson` sorts keys, so the key is
 * insensitive to the order a writer happened to use.
 */
export function nativeHookEntryKey(entry: NativeHookEntry): string {
  return [
    entry.event,
    entry.command,
    entry.timeout ?? "",
    stableJson(groupEnvelope(entry)),
    stableJson(hookEnvelope(entry)),
  ].join("\u0000");
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

/** The native entry one registration projects into. */
export function registrationNativeEntry(registration: ResolvedHookRegistration): NativeHookEntry {
  return {
    event: registration.event,
    command: registration.command,
    ...(registration.timeout === undefined ? {} : { timeout: registration.timeout }),
    ...(registration.nativeGroup === undefined ? {} : { nativeGroup: registration.nativeGroup }),
    ...(registration.nativeHook === undefined ? {} : { nativeHook: registration.nativeHook }),
  };
}

export function registrationKey(registration: ResolvedHookRegistration): string {
  return nativeHookEntryKey(registrationNativeEntry(registration));
}

/**
 * Occurrence counts, not a membership set. N identical entries on disk against
 * one owned entry means N-1 of them are unowned: a plain set matched them all
 * against the same key and let the whole-key replace delete the rest unreported.
 */
export function occurrenceCounts(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/**
 * The most copies of each entry either source vouches for — never their sum.
 * The receipt records what the last projection wrote and the selection records
 * what this one will write, so the same entry is normally in BOTH: adding them
 * would silently vouch for a second copy nobody owns.
 */
export function mergedMaxCounts(
  left: Map<string, number>,
  right: Map<string, number>,
): Map<string, number> {
  const merged = new Map(left);
  for (const [key, count] of right) merged.set(key, Math.max(merged.get(key) ?? 0, count));
  return merged;
}

/** Consume one occurrence of `key`, or report that none is left to claim. */
export function claimOccurrence(counts: Map<string, number>, key: string): boolean {
  const remaining = counts.get(key) ?? 0;
  if (remaining <= 0) return false;
  counts.set(key, remaining - 1);
  return true;
}

/**
 * A JSON value parsed from the destination is refused when its prototype was
 * replaced. `parseJsoncText` does not give a `__proto__` member an own property:
 * it SETS THE PROTOTYPE, so the entry becomes invisible to `Object.keys` and to
 * `Object.getOwnPropertyNames` alike — enumerating own keys cannot recover it —
 * and the whole-key replace would then delete it with nothing reported. The
 * poisoned prototype is the one observable trace, so that is what is checked.
 */
function assertPlainShape(value: object, where: string): void {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new OrgPolicyError(
      `${where} carries a __proto__ member, which cannot be read back safely; ` +
        "AIH refuses rather than silently drop it",
    );
  }
}

function assertNativeFields(
  fields: Record<string, unknown>,
  reserved: readonly string[],
  where: string,
): void {
  const [issue] = nativeHookFieldIssues(fields, reserved);
  if (issue !== undefined) {
    throw new OrgPolicyError(`${where} carries native fields AIH cannot transport: ${issue}`);
  }
}

function withoutKeys(
  source: Record<string, unknown>,
  drop: readonly string[],
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (!drop.includes(key)) kept[key] = source[key];
  }
  return kept;
}

/**
 * Flatten a native hook configuration into entries.
 *
 * It refuses ONLY structure that cannot be interpreted at all. Content that is
 * merely RICHER than AIH can author — a group scoped by `matcher`, a hook
 * carrying `async` — is captured and surfaced as an entry, so the unowned check
 * names it and adoption can capture it. Making that fatal here pre-empted the
 * machinery the contract already gives for unowned content (A3: refusal beats
 * absorption, with adoption as the way out) and left the projector with no
 * capability at all on real client configurations.
 *
 * A group with no hooks, and an event with no groups, hold no entry: nothing can
 * be silently deleted and nothing needs re-emitting, so neither refuses.
 */
export function destinationHookEntries(destination: unknown): NativeHookEntry[] {
  if (destination === undefined) return [];
  if (!isPlainObject(destination)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION} is not a JSON object`);
  }
  assertPlainShape(destination, HOOK_REGISTRAR_DESTINATION);
  const hooks = destination.hooks;
  if (hooks === undefined) return [];
  if (!isPlainObject(hooks)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION}.hooks is not an object`);
  }
  assertPlainShape(hooks, `${HOOK_REGISTRAR_DESTINATION}.hooks`);
  const entries: NativeHookEntry[] = [];
  for (const event of Object.getOwnPropertyNames(hooks)) {
    const groups = hooks[event];
    const eventPath = `${HOOK_REGISTRAR_DESTINATION}.hooks.${displayableDestinationText(event)}`;
    if (!Array.isArray(groups)) throw new OrgPolicyError(`${eventPath} is not an array`);
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        throw new OrgPolicyError(`${eventPath} has a malformed hook group`);
      }
      assertPlainShape(group, eventPath);
      const nativeGroup = withoutKeys(group, ["hooks"]);
      assertNativeFields(nativeGroup, ["hooks"], eventPath);
      for (const hook of group.hooks) {
        if (!isPlainObject(hook)) {
          throw new OrgPolicyError(`${eventPath} has a hook entry that is not an object`);
        }
        assertPlainShape(hook, eventPath);
        if (typeof hook.command !== "string") {
          throw new OrgPolicyError(`${eventPath} has a hook entry whose command is not a string`);
        }
        if (hook.timeout !== undefined && typeof hook.timeout !== "number") {
          throw new OrgPolicyError(`${eventPath} has a hook entry whose timeout is not a number`);
        }
        const nativeHook = withoutKeys(hook, ["command", "timeout"]);
        assertNativeFields(nativeHook, ["command", "timeout"], eventPath);
        entries.push({
          event,
          command: hook.command,
          ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
          nativeGroup,
          nativeHook,
        });
      }
    }
  }
  return entries;
}

/** How much destination-read text may reach a message, a report field, or a digest row. */
const MAX_REPORTED_DESTINATION_TEXT = 200;
/** How many destination-read entries may reach one message or report field. */
export const MAX_REPORTED_HOOK_ENTRIES = 100;
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
 * Display only. Every hash, comparison, ownership key and captured launcher
 * keeps the ORIGINAL bytes: ownership turns on exactness, so neutralizing what
 * is shown must never touch what is compared.
 */
export function displayableDestinationText(value: string): string {
  const neutralized = value.replace(/\p{C}/gu, CONTROL_REPLACEMENT);
  if (neutralized.length <= MAX_REPORTED_DESTINATION_TEXT) return neutralized;
  const dropped = neutralized.length - MAX_REPORTED_DESTINATION_TEXT;
  return `${neutralized.slice(0, MAX_REPORTED_DESTINATION_TEXT)} [+${dropped} characters not shown]`;
}

/**
 * Bound a reported LIST as well as each string in it. Per-string bounding alone
 * still let a legal destination produce a multi-million character message and a
 * multi-megabyte JSON payload, because the count was unbounded.
 */
export function boundedReportedEntries<T>(entries: readonly T[]): {
  shown: T[];
  omitted: number;
} {
  return entries.length <= MAX_REPORTED_HOOK_ENTRIES
    ? { shown: [...entries], omitted: 0 }
    : {
        shown: entries.slice(0, MAX_REPORTED_HOOK_ENTRIES),
        omitted: entries.length - MAX_REPORTED_HOOK_ENTRIES,
      };
}
