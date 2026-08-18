import { createHash } from "node:crypto";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertNotProxyV1,
  assertRecordV1,
  assertSha256V1,
  assertUniqueV1,
  GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
  sortByCodeUnitsV1,
} from "./capability-v1.js";
import {
  assertManagedTokenV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS,
} from "./repair-capability-v1.js";
import { canonicalGovernanceDoctorRepairReceiptV1Bytes } from "./repair-outcome-v1.js";

/**
 * The closed content toolkit the mechanical Repair executor and verifier share:
 * the exact trusted content input, deterministic line-ending normalization, and
 * the closed marker-block syntax.
 *
 * Nothing here reaches the filesystem, a process, or a clock. Every function is
 * pure over bytes the caller already holds.
 *
 * A Plan names content only by digest. This module is the one place those bytes
 * may enter, and they enter only through {@link createGovernanceDoctorRepairContentV1},
 * which re-hashes every entry itself. Bytes that do not independently reproduce
 * their declared digest are refused rather than trusted, so a plan digest can
 * never be satisfied by content nobody vouched for. The bytes stay behind a brand
 * and are handed out only as defensive copies; they are data to write, never text
 * to interpret and never anything to run.
 *
 * The shaping functions return `null` rather than throwing. Their callers turn a
 * refusal into one closed per-effect `failed` result, and a `null` forces that
 * branch to be written; a thrown error would let an unsafe file read as an
 * exceptional condition instead of a recorded outcome.
 */
export interface GovernanceDoctorRepairContentV1 {
  readonly protocol: "GovernanceDoctorRepairContentV1";
}

/** Hard, non-negotiable ceilings. Every bound is a raw count or byte. */
export const GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS = Object.freeze({
  maxContentBytes: 256 * 1024,
  maxContentEntries: 16,
});

const CONTENT_PROTOCOL = "GovernanceDoctorRepairContentV1";

/**
 * The closed marker syntax. A region is delimited by two whole lines, each
 * exactly `<!-- AIH-REPAIR-<BEGIN|END> <blockId> -->`; a marker token appearing
 * anywhere else -- indented, suffixed, inline, or with an unparseable id -- makes
 * the file malformed rather than partially understood.
 */
const MARKER_BEGIN_PREFIX = "<!-- AIH-REPAIR-BEGIN ";
const MARKER_END_PREFIX = "<!-- AIH-REPAIR-END ";
const MARKER_SUFFIX = " -->";
const MARKER_TOKENS = Object.freeze(["AIH-REPAIR-BEGIN", "AIH-REPAIR-END"] as const);

const NUL = "\u0000";

/** Anti-forgery brand: a structurally identical plain object is not trusted content. */
const contentEntries = new WeakMap<object, ReadonlyMap<string, Buffer>>();

/**
 * Process-local, non-authorizing evidence for the exact post-state an executor
 * observed while minting a Receipt. It is deliberately keyed by the branded
 * Receipt object: transported receipts have no entry and therefore verify only as
 * unavailable rather than gaining an attribution claim from caller data.
 */
export type GovernanceDoctorRepairAttemptExpectedV1 =
  | { readonly effectSha256: string; readonly state: "directory" }
  | { readonly bytes: Buffer; readonly effectSha256: string; readonly state: "file" };

const attemptEvidence = new WeakMap<
  object,
  ReadonlyMap<string, GovernanceDoctorRepairAttemptExpectedV1>
>();

const ATTEMPT_EVIDENCE_STATES = ["directory", "file"] as const;
const ATTEMPT_EVIDENCE_DIRECTORY_FIELDS = ["effectSha256", "state"] as const;
const ATTEMPT_EVIDENCE_FILE_FIELDS = ["bytes", "effectSha256", "state"] as const;

const RECEIPT_PROTOCOL_V1 = "GovernanceDoctorRepairReceiptV1";
const RECEIPT_STATES_V1 = ["applied-unverified", "failed"] as const;
const RECEIPT_EFFECT_RESULTS_V1 = ["applied", "failed", "skipped"] as const;
const RECEIPT_FIELDS_V1 = [
  "attemptedAtEpochMs",
  "brokerId",
  "consentSha256",
  "effects",
  "executorId",
  "owner",
  "planSha256",
  "protocol",
  "recipeSha256",
  "receiptSha256",
  "registrySha256",
  "rootSha256",
  "state",
] as const;

/**
 * Proves one value is the authentic Receipt this evidence may be attributed to,
 * and reports the effect identities it actually records as applied.
 *
 * The brand is the boundary: only a Receipt the outcome contract itself minted
 * carries canonical bytes, so a structural look-alike, a spread copy, a bare
 * object, or a primitive has no entry and is refused before a single field is
 * read. Every field is then re-validated here anyway, because a boundary that
 * rests on what its caller promised is not one -- and because these are the facts
 * the membership and coherence checks below are entitled to rely on.
 *
 * Validation is deliberately closed and getter-free: the record must be a plain
 * object of own data properties carrying exactly the Receipt's field set, and
 * every digest and enum must parse. A state that disagrees with its own effect
 * results is refused rather than reconciled, so evidence can never be attributed
 * to a record whose two accounts of the attempt do not match.
 */
function attemptEvidenceReceiptV1(value: unknown): ReadonlySet<string> {
  const bytes = canonicalGovernanceDoctorRepairReceiptV1Bytes(value);
  if (bytes.length === 0 || bytes.length > GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes)
    failGovernanceDoctorRepairV1("repair attempt evidence receipt exceeds its bounded byte length");
  const record = assertRecordV1(value, "repair attempt evidence receipt");
  assertExactKeysV1(record, RECEIPT_FIELDS_V1, "repair attempt evidence receipt");
  if (record.protocol !== RECEIPT_PROTOCOL_V1)
    failGovernanceDoctorRepairV1("repair attempt evidence receipt protocol is invalid");
  assertSha256V1(record.receiptSha256, "repair attempt evidence receipt identity");
  assertSha256V1(record.planSha256, "repair attempt evidence receipt plan identity");
  assertSha256V1(record.consentSha256, "repair attempt evidence receipt consent identity");
  const state = assertEnumV1(
    record.state,
    RECEIPT_STATES_V1,
    "repair attempt evidence receipt state",
  );
  const applied = new Set<string>();
  let everyEffectApplied = true;
  for (const item of assertArrayV1(
    record.effects,
    1,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
    "repair attempt evidence receipt effects",
  )) {
    const effect = assertRecordV1(item, "repair attempt evidence receipt effect");
    assertExactKeysV1(
      effect,
      ["effectId", "effectSha256", "result"],
      "repair attempt evidence receipt effect",
    );
    const effectSha256 = assertSha256V1(
      effect.effectSha256,
      "repair attempt evidence receipt effect identity",
    );
    if (
      assertEnumV1(
        effect.result,
        RECEIPT_EFFECT_RESULTS_V1,
        "repair attempt evidence receipt effect result",
      ) === "applied"
    )
      applied.add(effectSha256);
    else everyEffectApplied = false;
  }
  // A Receipt reads `applied-unverified` only when every effect applied. The two
  // accounts are re-joined here so a record whose state and results disagree can
  // never be the thing local evidence is attributed to.
  if ((state === "applied-unverified") !== everyEffectApplied)
    failGovernanceDoctorRepairV1(
      "repair attempt evidence receipt state does not match its effect results",
    );
  return applied;
}

export function recordGovernanceDoctorRepairAttemptEvidenceV1(
  receipt: unknown,
  expected: unknown,
): void {
  const appliedEffectSha256 = attemptEvidenceReceiptV1(receipt);
  const target = receipt as object;
  // One-shot per Receipt. Evidence is a factual record of what one executor
  // observed, so a second recording could only replace an attempt's own truth
  // with a later party's account of it -- refused rather than merged.
  if (attemptEvidence.has(target))
    failGovernanceDoctorRepairV1("repair attempt evidence is already recorded for this receipt");
  const entries = new Map<string, GovernanceDoctorRepairAttemptExpectedV1>();
  for (const item of assertArrayV1(
    expected,
    0,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
    "repair attempt evidence",
  )) {
    const entry = assertRecordV1(item, "repair attempt evidence entry");
    const state = assertEnumV1(
      entry.state,
      ATTEMPT_EVIDENCE_STATES,
      "repair attempt evidence entry state",
    );
    assertExactKeysV1(
      entry,
      state === "file" ? ATTEMPT_EVIDENCE_FILE_FIELDS : ATTEMPT_EVIDENCE_DIRECTORY_FIELDS,
      "repair attempt evidence entry",
    );
    const effectSha256 = assertSha256V1(
      entry.effectSha256,
      "repair attempt evidence entry effect identity",
    );
    // Evidence is only ever a record of work this Receipt itself says happened,
    // so an identity it does not carry -- and one it carries as failed or skipped
    // -- are the same refusal.
    if (!appliedEffectSha256.has(effectSha256))
      failGovernanceDoctorRepairV1(
        "repair attempt evidence names an effect this receipt did not apply",
      );
    if (entries.has(effectSha256))
      failGovernanceDoctorRepairV1("repair attempt evidence repeats an effect identity");
    entries.set(
      effectSha256,
      state === "file"
        ? Object.freeze({
            bytes: contentBytes(entry.bytes, "repair attempt evidence entry bytes"),
            effectSha256,
            state: "file" as const,
          })
        : Object.freeze({ effectSha256, state: "directory" as const }),
    );
  }
  attemptEvidence.set(target, entries);
}

/** Missing evidence is intentional: an independently reconstructed receipt is not proof of local mutation. */
export function governanceDoctorRepairAttemptExpectedV1(
  receipt: unknown,
  effectSha256: unknown,
): GovernanceDoctorRepairAttemptExpectedV1 | undefined {
  if (typeof receipt !== "object" || receipt === null || typeof effectSha256 !== "string")
    return undefined;
  const expected = attemptEvidence.get(receipt)?.get(effectSha256);
  return expected === undefined
    ? undefined
    : expected.state === "file"
      ? Object.freeze({
          bytes: Buffer.from(expected.bytes),
          effectSha256: expected.effectSha256,
          state: "file",
        })
      : Object.freeze({ effectSha256: expected.effectSha256, state: "directory" });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentBytes(value: unknown, label: string): Buffer {
  assertNotProxyV1(value, label);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    failGovernanceDoctorRepairV1(`${label} must be bytes`);
  const bytes = Buffer.from(value as Uint8Array);
  if (bytes.length > GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes)
    failGovernanceDoctorRepairV1(`${label} exceeds its bounded byte length`);
  return bytes;
}

/**
 * Validates untrusted content and mints a branded, frozen, digest-keyed input.
 * Each entry is re-hashed here rather than taken on the caller's word, and each
 * value is copied, so a caller that mutates its input afterwards cannot reach
 * into what the executor later writes.
 */
export function createGovernanceDoctorRepairContentV1(
  input: unknown,
): GovernanceDoctorRepairContentV1 {
  const request = assertRecordV1(input, "repair content input");
  assertExactKeysV1(request, ["entries"], "repair content input");
  const entries = assertArrayV1(
    request.entries,
    0,
    GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentEntries,
    "repair content entries",
  ).map((item) => {
    const record = assertRecordV1(item, "repair content entry");
    assertExactKeysV1(record, ["bytes", "contentSha256"], "repair content entry");
    const bytes = contentBytes(record.bytes, "repair content entry bytes");
    const contentSha256 = assertSha256V1(record.contentSha256, "repair content entry digest");
    // The digest is evidence only when this module reproduces it.
    if (sha256(bytes) !== contentSha256)
      failGovernanceDoctorRepairV1("repair content entry does not match its declared digest");
    return { bytes, contentSha256 };
  });
  assertUniqueV1(
    entries.map((entry) => entry.contentSha256),
    "repair content entries",
  );
  const content = Object.freeze({ protocol: CONTENT_PROTOCOL as typeof CONTENT_PROTOCOL });
  contentEntries.set(
    content,
    new Map(
      sortByCodeUnitsV1(entries, (entry) => entry.contentSha256).map((entry) => [
        entry.contentSha256,
        entry.bytes,
      ]),
    ),
  );
  return content;
}

/** Every digest a trusted content input carries, in deterministic order. */
export function governanceDoctorRepairContentDigestsV1(content: unknown): readonly string[] {
  return [...brandedRepairValueV1(contentEntries, content, "repair content input").keys()];
}

/** The exact bytes registered for one digest, as a defensive copy, or fails closed. */
export function governanceDoctorRepairContentBytesV1(
  content: unknown,
  contentSha256: unknown,
): Buffer {
  const entries = brandedRepairValueV1(contentEntries, content, "repair content input");
  const bytes = typeof contentSha256 === "string" ? entries.get(contentSha256) : undefined;
  if (bytes === undefined)
    failGovernanceDoctorRepairV1("repair content input does not carry this digest");
  return Buffer.from(bytes);
}

/**
 * A trusted content input must hold exactly the digests a set of effects names --
 * no more and no fewer. A missing digest would leave an effect unsatisfiable; an
 * extra one would mean bytes travelled to the caller that no consented effect ever
 * asked for. The executor and the verifier each enforce this independently.
 */
export function assertGovernanceDoctorRepairContentClosureV1(
  content: unknown,
  effects: readonly { readonly arguments: Readonly<Record<string, string>> }[],
): void {
  const required = new Set<string>();
  for (const effect of effects) {
    const digest = effect.arguments.contentSha256;
    if (digest !== undefined) required.add(digest);
  }
  const supplied = governanceDoctorRepairContentDigestsV1(content);
  if (supplied.length !== required.size || supplied.some((digest) => !required.has(digest)))
    failGovernanceDoctorRepairV1("repair content input is not exactly the plan's digest closure");
}

/** The exact BEGIN line for one code-owned block identity. */
export function governanceDoctorRepairMarkerBeginLineV1(blockId: unknown): string {
  const token = assertManagedTokenV1(blockId, "repair marker block ID");
  return `${MARKER_BEGIN_PREFIX}${token}${MARKER_SUFFIX}`;
}

/** The exact END line for one code-owned block identity. */
export function governanceDoctorRepairMarkerEndLineV1(blockId: unknown): string {
  const token = assertManagedTokenV1(blockId, "repair marker block ID");
  return `${MARKER_END_PREFIX}${token}${MARKER_SUFFIX}`;
}

/** A block identity as data: refused by returning nothing, never by throwing. */
function safeBlockId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedTokenCodeUnits &&
    GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Bounded, strict UTF-8 text with no byte-order mark and no NUL. Anything a
 * decoder would have to guess about is refused rather than repaired.
 */
function safeText(bytes: unknown): string | null {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes
  )
    return null;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes(NUL) ? null : text;
}

/**
 * Rewrites every CRLF to LF and leaves an already-normalized file untouched. A
 * lone carriage return is ambiguous -- it could be a classic-Mac terminator or
 * literal data -- so it is refused rather than interpreted. Nothing else about the
 * content is read: this never trims, re-indents, or adds a final newline.
 */
export function normalizeGovernanceDoctorRepairLineEndingsV1(bytes: unknown): Buffer | null {
  const text = safeText(bytes);
  if (text === null) return null;
  for (let index = text.indexOf("\r"); index !== -1; index = text.indexOf("\r", index + 1))
    if (text.charCodeAt(index + 1) !== 0x0a) return null;
  return Buffer.from(text.split("\r\n").join("\n"), "utf8");
}

type MarkerLine = { readonly blockId: string; readonly kind: "begin" | "end" } | null | "malformed";

/** Classifies one line: a well-formed marker, ordinary text, or malformed. */
function markerLine(line: string): MarkerLine {
  if (!MARKER_TOKENS.some((token) => line.includes(token))) return null;
  const kind = line.startsWith(MARKER_BEGIN_PREFIX)
    ? "begin"
    : line.startsWith(MARKER_END_PREFIX)
      ? "end"
      : null;
  if (kind === null || !line.endsWith(MARKER_SUFFIX)) return "malformed";
  const prefix = kind === "begin" ? MARKER_BEGIN_PREFIX : MARKER_END_PREFIX;
  const blockId = safeBlockId(line.slice(prefix.length, line.length - MARKER_SUFFIX.length));
  return blockId === null ? "malformed" : { blockId, kind };
}

interface MarkerRegion {
  readonly begin: number;
  readonly end: number;
  readonly lines: readonly string[];
}

/**
 * Locates the one region a block identity owns.
 *
 * The grammar is a stack, closed over the whole file rather than over the target
 * alone: every END must close the BEGIN that is still innermost, so regions may
 * nest but may never cross. Zero regions, a second BEGIN or END for any block, a
 * second complete region for any block, an END before its BEGIN, an END that
 * closes something other than the innermost open block, a BEGIN still open at end
 * of file, a marker-shaped line that does not parse, and any other block's marker
 * inside the target region are each a refusal.
 *
 * Judging the whole file matters even when the ambiguity sits far from the target:
 * a file whose fences cross anywhere has no single reading, and a splice that
 * assumed one would be writing into a document nobody can say the shape of. Such a
 * file is the one file that must never be spliced, so no partial understanding of
 * it is ever acted on.
 */
function markerRegion(bytes: unknown, blockIdValue: unknown): MarkerRegion | null {
  const blockId = safeBlockId(blockIdValue);
  const text = safeText(bytes);
  if (blockId === null || text === null || text.includes("\r")) return null;
  const lines = text.split("\n");
  let begin = -1;
  let end = -1;
  const foreign: number[] = [];
  const open: string[] = [];
  const closed = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const marker = markerLine(lines[index] as string);
    if (marker === null) continue;
    if (marker === "malformed") return null;
    if (marker.kind === "begin") {
      // Grammar is judged over the whole file, not just the target region: a
      // block id that is already open, or that already owns a closed region, makes
      // the file ambiguous no matter which block this call was asked to read.
      if (open.includes(marker.blockId) || closed.has(marker.blockId)) return null;
      open.push(marker.blockId);
    } else {
      // Stack discipline: an END closes the innermost open block or nothing. This
      // is what refuses crossed regions, whose markers pair up as a set but do not
      // nest -- a shape with no single reading anywhere in the file.
      if (open.pop() !== marker.blockId) return null;
      closed.add(marker.blockId);
    }
    if (marker.blockId !== blockId) {
      foreign.push(index);
      continue;
    }
    if (marker.kind === "begin") {
      if (begin !== -1) return null;
      begin = index;
      continue;
    }
    if (end !== -1 || begin === -1) return null;
    end = index;
  }
  if (begin === -1 || end === -1 || open.length !== 0) return null;
  return foreign.some((index) => index > begin && index < end) ? null : { begin, end, lines };
}

/** The exact body of the one well-formed region, or nothing when it is not exact. */
export function governanceDoctorRepairMarkerBlockBodyV1(
  bytes: unknown,
  blockId: unknown,
): Buffer | null {
  const region = markerRegion(bytes, blockId);
  return region === null
    ? null
    : Buffer.from(region.lines.slice(region.begin + 1, region.end).join("\n"), "utf8");
}

/**
 * Replaces one region's body and preserves every byte outside it verbatim. The new
 * body must itself be safe text carrying no marker token, so a rewrite can never
 * open, close, or forge a fence. Deterministic and idempotent: splicing the same
 * body twice reproduces the same bytes.
 */
export function rewriteGovernanceDoctorRepairMarkerBlockV1(
  bytes: unknown,
  blockId: unknown,
  body: unknown,
): Buffer | null {
  const region = markerRegion(bytes, blockId);
  const bodyText = safeText(body);
  if (region === null || bodyText === null || bodyText.includes("\r")) return null;
  const bodyLines = bodyText.split("\n");
  if (bodyLines.some((line) => markerLine(line) !== null)) return null;
  return Buffer.from(
    [
      ...region.lines.slice(0, region.begin + 1),
      ...bodyLines,
      ...region.lines.slice(region.end),
    ].join("\n"),
    "utf8",
  );
}
