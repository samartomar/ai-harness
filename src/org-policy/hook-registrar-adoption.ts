import {
  assertHookRegistrations,
  claimOccurrence,
  destinationHookEntries,
  type NativeHookEntry,
  nativeHookEntryKey,
  occurrenceCounts,
  parseDestinationSettings,
} from "./hook-registrar-native.js";
import { HOOK_REGISTRAR_DESTINATION, readDestination } from "./hook-registrar-read.js";
import { readHookRegistrarReceipt, receiptNativeEntry } from "./hook-registrar-receipt.js";
import { hookCommandDigest, OrgPolicyError, type ResolvedHookRegistration } from "./schema.js";

/**
 * A1 — adoption: the only path from an entry AIH did not emit to a policy
 * registration it can later revoke. Split out of the projector because capture
 * is a self-contained act with its own refusals.
 */

export interface HookAdoptionProvenance {
  repository: string;
  commit: string;
  path: string;
  runtimeVersion: string;
}

/**
 * What AIH offers to take ownership of. Its `event` and `command` are the
 * ORIGINAL captured bytes, not display text: an administrator answers an offer
 * by naming it, and the lookup below keys on those bytes. Neutralizing them
 * would make an offer that can never be matched and then blame the declaration
 * for a mismatch AIH introduced. Rendering neutralizes; identity does not.
 */
export interface HookAdoptionOffer {
  event: string;
  command: string;
  commandSha256: string;
}

/**
 * An administrator's answer to an adoption offer. It names the offered entry by
 * event and captured-byte hash — never by launcher text, because an
 * administrator never hand-types a launcher; a hand-typed launcher means
 * adoption was not run. Everything AIH must not infer is declared here:
 * identity, function tags, the spawn measurement, and provenance. Declaring no
 * provenance leaves the owner `unknown`. The native fields around the launcher
 * are NOT declared — they are captured, like the launcher itself.
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

function offerKeyFor(event: string, commandSha256: string): string {
  return `${event}\u0000${commandSha256}`;
}

/**
 * Capture each named launcher byte-for-byte from the destination, hash those
 * exact bytes, and emit the policy entries the grammar accepts. Adoption is a
 * transfer of ownership: once emitted and projected, the entry is revocable
 * through the receipt and never comes back on uninstall.
 *
 * The capture takes the WHOLE native entry, not just its command. An entry
 * adopted without its `matcher` would be re-projected unscoped — silently
 * widening a hook that fired on one tool into one that fires on everything.
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
  const receipt = readHookRegistrarReceipt(root);
  const ownedKeys = occurrenceCounts(
    (receipt?.entries ?? []).map((entry) => nativeHookEntryKey(receiptNativeEntry(entry))),
  );
  const unowned = new Map<string, NativeHookEntry>();
  const ambiguous = new Set<string>();
  for (const entry of destinationHookEntries(parseDestinationSettings(read.contents))) {
    if (claimOccurrence(ownedKeys, nativeHookEntryKey(entry))) continue;
    const key = offerKeyFor(entry.event, hookCommandDigest(entry.command));
    const existing = unowned.get(key);
    // Two unowned entries can share an event and a launcher yet differ in the
    // native fields around them. An offer names event and hash, so picking one
    // silently would capture the wrong scope; refuse the ambiguity instead.
    if (existing !== undefined && nativeHookEntryKey(existing) !== nativeHookEntryKey(entry)) {
      ambiguous.add(key);
    }
    unowned.set(key, entry);
  }
  const claimed = new Set<string>();
  const adopted = declarations.map((declaration) => {
    const key = offerKeyFor(declaration.event, declaration.commandSha256);
    if (claimed.has(key)) {
      throw new OrgPolicyError(
        `hook adoption ${declaration.id}: the ${declaration.event} entry ${declaration.commandSha256} is declared twice`,
      );
    }
    claimed.add(key);
    if (ambiguous.has(key)) {
      throw new OrgPolicyError(
        `hook adoption ${declaration.id}: ${HOOK_REGISTRAR_DESTINATION} carries more than one ${declaration.event} entry with hash ${declaration.commandSha256}, differing in their native fields; AIH will not guess which one to capture`,
      );
    }
    const captured = unowned.get(key);
    if (captured === undefined) {
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
    const launcherSha256 = hookCommandDigest(captured.command);
    return {
      id: declaration.id,
      event: declaration.event,
      command: captured.command,
      functionTags: [...declaration.functionTags],
      spawns: declaration.spawns,
      ...(captured.timeout === undefined ? {} : { timeout: captured.timeout }),
      ...(declaration.sourceDisabled === undefined
        ? {}
        : { sourceDisabled: declaration.sourceDisabled }),
      ...(captured.nativeGroup === undefined ? {} : { nativeGroup: captured.nativeGroup }),
      ...(captured.nativeHook === undefined ? {} : { nativeHook: captured.nativeHook }),
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
