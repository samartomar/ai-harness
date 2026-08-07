import { createHash } from "node:crypto";
import { z } from "zod";
import {
  composeProjectedHooks,
  type NativeHookEntry,
  type ProjectedHookGroup,
} from "./hook-registrar-native.js";
import {
  HOOK_REGISTRAR_DESTINATION,
  HOOK_REGISTRAR_MAX_DESTINATION_BYTES,
  HOOK_REGISTRAR_MAX_RECEIPT_ENTRIES,
  HOOK_REGISTRAR_RECEIPT_FORMAT,
  HOOK_REGISTRAR_RECEIPT_PATH,
  readReceipt,
} from "./hook-registrar-read.js";
import {
  type HookRegistration,
  HookRegistrationSchema,
  hookCommandDigest,
  hookRegistrationSetIssues,
  nativeHookFieldIssues,
  OrgPolicyError,
  type ResolvedHookRegistration,
  type ThirdPartyLauncherPin,
  ThirdPartyLauncherPinSchema,
} from "./schema.js";

/**
 * The hook registrar receipt: what AIH records about the entries it owns, and
 * the only removal authority a projected third-party entry has. Split out of the
 * projector because the shape, its schema and its parse are one cohesive unit.
 */

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
  /** Captured native fields, recorded so the entry can be re-emitted verbatim. */
  nativeGroup?: Record<string, unknown>;
  nativeHook?: Record<string, unknown>;
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
  /**
   * Groups found in the destination that yield no entry — content AIH did not
   * author and does not own, carried through the whole-key write so the replace
   * cannot delete it. Recorded here so the expectation below reproduces exactly
   * what was written, and so revocation can put it back instead of subtracting
   * it along with what AIH did own.
   */
  carriedThrough?: Record<string, ProjectedHookGroup[]>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hookRegistrationOwnerId(registration: ResolvedHookRegistration): string {
  return registration.owner.kind === "third-party"
    ? registration.owner.framework
    : registration.owner.kind;
}

export function receiptEntry(registration: ResolvedHookRegistration): HookReceiptEntry {
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
    ...(registration.nativeGroup === undefined ? {} : { nativeGroup: registration.nativeGroup }),
    ...(registration.nativeHook === undefined ? {} : { nativeHook: registration.nativeHook }),
  };
}

/**
 * The registration a receipt entry proves AIH owns, owner partition intact.
 * The schema below refuses a third-party entry with no pin before this runs, so
 * the `aih` fallback can only be reached by an entry that genuinely records AIH
 * ownership — never by a third-party claim whose pin went missing.
 */
export function receiptRegistration(entry: HookReceiptEntry): ResolvedHookRegistration {
  return {
    id: entry.id,
    event: entry.event,
    command: entry.command,
    functionTags: entry.functionTags,
    spawns: entry.spawns,
    sourceDisabled: entry.sourceDisabled,
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    ...(entry.nativeGroup === undefined ? {} : { nativeGroup: entry.nativeGroup }),
    ...(entry.nativeHook === undefined ? {} : { nativeHook: entry.nativeHook }),
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
            nativeGroup: z.record(z.string(), z.unknown()).optional(),
            nativeHook: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(HOOK_REGISTRAR_MAX_RECEIPT_ENTRIES),
    carriedThrough: z.record(z.string(), z.array(z.unknown()).max(512)).optional(),
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
    // `prior.state` is what flips revocation from subtracting a key to removing
    // the file, and `prior.contents` is the A4 evidence. Recording a hash beside
    // the bytes and never checking it is the same defect as the command hash.
    if (
      receipt.prior.state === "present" &&
      sha256(receipt.prior.contents) !== receipt.prior.sha256
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["prior", "sha256"],
        message: "hook receipt prior bytes do not match the hash recorded beside them",
      });
    }
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
      const nativeIssues = [
        ...nativeHookFieldIssues(entry.nativeGroup ?? {}, ["hooks"]),
        // `timeout` is reserved only while the entry authors one of its own; a
        // captured value outside what the grammar can author is carried here.
        ...nativeHookFieldIssues(entry.nativeHook ?? {}, ["command"]),
      ];
      if (nativeIssues[0] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index],
          message: `hook receipt entry ${entry.id} records native fields AIH cannot transport: ${nativeIssues[0]}`,
        });
        continue;
      }
      reconstructable.push(entry as HookReceiptEntry);
    }
    for (const issue of hookRegistrationSetIssues(reconstructable.map(receiptRegistration))) {
      ctx.addIssue({ code: "custom", path: ["entries", issue.index], message: issue.message });
    }
  });

/** Parse receipt bytes a caller has already read, so one read can serve every use. */
export function parseHookRegistrarReceipt(raw: string): HookRegistrarReceipt {
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

export function readHookRegistrarReceipt(root: string): HookRegistrarReceipt | undefined {
  const read = readReceipt(root);
  // Refused, never treated as "no receipt": a receipt AIH cannot read is not a
  // receipt AIH never wrote. Reading it as absent would let the next projection
  // overwrite a destination AIH still owns, and would make revocation quietly
  // decide there is nothing to revoke.
  if (read.state === "unreadable") {
    throw new OrgPolicyError(`${read.reason}; refusing hook ownership`);
  }
  return read.state === "absent" ? undefined : parseHookRegistrarReceipt(read.contents);
}

/** The entry shape a receipt entry describes, for keying and re-emission. */
export function receiptNativeEntry(entry: HookReceiptEntry): NativeHookEntry {
  return {
    event: entry.event,
    command: entry.command,
    ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
    ...(entry.nativeGroup === undefined ? {} : { nativeGroup: entry.nativeGroup }),
    ...(entry.nativeHook === undefined ? {} : { nativeHook: entry.nativeHook }),
  };
}

/**
 * Rebuild the exact hook value the projection wrote: the entries AIH owns plus
 * the content it carried through. Both come from the ONE composer the
 * projection uses, so the expectation cannot drift from what was written.
 */
export function expectedHooksFromReceipt(receipt: HookRegistrarReceipt): Record<string, unknown> {
  return composeProjectedHooks(
    receipt.entries.map(receiptNativeEntry),
    receipt.carriedThrough ?? {},
  );
}

export type { HookRegistration };
