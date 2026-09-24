import { createHash, randomBytes } from "node:crypto";
import {
  type BigIntStats,
  lstatSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import { prepareOwnedStateDirectory } from "../ecc-profile/native-runtime.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import {
  type DefaultNativeRuntimeLayout,
  defaultNativeRuntimeLayout,
} from "../mcp/default-native-runtime.js";
import {
  type DeveloperToolId,
  isPrimaryCodeGraphId,
  type PrimaryCodeGraphId,
} from "./default-tool-selection.js";
import type {
  DeveloperToolLifecycleResult,
  DeveloperToolLifecycleState,
  DeveloperToolReconcileInput,
} from "./developer-tools-command.js";
import {
  createDefaultDeveloperToolRuntimeOperations,
  type DeveloperToolProductionDeps,
} from "./developer-tools-operations.js";

const RECEIPT_VERSION = "aih-developer-tools-receipt/v1" as const;
const MAX_RECEIPT_BYTES = 512 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_TOOL_IDS = [
  "code-review-graph",
  "codebase-memory-mcp",
  "serena",
  "context7",
  "markitdown",
  "playwright",
] as const;
type ReceiptToolId = (typeof RECEIPT_TOOL_IDS)[number];

export interface DeveloperToolOwnedPath {
  readonly path: string;
  readonly sha256: string;
  readonly ownership: "file";
}

export interface DeveloperToolRuntimeOperationResult {
  readonly state: Exclude<DeveloperToolLifecycleState, "selected-pending">;
  readonly detail: string;
  readonly sourceDigest: string;
  readonly ownedPaths: readonly DeveloperToolOwnedPath[];
  readonly changed: boolean;
}

export interface DeveloperToolRuntimeOperationInput extends DeveloperToolReconcileInput {
  readonly layout: DefaultNativeRuntimeLayout;
  readonly previous?: DeveloperToolReceiptEntry;
}

export type DeveloperToolRuntimeOperation = (
  input: DeveloperToolRuntimeOperationInput,
) => Promise<DeveloperToolRuntimeOperationResult>;

export interface DeveloperToolRuntimeDeps {
  /** Low-level production operations; focused tests replace only acquisition/execution here. */
  readonly operations?: Partial<Record<DeveloperToolId, DeveloperToolRuntimeOperation>>;
  /** Narrow production seams for acquisition, subprocess, and HTTPS acceptance tests. */
  readonly production?: DeveloperToolProductionDeps;
}

export interface DeveloperToolReceiptEntry {
  readonly sourceDigest: string;
  readonly ownedPaths: readonly DeveloperToolOwnedPath[];
}

/** The effective primary code graph at the last apply and who chose it. */
export interface PrimaryCodeGraphRecord {
  readonly id: PrimaryCodeGraphId;
  readonly source: "policy" | "user";
}

export interface DeveloperToolsRuntimeReceipt {
  readonly version: typeof RECEIPT_VERSION;
  readonly canonicalRoot: string;
  /** Optional: absent when no primary code graph has been chosen. */
  readonly primaryCodeGraph?: PrimaryCodeGraphRecord;
  readonly tools: Partial<Record<ReceiptToolId, DeveloperToolReceiptEntry>>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function contained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function assertRuntimeLayoutBoundary(layout: DefaultNativeRuntimeLayout): void {
  const mutableRoots = [
    ["developer-tool project state", layout.projectStateRoot],
    ["developer-tool uv cache", layout.uvCache],
    ["Codebase Memory payload", layout.memoryPayloadRoot],
    ["Token Optimizer install cache", layout.tokenOptimizerRoot],
  ] as const;
  for (const [label, root] of mutableRoots) {
    if (contained(layout.project, root) || contained(root, layout.project)) {
      throw new Error(`${label} must remain outside and disjoint from the project`);
    }
  }
  for (let left = 0; left < mutableRoots.length; left += 1) {
    for (let right = left + 1; right < mutableRoots.length; right += 1) {
      const a = mutableRoots[left];
      const b = mutableRoots[right];
      if (a === undefined || b === undefined) continue;
      if (contained(a[1], b[1]) || contained(b[1], a[1])) {
        throw new Error(`${a[0]} and ${b[0]} must be disjoint`);
      }
    }
  }
}

function ownershipRoot(layout: DefaultNativeRuntimeLayout, id: ReceiptToolId): string {
  switch (id) {
    case "code-review-graph":
      return layout.graphStateRoot;
    case "codebase-memory-mcp":
      return layout.memoryStateRoot;
    case "serena":
      return layout.serenaStateRoot;
    case "context7":
    case "markitdown":
    case "playwright":
      return layout.projectStateRoot;
  }
}

function pathIdentity(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function supportedOwnedPath(
  layout: DefaultNativeRuntimeLayout,
  id: ReceiptToolId,
): string | undefined {
  return id === "serena" ? resolve(layout.serenaStateRoot, "serena_config.yml") : undefined;
}

function parseOwnedPath(
  value: unknown,
  id: ReceiptToolId,
  layout: DefaultNativeRuntimeLayout,
): DeveloperToolOwnedPath {
  const path = object(value, `${id} owned path`);
  exactKeys(path, ["path", "sha256", "ownership"], `${id} owned path`);
  if (
    typeof path.path !== "string" ||
    !isAbsolute(path.path) ||
    typeof path.sha256 !== "string" ||
    !SHA256.test(path.sha256) ||
    path.ownership !== "file"
  ) {
    throw new Error(`${id} ownership receipt path is invalid`);
  }
  const resolved = resolve(path.path);
  if (!contained(resolve(ownershipRoot(layout, id)), resolved)) {
    throw new Error(`${id} ownership receipt path escapes its project state root`);
  }
  const supported = supportedOwnedPath(layout, id);
  if (supported === undefined) throw new Error(`${id} does not support receipt-owned files`);
  if (pathIdentity(resolved) !== pathIdentity(supported)) {
    throw new Error(`${id} ownership receipt path is not a supported generated artifact`);
  }
  return { path: resolved, sha256: path.sha256, ownership: "file" };
}

function parsePrimaryCodeGraph(value: unknown): PrimaryCodeGraphRecord {
  const record = object(value, "developer-tool primary code graph");
  exactKeys(record, ["id", "source"], "developer-tool primary code graph");
  if (
    !isPrimaryCodeGraphId(record.id) ||
    (record.source !== "policy" && record.source !== "user")
  ) {
    throw new Error("developer-tool primary code graph record is invalid");
  }
  return { id: record.id, source: record.source };
}

function parseReceipt(
  value: unknown,
  layout: DefaultNativeRuntimeLayout,
): DeveloperToolsRuntimeReceipt {
  const receipt = object(value, "developer-tool runtime receipt");
  const hasPrimary = Object.hasOwn(receipt, "primaryCodeGraph");
  exactKeys(
    receipt,
    ["version", "canonicalRoot", "tools", ...(hasPrimary ? ["primaryCodeGraph"] : [])],
    "developer-tool runtime receipt",
  );
  if (receipt.version !== RECEIPT_VERSION || receipt.canonicalRoot !== layout.project) {
    throw new Error("developer-tool runtime receipt does not belong to this canonical worktree");
  }
  const primaryCodeGraph = hasPrimary ? parsePrimaryCodeGraph(receipt.primaryCodeGraph) : undefined;
  const tools = object(receipt.tools, "developer-tool runtime receipt tools");
  for (const id of Object.keys(tools)) {
    if (!(RECEIPT_TOOL_IDS as readonly string[]).includes(id)) {
      throw new Error("developer-tool runtime receipt contains an unsupported tool");
    }
  }
  const parsedTools: DeveloperToolsRuntimeReceipt["tools"] = {};
  for (const id of RECEIPT_TOOL_IDS) {
    const raw = tools[id];
    if (raw === undefined) continue;
    const entry = object(raw, `${id} receipt`);
    exactKeys(entry, ["sourceDigest", "ownedPaths"], `${id} receipt`);
    if (typeof entry.sourceDigest !== "string" || !SHA256.test(entry.sourceDigest)) {
      throw new Error(`${id} receipt source digest is invalid`);
    }
    if (!Array.isArray(entry.ownedPaths)) throw new Error(`${id} receipt ownedPaths is invalid`);
    const ownedPaths = entry.ownedPaths.map((item) => parseOwnedPath(item, id, layout));
    const normalized = new Set(ownedPaths.map((item) => pathIdentity(item.path)));
    if (normalized.size !== ownedPaths.length) {
      throw new Error(`${id} receipt contains duplicate owned paths`);
    }
    parsedTools[id] = { sourceDigest: entry.sourceDigest, ownedPaths };
  }
  return {
    version: RECEIPT_VERSION,
    canonicalRoot: layout.project,
    ...(primaryCodeGraph === undefined ? {} : { primaryCodeGraph }),
    tools: parsedTools,
  };
}

function sha256(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function readReceipt(layout: DefaultNativeRuntimeLayout): {
  receipt: DeveloperToolsRuntimeReceipt;
  sha256?: string;
} {
  const opened = readRegularFileWithStats(layout.runtimeReceiptPath, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if (opened === undefined) {
    try {
      lstatSync(layout.runtimeReceiptPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          receipt: { version: RECEIPT_VERSION, canonicalRoot: layout.project, tools: {} },
        };
      }
      throw error;
    }
    throw new Error("developer-tool runtime receipt is not a safe regular file");
  }
  if (opened.stats.nlink !== 1) {
    throw new Error("developer-tool runtime receipt must be an unambiguous regular file");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(opened.contents);
  } catch {
    throw new Error("developer-tool runtime receipt is not valid UTF-8");
  }
  const parsed = parseNativeStrictJsonObjectV1(text, "developer-tool runtime receipt");
  return { receipt: parseReceipt(parsed, layout), sha256: sha256(opened.contents) };
}

function stableReceipt(receipt: DeveloperToolsRuntimeReceipt): string {
  const tools = Object.fromEntries(
    RECEIPT_TOOL_IDS.flatMap((id) => {
      const entry = receipt.tools[id];
      return entry === undefined ? [] : [[id, entry]];
    }),
  );
  return `${JSON.stringify(
    {
      version: RECEIPT_VERSION,
      canonicalRoot: receipt.canonicalRoot,
      ...(receipt.primaryCodeGraph === undefined
        ? {}
        : { primaryCodeGraph: receipt.primaryCodeGraph }),
      tools,
    },
    null,
    2,
  )}\n`;
}

/** The recorded primary code graph, validating the whole receipt first. */
export function readDeveloperToolPrimaryCodeGraph(
  layout: DefaultNativeRuntimeLayout,
): PrimaryCodeGraphRecord | undefined {
  return readReceipt(layout).receipt.primaryCodeGraph;
}

/**
 * Record (or clear) the primary code graph with the receipt's compare-and-swap
 * write. Returns false when the stored record already matches.
 */
export function recordDeveloperToolPrimaryCodeGraph(
  layout: DefaultNativeRuntimeLayout,
  record: PrimaryCodeGraphRecord | undefined,
): boolean {
  const { receipt, sha256: expected } = readReceipt(layout);
  const current = receipt.primaryCodeGraph;
  if (current?.id === record?.id && current?.source === record?.source) return false;
  const { primaryCodeGraph: _previous, ...rest } = receipt;
  const next: DeveloperToolsRuntimeReceipt =
    record === undefined ? rest : { ...rest, primaryCodeGraph: record };
  const contents = stableReceipt(next);
  const parent = prepareOwnedStateDirectory(
    dirname(layout.runtimeReceiptPath),
    "developer-tool receipt directory",
  );
  const onDisk = readRegularFileWithStats(layout.runtimeReceiptPath, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if ((onDisk === undefined ? undefined : sha256(onDisk.contents)) !== expected) {
    throw new Error(
      "developer-tool runtime receipt changed while recording the primary code graph",
    );
  }
  const temporary = resolve(
    parent,
    `.developer-tools-receipt.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    retryTransient(() => renameSync(temporary, layout.runtimeReceiptPath));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed or already absent.
    }
  }
  return true;
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.nlink === right.nlink
  );
}

interface OwnedPathAncestor {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

function ownedPathAncestry(path: string): readonly OwnedPathAncestor[] | undefined {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const segments = relative(root, parent)
    .split(/[\\/]+/u)
    .filter(Boolean);
  const ancestry: OwnedPathAncestor[] = [];
  let cursor = root;
  for (const segment of ["", ...segments]) {
    if (segment.length > 0) cursor = resolve(cursor, segment);
    const stats = lstatSync(cursor, { bigint: true, throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`receipt-owned path has a non-directory or linked ancestor: ${path}`);
    }
    ancestry.push({ path: cursor, dev: stats.dev, ino: stats.ino });
  }
  return ancestry;
}

function assertSameOwnedPathAncestry(path: string, ancestry: readonly OwnedPathAncestor[]): void {
  for (const expected of ancestry) {
    const current: BigIntStats | undefined = lstatSync(expected.path, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      current === undefined ||
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    ) {
      throw new Error(`receipt-owned path ancestry changed while reconciling: ${path}`);
    }
  }
}

function currentOwnedFile(
  path: DeveloperToolOwnedPath,
): { absent: true } | { absent: false; stats: Stats; ancestry: readonly OwnedPathAncestor[] } {
  const ancestry = ownedPathAncestry(path.path);
  if (ancestry === undefined) return { absent: true };
  const opened = readRegularFileWithStats(path.path, { maxBytes: 512 * 1024 * 1024 });
  if (opened === undefined) {
    try {
      lstatSync(path.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
      throw error;
    }
    throw new Error(`receipt-owned path is not a safe regular file: ${path.path}`);
  }
  if (opened.stats.nlink !== 1) {
    throw new Error(`receipt-owned path is not an unambiguous regular file: ${path.path}`);
  }
  if (sha256(opened.contents) !== path.sha256) {
    throw new Error(`receipt-owned path changed since the ownership receipt: ${path.path}`);
  }
  return { absent: false, stats: opened.stats, ancestry };
}

function cleanupOwnedPaths(
  paths: readonly DeveloperToolOwnedPath[],
  keep: ReadonlySet<string> = new Set(),
): boolean {
  let changed = false;
  for (const owned of paths) {
    if (keep.has(owned.path.toLowerCase())) continue;
    const current = currentOwnedFile(owned);
    if (current.absent) continue;
    assertSameOwnedPathAncestry(owned.path, current.ancestry);
    const after = lstatSync(owned.path);
    if (!sameSnapshot(current.stats, after)) {
      throw new Error(`receipt-owned path changed while reconciling: ${owned.path}`);
    }
    unlinkSync(owned.path);
    changed = true;
  }
  return changed;
}

function validateOperationEntry(
  id: ReceiptToolId,
  result: DeveloperToolRuntimeOperationResult,
  layout: DefaultNativeRuntimeLayout,
): DeveloperToolReceiptEntry {
  if (!SHA256.test(result.sourceDigest)) {
    throw new Error(`${id} operation returned an invalid source digest`);
  }
  const ownedPaths = result.ownedPaths.map((path) => parseOwnedPath(path, id, layout));
  for (const path of ownedPaths) currentOwnedFile(path);
  return { sourceDigest: result.sourceDigest, ownedPaths };
}

function defaultUnavailableOperation(id: DeveloperToolId): DeveloperToolRuntimeOperation {
  return async () => ({
    state: "blocked",
    detail: `${id} production operation is unavailable`,
    sourceDigest: sha256(`unavailable:${id}`),
    ownedPaths: [],
    changed: false,
  });
}

/**
 * Build one root-bound reconciler. The receipt is authenticated before the
 * first operation, so malformed or foreign ownership cannot cause partial work.
 */
export function createDeveloperToolReconciler(
  ctx: PlanContext,
  deps: DeveloperToolRuntimeDeps = {},
): (input: DeveloperToolReconcileInput) => Promise<DeveloperToolLifecycleResult> {
  const layout = defaultNativeRuntimeLayout(ctx);
  assertRuntimeLayoutBoundary(layout);
  const projectStateRoot = prepareOwnedStateDirectory(
    layout.projectStateRoot,
    "developer-tool project state root",
  );
  if (contained(layout.project, projectStateRoot) || contained(projectStateRoot, layout.project)) {
    throw new Error("developer-tool project state must remain outside the project");
  }
  let { receipt, sha256: receiptSha256 } = readReceipt(layout);
  const defaultOperations = createDefaultDeveloperToolRuntimeOperations(ctx, deps.production);

  const saveReceipt = (): boolean => {
    const contents = stableReceipt(receipt);
    const current = readRegularFileWithStats(layout.runtimeReceiptPath, {
      maxBytes: MAX_RECEIPT_BYTES,
    });
    const currentSha = current === undefined ? undefined : sha256(current.contents);
    if (currentSha !== receiptSha256) {
      throw new Error("developer-tool runtime receipt changed during reconciliation");
    }
    if (current !== undefined && current.contents.toString("utf8") === contents) return false;
    const parent = prepareOwnedStateDirectory(
      dirname(layout.runtimeReceiptPath),
      "developer-tool receipt directory",
    );
    const temporary = resolve(
      parent,
      `.developer-tools-receipt.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      retryTransient(() => renameSync(temporary, layout.runtimeReceiptPath));
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Renamed or already absent.
      }
    }
    receiptSha256 = sha256(contents);
    return true;
  };

  return async (input) => {
    if (input.ctx.root !== ctx.root || input.ctx.env !== ctx.env) {
      throw new Error("developer-tool reconciler context changed");
    }
    const id = input.id;
    const operation =
      deps.operations?.[id] ??
      (id === "headroom" ? defaultUnavailableOperation(id) : defaultOperations[id]);

    // Token Optimizer owns its independent receipt and removal contract.
    if (id === "token-optimizer") {
      const result = await operation({ ...input, layout });
      if (!input.selected && result.state !== "policy-excluded" && result.state !== "blocked") {
        throw new Error("token-optimizer exclusion did not report policy-excluded");
      }
      return { id, state: result.state, detail: result.detail, changed: result.changed };
    }

    const receiptId = id as ReceiptToolId;
    const previous = receipt.tools[receiptId];
    if (!input.selected) {
      const removed = previous === undefined ? false : cleanupOwnedPaths(previous.ownedPaths);
      if (previous !== undefined) {
        const tools = { ...receipt.tools };
        delete tools[receiptId];
        receipt = { ...receipt, tools };
      }
      const receiptChanged = previous === undefined ? false : saveReceipt();
      return {
        id,
        state: "policy-excluded",
        detail:
          previous === undefined
            ? "not selected by the effective developer-tool policy"
            : "unchanged receipt-owned integration was ceased; shared runtime and project data were preserved",
        changed: removed || receiptChanged,
      };
    }

    const result = await operation({
      ...input,
      layout,
      ...(previous === undefined ? {} : { previous }),
    });
    if (result.state === "blocked") {
      return { id, state: result.state, detail: result.detail, changed: result.changed };
    }
    if (result.state === "policy-excluded") {
      const removed = previous === undefined ? false : cleanupOwnedPaths(previous.ownedPaths);
      if (previous !== undefined) {
        const tools = { ...receipt.tools };
        delete tools[receiptId];
        receipt = { ...receipt, tools };
      }
      const receiptChanged = previous === undefined ? false : saveReceipt();
      return {
        id,
        state: "policy-excluded",
        detail: result.detail,
        changed: result.changed || removed || receiptChanged,
      };
    }
    const next = validateOperationEntry(receiptId, result, layout);
    const keep = new Set(next.ownedPaths.map((path) => path.path.toLowerCase()));
    const removed = previous === undefined ? false : cleanupOwnedPaths(previous.ownedPaths, keep);
    receipt = { ...receipt, tools: { ...receipt.tools, [receiptId]: next } };
    const receiptChanged = saveReceipt();
    return {
      id,
      state: result.state,
      detail: result.detail,
      changed: result.changed || removed || receiptChanged,
    };
  };
}
