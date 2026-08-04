import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets } from "../guardrails/redact.js";
import { readRegularFile, retryTransient } from "../internals/fsxn.js";
import type {
  HookClient,
  HookHandler,
  HookHandlerDecision,
  LogicalHookEvent,
  NormalizedHookEvent,
} from "./hook-core.js";

export const LEARNING_LIMITS = {
  retentionMs: 90 * 24 * 60 * 60 * 1_000,
  maxRecords: 64,
  maxSummaryCharacters: 2_000,
  maxIntentCharacters: 1_000,
} as const;

export const OBSERVABILITY_LIMITS = {
  retentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxRecords: 128,
  maxToolCharacters: 128,
  maxDurationMs: 24 * 60 * 60 * 1_000,
} as const;

const DEFAULT_STATE_FILE_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const AUTHENTICATION_HEADER =
  /\b(proxy-authorization|authorization|proxy-authentication-info|authentication-info|www-authenticate|x-api-key|api-key|x-auth-token|x-client-secret|client-secret|private-token|set-cookie|cookie)\s*:\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi;
const LEARNING_EVENTS = [
  "after-tool",
  "tool-failure",
  "after-compact",
  "session-end",
  "stop",
] as const;
const OBSERVABILITY_EVENTS = [
  "session-start",
  "session-end",
  "after-tool",
  "tool-failure",
  "after-compact",
  "stop",
] as const;

function boundedText(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join("");
}

function sanitizedText(value: string, maxCharacters: number): string {
  const withoutHeaders = value.replace(AUTHENTICATION_HEADER, "$1: [REDACTED]");
  return boundedText(redactSecrets(withoutHeaders), maxCharacters);
}

function safeText(value: string, name: string, maxCharacters: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Array.from(value).length > maxCharacters
  ) {
    throw new Error(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function safeEpoch(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function sameWorktree(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function existingDirectory(path: string, name: string): string {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory`);
  }
  return realpathSync(path);
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

interface ScopedRecord {
  id: string;
  repositoryId: string;
  canonicalWorktree: string;
  harness: string;
  updatedAtEpochMs: number;
}

interface ScopedStoreOptions<T extends ScopedRecord> {
  stateRoot: string;
  canonicalWorktree: string;
  repositoryId: string;
  harness: string;
  namespace: "learning" | "personal-observability";
  maxRecords: number;
  maxFileBytes?: number;
  validate: (record: T) => void;
}

interface ScopedStore<T extends ScopedRecord> {
  list(): readonly T[];
  save(record: T): void;
  prune(beforeEpochMs: number): void;
}

function createScopedStore<T extends ScopedRecord>(options: ScopedStoreOptions<T>): ScopedStore<T> {
  if (!isAbsolute(options.stateRoot) || !isAbsolute(options.canonicalWorktree)) {
    throw new Error(`${options.namespace} roots must be absolute`);
  }
  const stateRoot = existingDirectory(
    resolve(options.stateRoot),
    `${options.namespace} state root`,
  );
  const worktree = existingDirectory(
    resolve(options.canonicalWorktree),
    `${options.namespace} canonical worktree`,
  );
  if (containsPath(worktree, stateRoot) || containsPath(stateRoot, worktree)) {
    throw new Error(`${options.namespace} state root must be outside the canonical worktree`);
  }
  const repositoryId = safeText(options.repositoryId, `${options.namespace} repositoryId`, 512);
  const harness = safeText(options.harness, `${options.namespace} harness`, 64);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_STATE_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16 * 1024 * 1024) {
    throw new Error(`${options.namespace} maxFileBytes is invalid`);
  }
  const directory = join(stateRoot, options.namespace);
  try {
    mkdirSync(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalDirectory = existingDirectory(directory, `${options.namespace} directory`);
  if (!containsPath(stateRoot, canonicalDirectory)) {
    throw new Error(`${options.namespace} directory escapes its state root`);
  }
  const key = sha256(`${repositoryId}\0${worktree}\0${harness}`);
  const file = join(canonicalDirectory, `${key}.json`);

  const assertScope = (record: T) => {
    let recordWorktree: string;
    try {
      recordWorktree = existingDirectory(
        resolve(record.canonicalWorktree),
        `${options.namespace} record worktree`,
      );
    } catch {
      throw new Error(`${options.namespace} record conflicts with its store scope`);
    }
    if (
      record.repositoryId !== repositoryId ||
      !sameWorktree(recordWorktree, worktree) ||
      record.harness !== harness
    ) {
      throw new Error(`${options.namespace} record conflicts with its store scope`);
    }
  };

  const read = (): T[] => {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`${options.namespace} state must be a regular file: ${file}`);
    }
    const raw = readRegularFile(file, { maxBytes: maxFileBytes });
    if (raw === undefined) {
      throw new Error(`${options.namespace} state could not be read safely: ${file}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`${options.namespace} state is malformed: ${file}`);
    }
    if (!Array.isArray(parsed) || parsed.length > options.maxRecords) {
      throw new Error(`${options.namespace} state is malformed: ${file}`);
    }
    for (const item of parsed) {
      options.validate(item as T);
      assertScope(item as T);
    }
    return parsed as T[];
  };

  const write = (records: readonly T[]) => {
    for (const record of records) {
      options.validate(record);
      assertScope(record);
    }
    const sorted = [...records]
      .sort(
        (left, right) =>
          left.updatedAtEpochMs - right.updatedAtEpochMs || left.id.localeCompare(right.id),
      )
      .slice(-options.maxRecords);
    const contents = `${JSON.stringify(sorted, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > maxFileBytes) {
      throw new Error(`${options.namespace} state exceeds its file limit`);
    }
    const temp = join(dirname(file), `.${key}.${process.pid}.tmp`);
    try {
      const stats = lstatSync(temp);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`${options.namespace} temporary path is unsafe: ${temp}`);
      }
      rmSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    retryTransient(() =>
      writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    );
    try {
      retryTransient(() => renameSync(temp, file));
    } finally {
      try {
        rmSync(temp);
      } catch {
        // Best-effort cleanup must not mask a successful atomic replacement.
      }
    }
  };

  return {
    list: read,
    save(record) {
      options.validate(record);
      assertScope(record);
      write([...read().filter((item) => item.id !== record.id), structuredClone(record)]);
    },
    prune(beforeEpochMs) {
      safeEpoch(beforeEpochMs, `${options.namespace} prune time`);
      const current = read();
      const retained = current.filter((record) => record.updatedAtEpochMs >= beforeEpochMs);
      if (retained.length !== current.length) write(retained);
    },
  };
}

interface LearningRecordBase extends ScopedRecord {
  version: 1;
}

export interface LearningObservation extends LearningRecordBase {
  kind: "observation";
  sessionId: string;
  event: (typeof LEARNING_EVENTS)[number];
  summary: string;
}

export interface LearningCandidate extends LearningRecordBase {
  kind: "candidate";
  sessionId: string;
  event: "after-compact" | "session-end" | "stop";
  summary: string;
  sourceObservationId: string;
  sha256: string;
  discoverable: false;
  status: "pending-review";
}

export interface LearningApproval extends LearningRecordBase {
  kind: "approval";
  candidateId: string;
  sourceObservationId: string;
  candidateSha256: string;
  approvedBy: string;
  reason: string;
}

export type LearningStateRecord = LearningObservation | LearningCandidate | LearningApproval;

export interface LearningStateStore {
  list(): readonly LearningStateRecord[];
  save(record: LearningStateRecord): void;
  prune(beforeEpochMs: number): void;
}

export interface FileOptInStoreOptions {
  stateRoot: string;
  canonicalWorktree: string;
  repositoryId: string;
  harness: string;
  maxFileBytes?: number;
}

function exactFields(record: object, fields: readonly string[], name: string): void {
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error(`${name} record is malformed`);
  }
}

function validateBase(record: LearningRecordBase | ObservabilityRecord, name: string): void {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== 1
  ) {
    throw new Error(`${name} record is malformed`);
  }
  if (!SHA256.test(record.id)) throw new Error(`${name} record id is malformed`);
  safeText(record.repositoryId, `${name} repositoryId`, 512);
  safeText(record.canonicalWorktree, `${name} canonicalWorktree`, 4_096);
  safeText(record.harness, `${name} harness`, 64);
  safeEpoch(record.updatedAtEpochMs, `${name} updatedAtEpochMs`);
}

function candidateDigest(candidate: Omit<LearningCandidate, "sha256">): string {
  return sha256(
    JSON.stringify([
      candidate.version,
      candidate.repositoryId,
      comparablePath(candidate.canonicalWorktree),
      candidate.harness,
      candidate.sessionId,
      candidate.event,
      candidate.summary,
      candidate.sourceObservationId,
      candidate.discoverable,
      candidate.status,
    ]),
  );
}

function validateLearningRecord(record: LearningStateRecord): void {
  validateBase(record, "learning");
  if (record.kind === "observation") {
    exactFields(
      record,
      [
        "version",
        "kind",
        "id",
        "repositoryId",
        "canonicalWorktree",
        "harness",
        "updatedAtEpochMs",
        "sessionId",
        "event",
        "summary",
      ],
      "learning observation",
    );
    if (!SHA256.test(record.sessionId) || !LEARNING_EVENTS.includes(record.event)) {
      throw new Error("learning observation record is malformed");
    }
    if (
      record.summary.includes("\0") ||
      Array.from(record.summary).length > LEARNING_LIMITS.maxSummaryCharacters
    ) {
      throw new Error("learning observation summary is malformed");
    }
    return;
  }
  if (record.kind === "candidate") {
    exactFields(
      record,
      [
        "version",
        "kind",
        "id",
        "repositoryId",
        "canonicalWorktree",
        "harness",
        "updatedAtEpochMs",
        "sessionId",
        "event",
        "summary",
        "sourceObservationId",
        "sha256",
        "discoverable",
        "status",
      ],
      "learning candidate",
    );
    if (
      !SHA256.test(record.sessionId) ||
      !["after-compact", "session-end", "stop"].includes(record.event) ||
      !SHA256.test(record.sourceObservationId) ||
      !SHA256.test(record.sha256) ||
      record.discoverable !== false ||
      record.status !== "pending-review" ||
      record.summary.includes("\0") ||
      Array.from(record.summary).length > LEARNING_LIMITS.maxSummaryCharacters
    ) {
      throw new Error("learning candidate record is malformed");
    }
    const { sha256: _digest, ...unsigned } = record;
    if (candidateDigest(unsigned) !== record.sha256) {
      throw new Error("learning candidate digest is malformed");
    }
    return;
  }
  if (record.kind === "approval") {
    exactFields(
      record,
      [
        "version",
        "kind",
        "id",
        "repositoryId",
        "canonicalWorktree",
        "harness",
        "updatedAtEpochMs",
        "candidateId",
        "sourceObservationId",
        "candidateSha256",
        "approvedBy",
        "reason",
      ],
      "learning approval",
    );
    if (
      !SHA256.test(record.candidateId) ||
      !SHA256.test(record.sourceObservationId) ||
      !SHA256.test(record.candidateSha256)
    ) {
      throw new Error("learning approval provenance is malformed");
    }
    safeText(record.approvedBy, "learning approval approvedBy", 256);
    safeText(record.reason, "learning approval reason", LEARNING_LIMITS.maxIntentCharacters);
    return;
  }
  throw new Error("learning record is malformed");
}

export function createFileLearningStore(options: FileOptInStoreOptions): LearningStateStore {
  return createScopedStore({
    ...options,
    namespace: "learning",
    maxRecords: LEARNING_LIMITS.maxRecords,
    validate: validateLearningRecord,
  });
}

export interface LearningHandlerOptions {
  enabled: boolean;
  repositoryId: string;
  canonicalWorktree: string;
  harness: string;
  store: LearningStateStore;
  now?: () => number;
}

function eventLearningSummary(event: Readonly<NormalizedHookEvent>): string {
  if (event.event === "after-tool") {
    return sanitizedText(
      `Tool ${event.tool?.name ?? "unknown"} completed.`,
      LEARNING_LIMITS.maxSummaryCharacters,
    );
  }
  if (event.event === "tool-failure") {
    return sanitizedText(
      `Tool ${event.tool?.name ?? "unknown"} failed${event.tool?.error ? `: ${event.tool.error}` : "."}`,
      LEARNING_LIMITS.maxSummaryCharacters,
    );
  }
  const source =
    event.event === "after-compact" ? event.compactSummary : event.lastAssistantMessage;
  return source ? sanitizedText(source, LEARNING_LIMITS.maxSummaryCharacters) : "";
}

export function createLearningHandler(options: LearningHandlerOptions): HookHandler {
  if (typeof options.enabled !== "boolean") throw new Error("learning opt-in must be explicit");
  const repositoryId = safeText(options.repositoryId, "learning repositoryId", 512);
  const canonicalWorktree = safeText(
    options.canonicalWorktree,
    "learning canonicalWorktree",
    4_096,
  );
  const harness = safeText(options.harness, "learning harness", 64);
  const now = options.now ?? Date.now;
  return {
    id: "learning",
    events: LEARNING_EVENTS,
    enabled: options.enabled,
    order: 40,
    timeoutMs: 2_000,
    failurePolicy: "open",
    redactionPolicy: "sensitive-values",
    storagePolicy: "aih-state",
    run(event): HookHandlerDecision {
      if (!options.enabled) return { action: "continue" };
      if (!sameWorktree(event.cwd, canonicalWorktree)) {
        throw new Error("learning event belongs to a foreign worktree");
      }
      const timestamp = safeEpoch(now(), "learning clock");
      options.store.prune(Math.max(0, timestamp - LEARNING_LIMITS.retentionMs));
      const summary = eventLearningSummary(event);
      if (summary.length === 0) return { action: "continue" };
      const sessionId = sha256(event.sessionId);
      const observationId = sha256(
        JSON.stringify([
          repositoryId,
          comparablePath(canonicalWorktree),
          harness,
          sessionId,
          event.event,
          timestamp,
          summary,
        ]),
      );
      const observation: LearningObservation = {
        version: 1,
        kind: "observation",
        id: observationId,
        repositoryId,
        canonicalWorktree,
        harness,
        updatedAtEpochMs: timestamp,
        sessionId,
        event: event.event as (typeof LEARNING_EVENTS)[number],
        summary,
      };
      validateLearningRecord(observation);
      options.store.save(observation);
      if (["after-compact", "session-end", "stop"].includes(event.event)) {
        const unsigned: Omit<LearningCandidate, "sha256"> = {
          version: 1,
          kind: "candidate",
          id: sha256(`candidate\0${observationId}`),
          repositoryId,
          canonicalWorktree,
          harness,
          updatedAtEpochMs: timestamp,
          sessionId,
          event: event.event as LearningCandidate["event"],
          summary,
          sourceObservationId: observationId,
          discoverable: false,
          status: "pending-review",
        };
        const candidate: LearningCandidate = { ...unsigned, sha256: candidateDigest(unsigned) };
        validateLearningRecord(candidate);
        options.store.save(candidate);
      }
      return { action: "continue" };
    },
  };
}

export interface ApproveLearningCandidateOptions {
  store: LearningStateStore;
  candidateId: string;
  humanIntent: {
    approvedBy: string;
    reason: string;
    approvedAtEpochMs: number;
  };
  provenance: {
    sourceObservationId: string;
    candidateSha256: string;
  };
}

/** Records approval evidence only. Materialization into discoverable skills is a later lifecycle step. */
export function approveLearningCandidate(
  options: ApproveLearningCandidateOptions,
): LearningApproval {
  if (!SHA256.test(options.candidateId)) throw new Error("learning candidateId is malformed");
  const approvedBy = safeText(options.humanIntent.approvedBy, "learning approval approvedBy", 256);
  const reason = safeText(
    options.humanIntent.reason,
    "learning approval reason",
    LEARNING_LIMITS.maxIntentCharacters,
  );
  const approvedAtEpochMs = safeEpoch(
    options.humanIntent.approvedAtEpochMs,
    "learning approval time",
  );
  const records = options.store.list();
  const candidate = records.find(
    (record): record is LearningCandidate =>
      record.kind === "candidate" && record.id === options.candidateId,
  );
  if (!candidate) throw new Error("learning candidate does not exist");
  validateLearningRecord(candidate);
  const observation = records.find(
    (record): record is LearningObservation =>
      record.kind === "observation" && record.id === candidate.sourceObservationId,
  );
  if (
    !observation ||
    options.provenance.sourceObservationId !== candidate.sourceObservationId ||
    options.provenance.candidateSha256 !== candidate.sha256
  ) {
    throw new Error("learning approval provenance does not match the candidate");
  }
  validateLearningRecord(observation);
  if (approvedAtEpochMs < candidate.updatedAtEpochMs) {
    throw new Error("learning approval predates its candidate");
  }
  const approval: LearningApproval = {
    version: 1,
    kind: "approval",
    id: sha256(
      JSON.stringify([
        candidate.id,
        candidate.sourceObservationId,
        candidate.sha256,
        approvedBy,
        reason,
        approvedAtEpochMs,
      ]),
    ),
    repositoryId: candidate.repositoryId,
    canonicalWorktree: candidate.canonicalWorktree,
    harness: candidate.harness,
    updatedAtEpochMs: approvedAtEpochMs,
    candidateId: candidate.id,
    sourceObservationId: candidate.sourceObservationId,
    candidateSha256: candidate.sha256,
    approvedBy,
    reason,
  };
  validateLearningRecord(approval);
  options.store.save(approval);
  return structuredClone(approval);
}

export function serializeLearningState(records: readonly LearningStateRecord[]): string {
  if (records.length > LEARNING_LIMITS.maxRecords) {
    throw new Error("learning state exceeds its record limit");
  }
  records.forEach(validateLearningRecord);
  const sorted = [...records].sort(
    (left, right) =>
      left.updatedAtEpochMs - right.updatedAtEpochMs || left.id.localeCompare(right.id),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export interface ObservabilityRecord extends ScopedRecord {
  version: 1;
  sessionId: string;
  client: HookClient;
  event: (typeof OBSERVABILITY_EVENTS)[number];
  tool?: string;
  outcome?: "ok" | "failed";
  durationMs?: number;
  eventCount: 1;
}

export interface ObservabilityStore {
  list(): readonly ObservabilityRecord[];
  save(record: ObservabilityRecord): void;
  prune(beforeEpochMs: number): void;
}

function validateObservabilityRecord(record: ObservabilityRecord): void {
  validateBase(record, "personal-observability");
  const required = [
    "version",
    "id",
    "repositoryId",
    "canonicalWorktree",
    "harness",
    "updatedAtEpochMs",
    "sessionId",
    "client",
    "event",
    "eventCount",
  ];
  const optional = ["tool", "outcome", "durationMs"];
  const keys = Object.keys(record);
  if (
    required.some((field) => !keys.includes(field)) ||
    keys.some((field) => !required.includes(field) && !optional.includes(field)) ||
    !SHA256.test(record.sessionId) ||
    !["claude", "codex"].includes(record.client) ||
    !OBSERVABILITY_EVENTS.includes(record.event) ||
    record.eventCount !== 1
  ) {
    throw new Error("personal-observability record is malformed");
  }
  if (record.tool !== undefined) {
    safeText(record.tool, "personal-observability tool", OBSERVABILITY_LIMITS.maxToolCharacters);
  }
  if (record.outcome !== undefined && record.outcome !== "ok" && record.outcome !== "failed") {
    throw new Error("personal-observability outcome is malformed");
  }
  if (
    record.durationMs !== undefined &&
    (!Number.isSafeInteger(record.durationMs) ||
      record.durationMs < 0 ||
      record.durationMs > OBSERVABILITY_LIMITS.maxDurationMs)
  ) {
    throw new Error("personal-observability duration is malformed");
  }
}

export function createFileObservabilityStore(options: FileOptInStoreOptions): ObservabilityStore {
  return createScopedStore({
    ...options,
    namespace: "personal-observability",
    maxRecords: OBSERVABILITY_LIMITS.maxRecords,
    validate: validateObservabilityRecord,
  });
}

export interface PersonalObservabilityHandlerOptions {
  enabled: boolean;
  repositoryId: string;
  canonicalWorktree: string;
  harness: string;
  store: ObservabilityStore;
  now?: () => number;
}

export function createPersonalObservabilityHandler(
  options: PersonalObservabilityHandlerOptions,
): HookHandler {
  if (typeof options.enabled !== "boolean") {
    throw new Error("personal-observability opt-in must be explicit");
  }
  const repositoryId = safeText(options.repositoryId, "personal-observability repositoryId", 512);
  const canonicalWorktree = safeText(
    options.canonicalWorktree,
    "personal-observability canonicalWorktree",
    4_096,
  );
  const harness = safeText(options.harness, "personal-observability harness", 64);
  const now = options.now ?? Date.now;
  return {
    id: "personal-observability",
    events: OBSERVABILITY_EVENTS,
    enabled: options.enabled,
    order: 50,
    timeoutMs: 2_000,
    failurePolicy: "open",
    redactionPolicy: "sensitive-values",
    storagePolicy: "aih-state",
    run(event): HookHandlerDecision {
      if (!options.enabled) return { action: "continue" };
      if (!sameWorktree(event.cwd, canonicalWorktree)) {
        throw new Error("personal-observability event belongs to a foreign worktree");
      }
      const timestamp = safeEpoch(now(), "personal-observability clock");
      options.store.prune(Math.max(0, timestamp - OBSERVABILITY_LIMITS.retentionMs));
      const sessionId = sha256(event.sessionId);
      const tool = event.tool?.name
        ? sanitizedText(event.tool.name, OBSERVABILITY_LIMITS.maxToolCharacters)
        : undefined;
      const durationMs =
        event.durationMs !== undefined
          ? Math.min(event.durationMs, OBSERVABILITY_LIMITS.maxDurationMs)
          : undefined;
      const outcome =
        event.event === "after-tool"
          ? ("ok" as const)
          : event.event === "tool-failure"
            ? ("failed" as const)
            : undefined;
      const record: ObservabilityRecord = {
        version: 1,
        id: sha256(
          JSON.stringify([
            repositoryId,
            comparablePath(canonicalWorktree),
            harness,
            sessionId,
            event.client,
            event.event,
            timestamp,
            tool,
            outcome,
            durationMs,
          ]),
        ),
        repositoryId,
        canonicalWorktree,
        harness,
        updatedAtEpochMs: timestamp,
        sessionId,
        client: event.client,
        event: event.event as (typeof OBSERVABILITY_EVENTS)[number],
        eventCount: 1,
      };
      if (tool !== undefined) record.tool = tool;
      if (outcome !== undefined) record.outcome = outcome;
      if (durationMs !== undefined) record.durationMs = durationMs;
      validateObservabilityRecord(record);
      options.store.save(record);
      return { action: "continue" };
    },
  };
}

export const OPT_IN_ECC_HOOK_IDS = ["learning", "personal-observability"] as const;
export type OptInEccHookId = (typeof OPT_IN_ECC_HOOK_IDS)[number];

export function optInEccHookEvents(): Readonly<
  Record<OptInEccHookId, readonly LogicalHookEvent[]>
> {
  return {
    learning: LEARNING_EVENTS,
    "personal-observability": OBSERVABILITY_EVENTS,
  };
}
