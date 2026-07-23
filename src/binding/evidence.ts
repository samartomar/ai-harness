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
import { bindingDir } from "./lock.js";
import { FRAMEWORK_IDS } from "./schema.js";

/**
 * Local verification evidence (W7 design §A.4) — a SEPARATE record from the
 * committed Framework Card, machine-level, in DERIVED storage. Where the card is
 * committed and MUST carry no machine-local path (H3), this record is
 * repo-local, gitignored, rebuildable, and ABSOLUTE PATHS ARE ITS PURPOSE: it
 * captures the exact checkout / install root, OS + CLI/runtime versions,
 * timestamps, contamination attribution, and (Phase 1b) the serialized doctor
 * transcript. It is NEVER an authority store — the committed DECLARATION stays
 * the only authority (D7).
 *
 * O3: it lives at repo-local `.aih/binding/evidence/<treeDigest>.json` beside the
 * lock, sharing the card's `treeDigest` identity so card and evidence
 * cross-reference. The writer mirrors `writeBindingLockAtomic` (validate -> temp
 * `0o600` -> rename) but is BEST-EFFORT on the fs write like `writeScanCache`
 * (`scan-gate.ts:1517`) — a write failure never changes any verdict; the next run
 * simply rebuilds it.
 */

export const LOCAL_EVIDENCE_SCHEMA_VERSION = 1 as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One contamination finding, with attribution (design §B.1 shape; abs paths allowed). */
export const EvidenceContaminationEntrySchema = z
  .object({
    /** The framework/surface the leakage is attributed to, when known. */
    framework: z.string().min(1).optional(),
    surface: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();
export type EvidenceContaminationEntry = z.infer<typeof EvidenceContaminationEntrySchema>;

/**
 * The local verification evidence record. Unlike the card, string fields MAY be
 * absolute machine paths — no `assertNoMachineLocalPath` runs here. Phase-2
 * payload (network-monitor results, process inventory) is intentionally absent.
 */
export const LocalVerificationEvidenceSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_EVIDENCE_SCHEMA_VERSION),
    /** Shared identity with the Framework Card (the scanned tree digest). */
    treeDigest: z.string().regex(SHA256_HEX),
    framework: z.enum(FRAMEWORK_IDS),
    /** The scanned checkout path (absolute — this is the record's purpose). */
    checkoutPath: z.string().min(1),
    /** The materialized install/surface root, when applicable (absolute). */
    installRoot: z.string().min(1).optional(),
    os: z
      .object({
        platform: z.string().min(1),
        release: z.string().min(1),
        arch: z.string().min(1),
      })
      .strict(),
    runtime: z
      .object({
        node: z.string().min(1),
        bun: z.string().min(1).optional(),
        /** The measured Claude Code version (provenance — see host-tuple §B.3). */
        claudeCode: z.string().min(1).optional(),
      })
      .strict(),
    /** ISO timestamp the evidence was measured (non-deterministic — never enters the card). */
    measuredAt: z.string().min(1),
    /** Contamination entries with attribution (empty when clean). */
    contamination: z.array(EvidenceContaminationEntrySchema),
    /** The serialized doctor transcript (Phase 1b populates the `Check[]`). */
    doctorTranscript: z.array(z.unknown()),
  })
  .strict();
export type LocalVerificationEvidence = z.infer<typeof LocalVerificationEvidenceSchema>;

/** Corrupt / schema-invalid local evidence — fail closed, never guess. */
export class LocalVerificationEvidenceError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_EVIDENCE");
  }
}

export function parseLocalVerificationEvidence(value: unknown): LocalVerificationEvidence {
  return LocalVerificationEvidenceSchema.parse(value);
}

/** `<root>/.aih/binding/evidence` — the derived, gitignored evidence dir (beside the lock). */
export function evidenceDir(root: string): string {
  return join(bindingDir(root), "evidence");
}

/** `<root>/.aih/binding/evidence/<treeDigest>.json` (O3). */
export function evidencePath(root: string, treeDigest: string): string {
  return join(evidenceDir(root), `${treeDigest}.json`);
}

function assertNotSymlink(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) {
    throw new LocalVerificationEvidenceError(`refusing symlinked evidence path: ${path}`);
  }
}

/**
 * Atomically write the evidence record (validate -> temp file with owner-only
 * mode -> rename), keyed by the record's own `treeDigest`. VALIDATION fails
 * closed (a malformed record is a caller bug); the fs write is BEST-EFFORT
 * (mirrors `writeScanCache`) — the record is rebuildable, so a write failure is
 * swallowed rather than allowed to change any verdict.
 */
export function writeLocalVerificationEvidenceAtomic(
  root: string,
  evidence: LocalVerificationEvidence,
): void {
  const parsed = parseLocalVerificationEvidence(evidence);
  const contents = `${JSON.stringify(parsed, null, 2)}\n`;
  const directory = evidenceDir(root);
  const path = evidencePath(root, parsed.treeDigest);
  try {
    mkdirSync(directory, { recursive: true });
    assertNotSymlink(path);
    const temporary = join(directory, `.evidence.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      chmodSync(temporary, 0o600);
      retryTransient(() => renameSync(temporary, path));
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch (err) {
    // Derived record: a symlink refusal is a security stop and propagates; any
    // other fs failure is swallowed (the evidence rebuilds on the next run).
    if (err instanceof LocalVerificationEvidenceError) throw err;
  }
}

/**
 * Read a local evidence record by tree digest. Absent => `undefined`. A present
 * file that is unparseable / schema-invalid FAILS CLOSED with
 * {@link LocalVerificationEvidenceError} (mirrors `readBindingLock`).
 */
export function readLocalVerificationEvidence(
  root: string,
  treeDigest: string,
): LocalVerificationEvidence | undefined {
  const path = evidencePath(root, treeDigest);
  assertNotSymlink(path);
  const raw = readIfExists(path);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalVerificationEvidenceError(`local evidence is not valid JSON: ${path}`);
  }
  const result = LocalVerificationEvidenceSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new LocalVerificationEvidenceError(`invalid local evidence ${path}${where}`);
  }
  return result.data;
}
