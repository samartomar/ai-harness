import process from "node:process";
import type { Cli } from "../internals/clis.js";
import { type ExecAction, exec, type PlanContext } from "../internals/plan.js";

export interface EccReconcileExpectedRead {
  path: string;
  sha256: string;
}

export interface EccReconcileRemoveFileMutation {
  kind: "remove-file";
  phase?: "owned-removal" | "target-state";
  path: string;
  root: string;
}

export interface EccReconcileWriteFileMutation {
  kind: "write-file";
  phase?: "owned-removal" | "target-state";
  path: string;
  root: string;
  contents: string;
  mode?: number;
}

export interface EccReconcileRemoveJsonSubsetMutation {
  kind: "remove-json-subset";
  phase?: "owned-removal" | "target-state";
  path: string;
  root: string;
  payloads: unknown[];
}

export interface EccReconcileFilterCodexMcpMutation {
  kind: "filter-codex-mcp-block";
  phase?: "owned-removal" | "target-state";
  path: string;
  root: string;
  keepNames: string[];
}

export interface EccReconcileFilterCodexAgentsMutation {
  kind: "filter-codex-agents-block";
  phase?: "owned-removal" | "target-state";
  path: string;
  root: string;
  keepSkills: string[];
  removeBlock: boolean;
}

export type EccReconcileMutation =
  | EccReconcileFilterCodexAgentsMutation
  | EccReconcileFilterCodexMcpMutation
  | EccReconcileRemoveFileMutation
  | EccReconcileWriteFileMutation
  | EccReconcileRemoveJsonSubsetMutation;

export interface EccReconcileLedgerWrite {
  path: string;
  root: string;
  contents: string;
  mode?: number;
}

export interface EccReconcileTransactionPayload {
  reads: EccReconcileExpectedRead[];
  mutations: EccReconcileMutation[];
  uninstalls?: EccReconcileUpstreamUninstall[];
  ledger: EccReconcileLedgerWrite;
}

export interface EccReconcileUpstreamUninstall {
  target: Cli;
  argv: string[];
  cwd?: string;
  paths: string[];
}

const ECC_UPSTREAM_UNINSTALL_TIMEOUT_MS = 90_000;
const ECC_RECONCILE_DRIVER_GRACE_MS = 120_000;

const ECC_RECONCILE_TRANSACTION_DRIVER = String.raw`
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const payload = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
if (!payload || !Array.isArray(payload.reads) || !Array.isArray(payload.mutations) || !payload.ledger) {
  throw new Error("invalid ECC reconciliation transaction payload");
}
const uninstalls = payload.uninstalls === undefined ? [] : payload.uninstalls;
if (!Array.isArray(uninstalls)) throw new Error("invalid ECC reconciliation uninstalls");
for (const uninstall of uninstalls) {
  if (!uninstall || typeof uninstall.target !== "string"
    || !Array.isArray(uninstall.argv) || uninstall.argv.length === 0
    || !uninstall.argv.every((value) => typeof value === "string" && value.length > 0)
    || !Array.isArray(uninstall.paths)
    || !uninstall.paths.every((value) => typeof value === "string" && path.isAbsolute(value))
    || (uninstall.cwd !== undefined && (typeof uninstall.cwd !== "string" || !path.isAbsolute(uninstall.cwd)))) {
    throw new Error("invalid ECC reconciliation upstream uninstall");
  }
}

const transientLockCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const retryTransient = (operation) => {
  let delayMs = 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!transientLockCodes.has(error && error.code) || attempt >= 10) throw error;
      sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
};
const sha256 = (contents) => crypto.createHash("sha256").update(contents).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const deepEqual = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
};
const REMOVE = Symbol("remove");
const removeSubset = (current, subset, location) => {
  if (isObject(subset)) {
    if (!isObject(current)) throw new Error("managed JSON drift at " + location);
    const keys = Object.keys(subset);
    if (keys.length === 0) return current;
    const next = { ...current };
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) {
        throw new Error("managed JSON drift at " + location + "." + key);
      }
      const value = removeSubset(next[key], subset[key], location + "." + key);
      if (value === REMOVE) delete next[key];
      else next[key] = value;
    }
    return Object.keys(next).length === 0 ? REMOVE : next;
  }
  if (!deepEqual(current, subset)) throw new Error("managed JSON drift at " + location);
  return REMOVE;
};
const formattedJson = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
const withOriginalNewlines = (original, normalized) => /\r\n/.test(original)
  ? normalized.replace(/\n/g, "\r\n")
  : normalized;
const managedBlock = (text, begin, end, beginPrefix) => {
  const normalized = text.replace(/\r\n/g, "\n");
  const starts = [];
  let search = 0;
  while (true) {
    const found = normalized.indexOf(beginPrefix || begin, search);
    if (found < 0) break;
    starts.push(found);
    search = found + 1;
  }
  const ends = [];
  search = 0;
  while (true) {
    const found = normalized.indexOf(end, search);
    if (found < 0) break;
    ends.push(found);
    search = found + 1;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error("malformed or missing managed marker pair");
  }
  const start = starts[0];
  const beginEnd = normalized.indexOf("\n", start);
  if (beginEnd < 0 || beginEnd >= ends[0]) throw new Error("malformed managed begin marker");
  const stop = ends[0] + end.length;
  return { normalized, start, beginEnd, endStart: ends[0], stop };
};
const filterCodexMcpBlock = (text, keepNames) => {
  const begin = "# >>> aih managed (mcp) >>>";
  const end = "# <<< aih managed (mcp) <<<";
  const block = managedBlock(text, begin, end);
  const body = block.normalized.slice(block.beginEnd + 1, block.endStart);
  const lines = body.split("\n");
  const sections = [];
  let current = null;
  const header = /^\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*$/;
  for (const line of lines) {
    const match = header.exec(line);
    if (match) {
      current = { name: match[1] || match[2] || match[3], lines: [line] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim().length > 0) throw new Error("unrecognized content in managed Codex MCP block");
  }
  const keep = new Set(keepNames);
  const kept = sections.filter((section) => keep.has(section.name));
  let replacement = "";
  if (kept.length > 0) {
    const rendered = kept.map((section) => section.lines.join("\n").replace(/\n+$/, "")).join("\n\n");
    replacement = begin + "\n" + rendered + "\n" + end;
  }
  const next = block.normalized.slice(0, block.start) + replacement + block.normalized.slice(block.stop);
  return Buffer.from(withOriginalNewlines(text, next), "utf8");
};
const filterCodexAgentsBlock = (text, keepSkills, removeBlock) => {
  const beginPrefix = "<!-- BEGIN ecc-codex:agents";
  const end = "<!-- END ecc-codex:agents -->";
  const block = managedBlock(text, beginPrefix, end, beginPrefix);
  if (removeBlock) {
    const next = block.normalized.slice(0, block.start) + block.normalized.slice(block.stop);
    return Buffer.from(withOriginalNewlines(text, next), "utf8");
  }
  const body = block.normalized.slice(block.start, block.stop);
  const skillsPattern = /(Available skills:\n)((?:- [a-z0-9][a-z0-9-]*\n)*)/;
  const match = skillsPattern.exec(body);
  if (!match) throw new Error("ECC Codex AGENTS skill list is not recognized");
  const keep = new Set(keepSkills);
  const retained = match[2]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(2))
    .filter((name) => keep.has(name));
  const replacement = match[1] + retained.map((name) => "- " + name).join("\n")
    + (retained.length > 0 ? "\n" : "");
  const nextBody = body.replace(skillsPattern, replacement);
  const next = block.normalized.slice(0, block.start) + nextBody + block.normalized.slice(block.stop);
  return Buffer.from(withOriginalNewlines(text, next), "utf8");
};

const assertSafeFile = (root, target) => {
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof target !== "string" || !path.isAbsolute(target)) {
    throw new Error("ECC reconciliation paths must be absolute");
  }
  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("unsafe ECC reconciliation root: " + root);
  }
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("ECC reconciliation path escapes target root: " + target);
  }
  let current = lexicalRoot;
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) {
      if (index !== segments.length - 1) throw new Error("missing ECC reconciliation parent: " + current);
      continue;
    }
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error("refusing symlinked ECC reconciliation path: " + current);
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error("ECC reconciliation parent is not a directory: " + current);
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new Error("ECC reconciliation target is not a regular file: " + current);
    }
  }
};

const expected = new Map();
const live = new Map();
for (const read of payload.reads) {
  if (!read || typeof read.path !== "string" || !path.isAbsolute(read.path)
    || typeof read.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(read.sha256)) {
    throw new Error("invalid ECC reconciliation expected read");
  }
  if (expected.has(read.path)) throw new Error("duplicate ECC reconciliation read: " + read.path);
  const contents = fs.readFileSync(read.path);
  if (sha256(contents) !== read.sha256) {
    throw new Error("ECC prune input changed after planning: " + read.path);
  }
  expected.set(read.path, read.sha256);
  live.set(read.path, contents);
}

const prepared = [];
const mutationPaths = new Set();
for (const mutation of payload.mutations) {
  if (!mutation || typeof mutation.path !== "string" || typeof mutation.root !== "string") {
    throw new Error("invalid ECC reconciliation mutation");
  }
  if (mutation.phase !== undefined
    && mutation.phase !== "owned-removal"
    && mutation.phase !== "target-state") {
    throw new Error("invalid ECC reconciliation mutation phase");
  }
  assertSafeFile(mutation.root, mutation.path);
  if (!expected.has(mutation.path)) throw new Error("unbound ECC reconciliation mutation: " + mutation.path);
  if (mutationPaths.has(mutation.path)) throw new Error("duplicate ECC reconciliation mutation: " + mutation.path);
  mutationPaths.add(mutation.path);
  const current = live.get(mutation.path);
  let next;
  if (mutation.kind === "remove-file") {
    next = null;
  } else if (mutation.kind === "write-file") {
    if (typeof mutation.contents !== "string") throw new Error("invalid ECC reconciliation write");
    next = Buffer.from(mutation.contents, "utf8");
  } else if (mutation.kind === "remove-json-subset") {
    if (!Array.isArray(mutation.payloads)) throw new Error("invalid ECC reconciliation JSON subsets");
    let value;
    try {
      value = JSON.parse(current.toString("utf8"));
    } catch (error) {
      throw new Error("invalid managed JSON at " + mutation.path + ": " + error.message);
    }
    for (const subset of mutation.payloads) {
      value = removeSubset(value, subset, mutation.path);
      if (value === REMOVE) break;
    }
    next = value === REMOVE ? null : formattedJson(value);
  } else if (mutation.kind === "filter-codex-mcp-block") {
    if (!Array.isArray(mutation.keepNames)
      || !mutation.keepNames.every((name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name))) {
      throw new Error("invalid retained Codex MCP names");
    }
    next = filterCodexMcpBlock(current.toString("utf8"), mutation.keepNames);
  } else if (mutation.kind === "filter-codex-agents-block") {
    if (!Array.isArray(mutation.keepSkills)
      || !mutation.keepSkills.every((name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name))
      || typeof mutation.removeBlock !== "boolean") {
      throw new Error("invalid retained Codex skill names");
    }
    next = filterCodexAgentsBlock(
      current.toString("utf8"),
      mutation.keepSkills,
      mutation.removeBlock,
    );
  } else {
    throw new Error("unsupported ECC reconciliation mutation: " + mutation.kind);
  }
  if (next !== null && Buffer.compare(current, next) === 0) continue;
  prepared.push({
    path: mutation.path,
    root: mutation.root,
    next,
    mode: mutation.mode,
    phase: mutation.phase || "owned-removal",
  });
}

const ledger = payload.ledger;
if (!ledger || typeof ledger.path !== "string" || typeof ledger.root !== "string"
  || typeof ledger.contents !== "string") {
  throw new Error("invalid ECC reconciliation ledger write");
}
assertSafeFile(ledger.root, ledger.path);
if (!expected.has(ledger.path)) throw new Error("unbound ECC reconciliation ledger: " + ledger.path);
if (mutationPaths.has(ledger.path)) throw new Error("ledger duplicated as ECC reconciliation mutation");
const ledgerCurrent = live.get(ledger.path);
const ledgerNext = Buffer.from(ledger.contents, "utf8");
const ledgerChange = Buffer.compare(ledgerCurrent, ledgerNext) === 0
  ? null
  : { path: ledger.path, root: ledger.root, next: ledgerNext, mode: ledger.mode };

const transactionId = crypto.randomUUID();
const applied = [];
const temporaryPaths = new Set();
const atomicWrite = (target, contents, mode) => {
  const temporary = target + ".aih-ecc-prune." + transactionId + ".tmp";
  temporaryPaths.add(temporary);
  fs.writeFileSync(temporary, contents, { flag: "wx", mode });
  fs.chmodSync(temporary, mode);
  retryTransient(() => fs.renameSync(temporary, target));
  temporaryPaths.delete(temporary);
};
const applyChange = (change) => {
  const stats = fs.lstatSync(change.path);
  const backup = change.path + ".aih-ecc-prune." + transactionId + ".bak";
  if (fs.existsSync(backup)) throw new Error("occupied ECC reconciliation backup: " + backup);
  retryTransient(() => fs.renameSync(change.path, backup));
  const record = { path: change.path, backup };
  applied.push(record);
  if (change.next !== null) {
    const mode = Number.isInteger(change.mode) ? change.mode : (stats.mode & 0o777);
    atomicWrite(change.path, change.next, mode);
  }
};

const completedUninstalls = [];
let activeUninstall = null;
let activeChild = null;
let divergence = null;
let handlingSignal = false;
let transactionCommitted = false;
const rollbackApplied = () => {
  const rollbackErrors = [];
  for (const temporary of temporaryPaths) {
    try { fs.rmSync(temporary, { force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
  }
  for (const record of [...applied].reverse()) {
    try {
      fs.rmSync(record.path, { force: true });
      if (fs.existsSync(record.backup)) retryTransient(() => fs.renameSync(record.backup, record.path));
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  return rollbackErrors;
};
const cleanupRecoveryMaterial = () => {
  for (const temporary of temporaryPaths) fs.rmSync(temporary, { force: true });
  for (const record of applied) fs.rmSync(record.backup, { force: true });
};
const affectedUninstalls = () => {
  const candidates = [
    ...(divergence ? [divergence] : activeUninstall ? [activeUninstall] : []),
    ...completedUninstalls,
  ];
  const seen = new Set();
  return candidates.filter((value) => {
    const key = value.target + "\u0000" + value.paths.join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const divergenceMessage = (affected, reason, rollbackErrors) => {
  const evidence = affected
    .map((value) => "target=" + value.target + "; paths=" + (value.paths.join(",") || "unknown"))
    .join("; ");
  const rollback = rollbackErrors.length > 0
    ? "; ECC reconciliation rollback failed: "
      + rollbackErrors.map((value) => value.message).join("; ")
    : "";
  return "ECC prune divergence: " + evidence + "; " + reason + rollback
    + "; registration ledger not advanced";
};
const handleSignal = (signal) => {
  if (handlingSignal) return;
  handlingSignal = true;
  if (transactionCommitted) {
    cleanupRecoveryMaterial();
    fs.writeSync(2, "ECC prune reconciliation interrupted by " + signal
      + " after ledger commit; committed state retained\n");
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
  if (activeChild) activeChild.kill(signal);
  const affected = affectedUninstalls();
  const rollbackErrors = rollbackApplied();
  const reason = "interrupted by " + signal;
  const message = affected.length > 0
    ? divergenceMessage(affected, reason, rollbackErrors)
    : "ECC prune reconciliation " + reason
      + (rollbackErrors.length > 0
        ? "; ECC reconciliation rollback failed: "
          + rollbackErrors.map((value) => value.message).join("; ")
        : "")
      + "; registration ledger not advanced";
  fs.writeSync(2, message + "\n");
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));
const uninstallDeadline = Date.now() + Math.max(1, uninstalls.length) * ${ECC_UPSTREAM_UNINSTALL_TIMEOUT_MS};
const runUpstreamUninstall = (uninstall, timeout) => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  const tail = (current, chunk) => (current + chunk.toString("utf8")).slice(-500);
  const child = childProcess.spawn(uninstall.argv[0], uninstall.argv.slice(1), {
    cwd: uninstall.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  activeChild = child;
  child.stdout.on("data", (chunk) => { stdout = tail(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = tail(stderr, chunk); });
  child.once("error", (error) => { spawnError = error; });
  child.once("close", (status, signal) => resolve({ error: spawnError, status, signal, stdout, stderr }));
});
const runTransaction = async () => {
try {
  for (const change of prepared.filter((value) => value.phase === "owned-removal")) {
    applyChange(change);
  }
  for (const uninstall of uninstalls) {
    activeUninstall = uninstall;
    const remainingMs = Math.max(1, uninstallDeadline - Date.now());
    const result = await runUpstreamUninstall(
      uninstall,
      Math.min(${ECC_UPSTREAM_UNINSTALL_TIMEOUT_MS}, remainingMs),
    );
    activeChild = null;
    if (result.error || result.status !== 0) {
      const baseReason = result.error
        ? result.error.message
        : "upstream uninstall exited " + (result.status === null ? "by signal" : result.status);
      const diagnostic = (result.stderr || result.stdout || "").trim().slice(-500);
      const reason = diagnostic.length > 0 ? baseReason + ": " + diagnostic : baseReason;
      divergence = { ...uninstall, reason };
      activeUninstall = null;
      throw new Error(reason);
    }
    completedUninstalls.push(uninstall);
    activeUninstall = null;
  }
  for (const change of prepared.filter((value) => value.phase === "target-state")) {
    applyChange(change);
  }
  if (ledgerChange) applyChange(ledgerChange);
  transactionCommitted = true;
} catch (error) {
  const rollbackErrors = rollbackApplied();
  const affected = affectedUninstalls();
  if (affected.length > 0) {
    const reason = divergence ? divergence.reason : "failure after upstream uninstall: " + error.message;
    throw new Error(divergenceMessage(affected, reason, rollbackErrors));
  }
  if (rollbackErrors.length > 0) {
    throw new Error(error.message + "; ECC reconciliation rollback failed: "
      + rollbackErrors.map((value) => value.message).join("; "));
  }
  throw error;
}

cleanupRecoveryMaterial();
};
runTransaction().catch((error) => {
  fs.writeSync(2, (error.stack || error.message || String(error)) + "\n");
  process.exitCode = 1;
});
`;

export function eccReconcileTransactionAction(
  ctx: PlanContext,
  payload: EccReconcileTransactionPayload,
): ExecAction {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return exec(
    "Reconcile ECC managed components, target states, and registration ledger — atomic ledger-last transaction",
    [process.execPath, "-e", ECC_RECONCILE_TRANSACTION_DRIVER, encoded],
    {
      cwd: ctx.root,
      timeoutMs:
        ECC_RECONCILE_DRIVER_GRACE_MS +
        (payload.uninstalls?.length ?? 0) * ECC_UPSTREAM_UNINSTALL_TIMEOUT_MS,
      blockProbesOnFailure: true,
      requiresPriorExecSuccess: true,
      failureCheck: (result) => ({
        name: "ECC prune reconciliation",
        verdict: "fail",
        detail: `ECC prune reconciliation failed (exit ${result.code ?? "signal"})${
          result.stderr.trim().length > 0 ? `: ${result.stderr.trim().slice(0, 2_000)}` : ""
        }`,
      }),
    },
  );
}
