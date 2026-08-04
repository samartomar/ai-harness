import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readRegularFile, retryTransient } from "../internals/fsxn.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { HookClient, JsonValue, NormalizedHookEvent } from "./hook-core.js";

export const TOKEN_SAVIOR_RUNTIME_PIN = {
  package: "token-savior-recall[mcp]==4.21.0",
  sourceCommit: "1e5984b452c5b98e6376a7250b3213f5c3500626",
  wheelSha256: "36529b132d658225ad6df7c9ec4ca0cbcf0fb48ebb0054099a0284c793fc9363",
  license: "MIT",
  import: "token_savior.compactors.compact",
} as const;

export const TOKEN_SAVIOR_LIMITS = {
  maxOriginalBytes: 1024 * 1024,
  maxCompactedBytes: 128 * 1024,
  maxRetentionRecords: 128,
  maxTimeoutMs: 10_000,
} as const;

/**
 * Versioned native transport qualification. Claude preserves a successful tool
 * result while replacing its model-visible bytes. Codex 0.145.0 exposes only
 * block feedback for PostToolUse replacement, so its transport is deliberately
 * experimental and must be re-probed before a client-version update.
 */
export const TOKEN_SAVIOR_NATIVE_TRANSPORTS = {
  claude: {
    qualifiedAtVersion: "2.1.220",
    status: "qualified",
    hook: "PostToolUse",
    behavior: "success-output-replacement",
    outputField: "hookSpecificOutput.updatedToolOutput",
  },
  codex: {
    qualifiedAtVersion: "0.145.0",
    status: "experimental-qualified",
    hook: "PostToolUse",
    behavior: "blocked-result-feedback-replacement",
    outputField: "decision:block/reason",
  },
} as const;

export const TOKEN_SAVIOR_COMPACTOR_BRIDGE = [
  "import json",
  "import sys",
  "from token_savior.compactors import compact",
  "payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
  "result = compact(payload['command'], payload['stdout'], payload.get('stderr', ''))",
  "if result is None:",
  "    output = None",
  "else:",
  "    output = {",
  "        'text': result.text,",
  "        'originalBytes': result.original_bytes,",
  "        'compactBytes': result.compact_bytes,",
  "        'savingsPercent': result.savings_pct,",
  "        'originalText': result.original_text,",
  "    }",
  "sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(',', ':')))",
].join("\n");

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command"]);

export interface TokenSaviorCompactInput {
  command: string;
  stdout: string;
  stderr: string;
}

export interface TokenSaviorCompactResult {
  text: string;
  originalBytes: number;
  compactBytes: number;
  savingsPercent: number;
  originalText: string;
}

export type TokenSaviorCompactor = (
  input: Readonly<TokenSaviorCompactInput>,
  signal: AbortSignal,
) => Promise<TokenSaviorCompactResult | null>;

interface ProcessCompactorOptions {
  pythonCommand: string;
  runtimeRoot: string;
  tempRoot: string;
  /** Digest independently verified by the acquisition boundary. */
  verifiedWheelSha256: string;
  /** Repository-owned subprocess seam; injectable for hermetic tests. */
  run?: Runner;
}

export interface TokenSaviorRetentionRecord {
  version: 1;
  client: HookClient;
  repositoryId: string;
  canonicalWorktree: string;
  sessionIdHash: string;
  toolUseIdHash: string;
  retainedAtEpochMs: number;
  package: typeof TOKEN_SAVIOR_RUNTIME_PIN.package;
  sourcePin: string;
  wheelSha256: typeof TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256;
  originalSha256: string;
  originalBytes: number;
  originalText: string;
  compactedSha256: string;
  compactedBytes: number;
  evidencePath: string;
}

export interface TokenSaviorRetentionStore {
  retain(record: Omit<TokenSaviorRetentionRecord, "evidencePath">): TokenSaviorRetentionRecord;
  list(): readonly TokenSaviorRetentionRecord[];
}

interface FileRetentionStoreOptions {
  stateRoot: string;
  canonicalWorktree: string;
  repositoryId: string;
  maxOriginalBytes?: number;
}

interface AdapterOptions {
  canonicalWorktree: string;
  repositoryId: string;
  store: TokenSaviorRetentionStore;
  compact: TokenSaviorCompactor;
  timeoutMs: number;
  now?: () => number;
}

export type TokenSaviorAdapterStatus =
  | "compacted"
  | "ineligible"
  | "no-match"
  | "failed-open"
  | "timed-out-open"
  | "retention-failed-open";

export interface TokenSaviorAdapterResult {
  status: TokenSaviorAdapterStatus;
  transport:
    | "claude-updated-tool-output"
    | "codex-post-tool-block-feedback-experimental"
    | "native-output-unchanged";
  qualification: (typeof TOKEN_SAVIOR_NATIVE_TRANSPORTS)[HookClient] | { status: "not-applied" };
  modelOutput: JsonValue;
  nativeOutput?: JsonValue;
  originalRetained: boolean;
  health: {
    package: typeof TOKEN_SAVIOR_RUNTIME_PIN.package;
    sourceCommit: typeof TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit;
    status: TokenSaviorAdapterStatus;
  };
}

export interface TokenSaviorCompactionAdapter {
  run(event: Readonly<NormalizedHookEvent>): Promise<TokenSaviorAdapterResult>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function existingDirectory(path: string, label: string): string {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label} must exist`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(path);
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameExistingDirectory(path: string, canonicalDirectory: string): boolean {
  try {
    const canonicalCandidate = existingDirectory(
      safeAbsolutePath(path, "Token Savior hook working directory"),
      "Token Savior hook working directory",
    );
    return comparablePath(canonicalCandidate) === comparablePath(canonicalDirectory);
  } catch {
    return false;
  }
}

function safeAbsolutePath(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (/\p{Cc}/u.test(path)) throw new Error(`${label} contains a control character`);
  const normalized = resolve(path);
  if (normalized !== path && comparablePath(normalized) !== comparablePath(path)) {
    throw new Error(`${label} must be normalized without traversal`);
  }
  return normalized;
}

function validPositiveInteger(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function regularExecutable(path: string, label: string): string {
  const safe = safeAbsolutePath(path, label);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(safe);
  } catch {
    throw new Error(`${label} must exist`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return realpathSync(safe);
}

export function createTokenSaviorProcessCompactor(
  options: ProcessCompactorOptions,
): TokenSaviorCompactor {
  const pythonCommand = safeAbsolutePath(options.pythonCommand, "Token Savior Python command");
  if (options.verifiedWheelSha256 !== TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256) {
    throw new Error("Token Savior wheel evidence does not match the reviewed pin");
  }
  const executable = regularExecutable(pythonCommand, "Token Savior Python command");
  const runtimeRoot = existingDirectory(
    safeAbsolutePath(options.runtimeRoot, "Token Savior runtime root"),
    "Token Savior runtime root",
  );
  const tempRoot = existingDirectory(
    safeAbsolutePath(options.tempRoot, "Token Savior temporary root"),
    "Token Savior temporary root",
  );
  if (!containsPath(runtimeRoot, executable)) {
    throw new Error("Token Savior Python command must be contained by its runtime root");
  }
  if (containsPath(runtimeRoot, tempRoot) || containsPath(tempRoot, runtimeRoot)) {
    throw new Error("Token Savior temporary root must be separate from its runtime root");
  }
  const run = options.run ?? defaultRunner;

  return async (input, signal) => {
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload, "utf8") > TOKEN_SAVIOR_LIMITS.maxOriginalBytes + 16 * 1024) {
      throw new Error("Token Savior compactor input exceeds its process limit");
    }
    if (signal.aborted) throw new Error("Token Savior compactor was aborted");
    const result = await run([executable, "-I", "-c", TOKEN_SAVIOR_COMPACTOR_BRIDGE], {
      cwd: tempRoot,
      env: {
        SYSTEMROOT: process.env.SYSTEMROOT,
        SystemRoot: process.env.SystemRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONNOUSERSITE: "1",
      },
      input: payload,
      signal,
      timeoutMs: TOKEN_SAVIOR_LIMITS.maxTimeoutMs,
      maxBufferBytes: TOKEN_SAVIOR_LIMITS.maxCompactedBytes + 16 * 1024,
    });
    if (signal.aborted) throw new Error("Token Savior compactor was aborted");
    if (result.truncated) {
      throw new Error("Token Savior compactor output exceeds its process limit");
    }
    if (result.spawnError) throw new Error("Token Savior compactor process could not start");
    if (result.code !== 0) throw new Error("Token Savior compactor process failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Token Savior compactor process returned malformed JSON");
    }
    if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error("Token Savior compactor process returned a malformed result");
    }
    return parsed as TokenSaviorCompactResult | null;
  };
}

function validateRetentionRecord(record: TokenSaviorRetentionRecord): void {
  if (
    record.version !== 1 ||
    !["claude", "codex"].includes(record.client) ||
    !SHA256.test(record.sessionIdHash) ||
    !SHA256.test(record.toolUseIdHash) ||
    !SHA256.test(record.originalSha256) ||
    !SHA256.test(record.compactedSha256) ||
    record.package !== TOKEN_SAVIOR_RUNTIME_PIN.package ||
    record.sourcePin !== TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit ||
    record.wheelSha256 !== TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256 ||
    !Number.isSafeInteger(record.retainedAtEpochMs) ||
    record.retainedAtEpochMs < 0 ||
    Buffer.byteLength(record.originalText, "utf8") !== record.originalBytes ||
    sha256(record.originalText) !== record.originalSha256 ||
    !Number.isSafeInteger(record.compactedBytes) ||
    record.compactedBytes < 1 ||
    record.compactedBytes > TOKEN_SAVIOR_LIMITS.maxCompactedBytes
  ) {
    throw new Error("Token Savior retention record is malformed");
  }
}

function retentionIdentity(record: TokenSaviorRetentionRecord, canonicalWorktree: string): string {
  return sha256(
    `${record.repositoryId}\0${canonicalWorktree}\0${record.client}\0${record.sessionIdHash}\0${record.toolUseIdHash}\0${record.originalSha256}\0${record.compactedSha256}`,
  );
}

export function createFileTokenSaviorRetentionStore(
  options: FileRetentionStoreOptions,
): TokenSaviorRetentionStore {
  const stateRoot = existingDirectory(
    safeAbsolutePath(options.stateRoot, "Token Savior state root"),
    "Token Savior state root",
  );
  const worktree = existingDirectory(
    safeAbsolutePath(options.canonicalWorktree, "canonical worktree"),
    "canonical worktree",
  );
  if (containsPath(worktree, stateRoot) || containsPath(stateRoot, worktree)) {
    throw new Error("Token Savior state root must be outside the canonical worktree");
  }
  if (typeof options.repositoryId !== "string" || options.repositoryId.length === 0) {
    throw new Error("Token Savior repository identity is required");
  }
  if (
    Buffer.byteLength(options.repositoryId, "utf8") > 512 ||
    /\p{Cc}/u.test(options.repositoryId)
  ) {
    throw new Error("Token Savior repository identity is unsafe");
  }
  const maxOriginalBytes = validPositiveInteger(
    options.maxOriginalBytes ?? TOKEN_SAVIOR_LIMITS.maxOriginalBytes,
    TOKEN_SAVIOR_LIMITS.maxOriginalBytes,
    "Token Savior original-output limit",
  );
  const directory = join(stateRoot, "token-savior");
  try {
    mkdirSync(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalDirectory = existingDirectory(directory, "Token Savior retention directory");
  if (!containsPath(stateRoot, canonicalDirectory)) {
    throw new Error("Token Savior retention directory escapes its state root");
  }

  const list = (): TokenSaviorRetentionRecord[] => {
    const names = readdirSync(canonicalDirectory).sort();
    if (names.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) {
      throw new Error("Token Savior retention directory contains an unexpected entry");
    }
    if (names.length > TOKEN_SAVIOR_LIMITS.maxRetentionRecords) {
      throw new Error("Token Savior retention record count exceeds its limit");
    }
    return names.map((name) => {
      const file = join(canonicalDirectory, name);
      const raw = readRegularFile(file, { maxBytes: maxOriginalBytes + 16 * 1024 });
      if (raw === undefined) throw new Error(`Token Savior retention evidence is unsafe: ${name}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error(`Token Savior retention evidence is malformed: ${name}`);
      }
      const record = { ...(parsed as TokenSaviorRetentionRecord), evidencePath: file };
      validateRetentionRecord(record);
      if (
        record.repositoryId !== options.repositoryId ||
        comparablePath(record.canonicalWorktree) !== comparablePath(worktree)
      ) {
        throw new Error("Token Savior retention evidence conflicts with its store scope");
      }
      if (name !== `${retentionIdentity(record, worktree)}.json`) {
        throw new Error("Token Savior retention evidence conflicts with its content identity");
      }
      return record;
    });
  };

  return {
    list,
    retain(input) {
      const record: TokenSaviorRetentionRecord = { ...input, evidencePath: "" };
      validateRetentionRecord(record);
      if (
        record.repositoryId !== options.repositoryId ||
        comparablePath(record.canonicalWorktree) !== comparablePath(worktree)
      ) {
        throw new Error("Token Savior retention record conflicts with its store scope");
      }
      if (record.originalBytes > maxOriginalBytes) {
        throw new Error("Token Savior original output exceeds its retention limit");
      }
      const identity = retentionIdentity(record, worktree);
      const file = join(canonicalDirectory, `${identity}.json`);
      const existing = list();
      const duplicate = existing.find(
        (candidate) => comparablePath(candidate.evidencePath) === comparablePath(file),
      );
      if (duplicate !== undefined) return duplicate;
      if (existing.length >= TOKEN_SAVIOR_LIMITS.maxRetentionRecords) {
        throw new Error("Token Savior retention record count exceeds its limit");
      }
      const persisted = { ...record };
      delete (persisted as Partial<TokenSaviorRetentionRecord>).evidencePath;
      const body = `${JSON.stringify(persisted, null, 2)}\n`;
      const temp = join(dirname(file), `.${identity}.${process.pid}.tmp`);
      try {
        retryTransient(() =>
          writeFileSync(temp, body, { encoding: "utf8", flag: "wx", mode: 0o600 }),
        );
        retryTransient(() => renameSync(temp, file));
      } finally {
        try {
          rmSync(temp);
        } catch {
          // A successful atomic rename removes the temporary path.
        }
      }
      return { ...record, evidencePath: file };
    },
  };
}

function shellParts(event: Readonly<NormalizedHookEvent>): TokenSaviorCompactInput | undefined {
  if (
    event.event !== "after-tool" ||
    comparablePath(event.cwd) === "" ||
    !event.tool ||
    !SHELL_TOOLS.has(event.tool.name.toLowerCase()) ||
    !event.tool.input ||
    typeof event.tool.input !== "object" ||
    Array.isArray(event.tool.input) ||
    typeof event.tool.input.command !== "string" ||
    event.tool.response === undefined
  ) {
    return undefined;
  }
  if (event.client === "codex" && typeof event.tool.response === "string") {
    return { command: event.tool.input.command, stdout: event.tool.response, stderr: "" };
  }
  if (
    event.client === "claude" &&
    event.tool.response !== null &&
    typeof event.tool.response === "object" &&
    !Array.isArray(event.tool.response) &&
    typeof event.tool.response.stdout === "string" &&
    typeof event.tool.response.stderr === "string"
  ) {
    return {
      command: event.tool.input.command,
      stdout: event.tool.response.stdout,
      stderr: event.tool.response.stderr,
    };
  }
  return undefined;
}

function validateCompactResult(
  result: TokenSaviorCompactResult,
  input: TokenSaviorCompactInput,
): void {
  const originalText = `${input.stdout}${input.stderr}`;
  const originalBytes = Buffer.byteLength(originalText, "utf8");
  const compactBytes = Buffer.byteLength(result.text, "utf8");
  const expectedSavings = 100 * (1 - compactBytes / Math.max(1, originalBytes));
  if (
    typeof result.text !== "string" ||
    result.text.trim() === "" ||
    compactBytes > TOKEN_SAVIOR_LIMITS.maxCompactedBytes ||
    result.originalText !== originalText ||
    result.originalBytes !== originalBytes ||
    result.compactBytes !== compactBytes ||
    !Number.isFinite(result.savingsPercent) ||
    Math.abs(result.savingsPercent - expectedSavings) > 0.001 ||
    compactBytes >= originalBytes
  ) {
    throw new Error("Token Savior returned a malformed compaction result");
  }
}

function unchanged(
  status: Exclude<TokenSaviorAdapterStatus, "compacted">,
  original: JsonValue,
): TokenSaviorAdapterResult {
  return {
    status,
    transport: "native-output-unchanged",
    qualification: { status: "not-applied" },
    modelOutput: structuredClone(original),
    originalRetained: false,
    health: {
      package: TOKEN_SAVIOR_RUNTIME_PIN.package,
      sourceCommit: TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit,
      status,
    },
  };
}

export function createTokenSaviorCompactionAdapter(
  options: AdapterOptions,
): TokenSaviorCompactionAdapter {
  const worktree = existingDirectory(
    safeAbsolutePath(options.canonicalWorktree, "canonical worktree"),
    "canonical worktree",
  );
  const timeoutMs = validPositiveInteger(
    options.timeoutMs,
    TOKEN_SAVIOR_LIMITS.maxTimeoutMs,
    "Token Savior compaction timeout",
  );
  const now = options.now ?? Date.now;
  if (
    typeof options.repositoryId !== "string" ||
    options.repositoryId.length === 0 ||
    Buffer.byteLength(options.repositoryId, "utf8") > 512 ||
    /\p{Cc}/u.test(options.repositoryId)
  ) {
    throw new Error("Token Savior repository identity is unsafe");
  }
  if (typeof options.compact !== "function") throw new Error("Token Savior compactor is required");

  return {
    async run(event) {
      const original = event.tool?.response ?? null;
      if (!sameExistingDirectory(event.cwd, worktree)) return unchanged("ineligible", original);
      const input = shellParts(event);
      if (!input || !event.tool?.id) return unchanged("ineligible", original);
      if (
        Buffer.byteLength(`${input.stdout}${input.stderr}`, "utf8") >
        TOKEN_SAVIOR_LIMITS.maxOriginalBytes
      ) {
        return unchanged("failed-open", original);
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: "timeout" }>((resolveTimeout) => {
        timer = setTimeout(() => {
          resolveTimeout({ kind: "timeout" });
          controller.abort();
        }, timeoutMs);
        timer.unref?.();
      });
      const work = Promise.resolve()
        .then(() => options.compact(structuredClone(input), controller.signal))
        .then(
          (result) => ({ kind: "result" as const, result }),
          () => ({ kind: "failed" as const }),
        );
      const outcome = await Promise.race([work, timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome.kind === "timeout") return unchanged("timed-out-open", original);
      if (outcome.kind === "failed") return unchanged("failed-open", original);
      if (outcome.result === null) return unchanged("no-match", original);
      try {
        validateCompactResult(outcome.result, input);
      } catch {
        return unchanged("failed-open", original);
      }
      try {
        const retainedAtEpochMs = now();
        if (!Number.isSafeInteger(retainedAtEpochMs) || retainedAtEpochMs < 0) {
          throw new Error("Token Savior clock is invalid");
        }
        options.store.retain({
          version: 1,
          client: event.client,
          repositoryId: options.repositoryId,
          canonicalWorktree: worktree,
          sessionIdHash: sha256(event.sessionId),
          toolUseIdHash: sha256(event.tool.id),
          retainedAtEpochMs,
          package: TOKEN_SAVIOR_RUNTIME_PIN.package,
          sourcePin: TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit,
          wheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
          originalSha256: sha256(outcome.result.originalText),
          originalBytes: outcome.result.originalBytes,
          originalText: outcome.result.originalText,
          compactedSha256: sha256(outcome.result.text),
          compactedBytes: outcome.result.compactBytes,
        });
      } catch {
        return unchanged("retention-failed-open", original);
      }

      const nativeOutput: JsonValue =
        event.client === "claude"
          ? {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                updatedToolOutput: {
                  ...(event.tool.response as Record<string, JsonValue>),
                  stdout: outcome.result.text,
                  stderr: "",
                },
              },
            }
          : { decision: "block", reason: outcome.result.text };
      return {
        status: "compacted",
        transport:
          event.client === "claude"
            ? "claude-updated-tool-output"
            : "codex-post-tool-block-feedback-experimental",
        qualification: TOKEN_SAVIOR_NATIVE_TRANSPORTS[event.client],
        modelOutput: outcome.result.text,
        nativeOutput,
        originalRetained: true,
        health: {
          package: TOKEN_SAVIOR_RUNTIME_PIN.package,
          sourceCommit: TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit,
          status: "compacted",
        },
      };
    },
  };
}

interface AuditProjectionInput {
  client: HookClient;
  enabled: boolean;
  explicitConsent?: { id: string; sha256: string };
  canonicalWorktree: string;
  stateRoot: string;
  transcriptRoot: string;
  wrapperCommand: string;
  wrapperSha256: string;
}

export interface TokenSaviorAuditProjection {
  client: "claude";
  activation: "prepared-not-registered";
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  allowedTools: readonly ["ts_discover"];
  resources: readonly [];
  provenance: {
    package: typeof TOKEN_SAVIOR_RUNTIME_PIN.package;
    sourceCommit: typeof TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit;
    wheelSha256: typeof TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256;
    wrapperSha256: string;
    consentId: string;
    consentSha256: string;
  };
}

export function buildTokenSaviorAuditProjection(
  input: AuditProjectionInput,
): TokenSaviorAuditProjection {
  if (!input.enabled) throw new Error("Token Savior audit MCP is not enabled");
  if (input.client !== "claude") throw new Error("Token Savior audit MCP is Claude-only");
  if (
    !input.explicitConsent ||
    !SAFE_ID.test(input.explicitConsent.id) ||
    !SHA256.test(input.explicitConsent.sha256)
  ) {
    throw new Error("Token Savior audit MCP requires valid explicit consent evidence");
  }
  const worktree = existingDirectory(
    safeAbsolutePath(input.canonicalWorktree, "canonical worktree"),
    "canonical worktree",
  );
  const stateRoot = existingDirectory(
    safeAbsolutePath(input.stateRoot, "Token Savior state root"),
    "Token Savior state root",
  );
  const transcriptRoot = existingDirectory(
    safeAbsolutePath(input.transcriptRoot, "Token Savior transcript root"),
    "Token Savior transcript root",
  );
  if (
    containsPath(worktree, stateRoot) ||
    containsPath(worktree, transcriptRoot) ||
    containsPath(stateRoot, worktree) ||
    containsPath(transcriptRoot, worktree)
  ) {
    throw new Error("Token Savior audit roots must remain outside the canonical worktree");
  }
  const command = regularExecutable(input.wrapperCommand, "Token Savior wrapper command");
  if (containsPath(worktree, command)) {
    throw new Error("Token Savior wrapper command must remain outside the canonical worktree");
  }
  if (!SHA256.test(input.wrapperSha256)) throw new Error("Token Savior wrapper SHA-256 is invalid");

  return {
    client: "claude",
    activation: "prepared-not-registered",
    command,
    args: ["token-savior-audit", "--package", TOKEN_SAVIOR_RUNTIME_PIN.package],
    env: {
      TOKEN_SAVIOR_PROFILE: "compact-only",
      TOKEN_SAVIOR_NO_WARMUP: "1",
      TS_CAPTURE_DISABLED: "1",
      TS_MEMORY_DISABLE: "1",
      TS_RESOURCES_DISABLED: "1",
      TS_THIN_SCHEMAS: "1",
      PROJECT_ROOT: worktree,
      TOKEN_SAVIOR_DATA_DIR: stateRoot,
      TS_STATE_ROOT: stateRoot,
      TS_TRANSCRIPT_ROOT: transcriptRoot,
    },
    allowedTools: ["ts_discover"],
    resources: [],
    provenance: {
      package: TOKEN_SAVIOR_RUNTIME_PIN.package,
      sourceCommit: TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit,
      wheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      wrapperSha256: input.wrapperSha256,
      consentId: input.explicitConsent.id,
      consentSha256: input.explicitConsent.sha256,
    },
  };
}

export function guardTokenSaviorAuditCall(tool: string, _arguments: JsonValue): void {
  if (tool !== "ts_discover") throw new Error(`Token Savior audit tool is not allowed: ${tool}`);
}

interface TokenSaviorAuditToolDescription {
  name: string;
  [key: string]: unknown;
}

export type TokenSaviorAuditMcpRequestDecision =
  | { forward: true }
  | {
      forward: false;
      response:
        | {
            jsonrpc: "2.0";
            id: string | number | null;
            result: { resources: [] };
          }
        | {
            jsonrpc: "2.0";
            id: string | number | null;
            error: { code: -32601; message: string };
          };
    };

function tokenSaviorAuditRequestId(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number" || value === null) return value;
  throw new Error("malformed Token Savior audit request id");
}

/** Hard JSON-RPC surface enforced by the later managed audit-MCP wrapper. */
export class TokenSaviorAuditMcpPolicyGuard {
  inspectClientRequest(value: unknown): TokenSaviorAuditMcpRequestDecision {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("malformed Token Savior audit JSON-RPC request");
    }
    const request = value as Record<string, unknown>;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      throw new Error("malformed Token Savior audit JSON-RPC request");
    }
    if (request.method === "resources/list") {
      return {
        forward: false,
        response: {
          jsonrpc: "2.0",
          id: tokenSaviorAuditRequestId(request.id),
          result: { resources: [] },
        },
      };
    }
    if (
      [
        "initialize",
        "notifications/initialized",
        "notifications/cancelled",
        "ping",
        "tools/list",
      ].includes(request.method)
    ) {
      return { forward: true };
    }
    if (request.method !== "tools/call") {
      if (!("id" in request)) {
        throw new Error(`Token Savior audit method '${request.method}' is disabled`);
      }
      return {
        forward: false,
        response: {
          jsonrpc: "2.0",
          id: tokenSaviorAuditRequestId(request.id),
          error: {
            code: -32601,
            message: `Token Savior audit method '${request.method}' is disabled by the AIH ECC profile`,
          },
        },
      };
    }
    const params = request.params;
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof (params as { name?: unknown }).name !== "string"
    ) {
      throw new Error("malformed Token Savior audit tools/call request");
    }
    const id = tokenSaviorAuditRequestId(request.id);
    const name = (params as { name: string }).name;
    if (name === "ts_discover") return { forward: true };
    return {
      forward: false,
      response: {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Token Savior audit tool '${name}' is disabled by the AIH ECC profile`,
        },
      },
    };
  }

  filterToolsList(value: unknown): { tools: TokenSaviorAuditToolDescription[] } {
    if (
      value === null ||
      typeof value !== "object" ||
      !Array.isArray((value as { tools?: unknown }).tools)
    ) {
      throw new Error("Token Savior audit tools/list response is malformed");
    }
    const tools = (value as { tools: unknown[] }).tools;
    let discover: TokenSaviorAuditToolDescription | undefined;
    const names = new Set<string>();
    for (const tool of tools) {
      if (
        tool === null ||
        typeof tool !== "object" ||
        typeof (tool as { name?: unknown }).name !== "string"
      ) {
        throw new Error("Token Savior audit tools/list contains a malformed tool");
      }
      const typed = tool as TokenSaviorAuditToolDescription;
      if (names.has(typed.name)) {
        throw new Error(`Token Savior audit tools/list contains duplicate '${typed.name}'`);
      }
      names.add(typed.name);
      if (typed.name === "ts_discover") discover = typed;
    }
    if (discover === undefined) {
      throw new Error("Token Savior audit tools/list is missing reviewed tool: ts_discover");
    }
    return { tools: [discover] };
  }
}
