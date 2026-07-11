import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { type Action, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { codexHomeDir, codexInstallStatePath } from "./codex.js";
import type { EccComponentSelection } from "./components.js";
import { eccMaterializationSpec } from "./materialize.js";
import {
  eccInstallStateCandidates,
  parseEccInstallState,
  reconcileEccInstallState,
  reconcileEccRegistrationLedger,
} from "./reconcile.js";
import {
  type EccReconcileExpectedRead,
  type EccReconcileMutation,
  type EccReconcileTransactionPayload,
  eccReconcileTransactionAction,
} from "./reconcile-driver.js";
import { readRegistrationLedgerSnapshot, serializeRegistrationLedger } from "./registration.js";

const StringArray = z.array(z.string());
const CodexAihStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    managedBy: z.literal("aih"),
    codexToml: z
      .object({
        rootKeys: StringArray,
        tables: StringArray,
        tableKeys: z.record(z.string(), StringArray),
        mcpServers: StringArray,
      })
      .strict(),
    agentsBlock: z.boolean(),
  })
  .strict();

type CodexAihState = z.infer<typeof CodexAihStateSchema>;

interface SafeRead {
  contents: Buffer;
  mode: number;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function fail(message: string): never {
  throw new AihError(message, "AIH_CONFIG");
}

function safeRead(root: string, path: string): SafeRead | undefined {
  if (!isAbsolute(root) || !isAbsolute(path)) fail("ECC reconciliation paths must be absolute");
  const lexicalRoot = resolve(root);
  const lexicalPath = resolve(path);
  const rel = relative(lexicalRoot, lexicalPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`ECC reconciliation path escapes target root: ${path}`);
  }
  let finalStats: ReturnType<typeof lstatSync>;
  try {
    finalStats = lstatSync(lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail(`cannot inspect ECC reconciliation path ${path}: ${(error as Error).message}`);
  }
  let current = lexicalRoot;
  let rootStats: ReturnType<typeof lstatSync>;
  try {
    rootStats = lstatSync(current);
  } catch (error) {
    fail(`cannot inspect ECC reconciliation root ${root}: ${(error as Error).message}`);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    fail(`unsafe ECC reconciliation root: ${root}`);
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index] ?? "");
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(`unsafe ECC reconciliation parent: ${current}`);
    }
  }
  if (finalStats.isSymbolicLink() || !finalStats.isFile()) {
    fail(`ECC reconciliation target is not a regular file: ${path}`);
  }
  const opened = readRegularFileWithStats(lexicalPath);
  if (opened === undefined) fail(`refusing unreadable ECC reconciliation file: ${path}`);
  return { contents: opened.contents, mode: opened.stats.mode & 0o777 };
}

function targetSelection(
  reconciliation: ReturnType<typeof reconcileEccRegistrationLedger>,
  target: Cli,
): EccComponentSelection {
  const record = reconciliation.ledger.targets.find((entry) => entry.target === target);
  if (record === undefined) fail(`missing reconciled ECC target record: ${target}`);
  return {
    scope: reconciliation.full ? "full" : "scoped",
    components: record.components.map((component) => component.id),
    mcps: [...record.mcps],
    recommendations: [],
  };
}

function targetShrank(
  reconciliation: ReturnType<typeof reconcileEccRegistrationLedger>,
  target: Cli,
): boolean {
  const prior = reconciliation.prior.targets.find((entry) => entry.target === target);
  const next = reconciliation.ledger.targets.find((entry) => entry.target === target);
  if (prior === undefined || next === undefined) return prior !== undefined;
  const nextComponents = new Set(next.components.map((component) => component.id));
  const nextMcps = new Set(next.mcps);
  return (
    prior.components.some((component) => !nextComponents.has(component.id)) ||
    prior.mcps.some((mcp) => !nextMcps.has(mcp))
  );
}

function addRead(
  reads: Map<string, EccReconcileExpectedRead>,
  path: string,
  contents: Buffer,
): void {
  const existing = reads.get(path);
  const hash = sha256(contents);
  if (existing !== undefined && existing.sha256 !== hash) {
    fail(`ECC reconciliation path produced inconsistent reads: ${path}`);
  }
  reads.set(path, { path, sha256: hash });
}

function parseCodexAihState(contents: Buffer, path: string): CodexAihState {
  try {
    return CodexAihStateSchema.parse(JSON.parse(contents.toString("utf8")));
  } catch (error) {
    throw new AihError(
      `invalid aih ECC Codex install state (${path}): ${(error as Error).message}`,
      "AIH_CONFIG",
    );
  }
}

function codexMutations(
  ctx: PlanContext,
  reconciliation: ReturnType<typeof reconcileEccRegistrationLedger>,
  reads: Map<string, EccReconcileExpectedRead>,
): EccReconcileMutation[] {
  if (reconciliation.full) return [];
  const prior = reconciliation.prior.targets.find((target) => target.target === "codex");
  const next = reconciliation.ledger.targets.find((target) => target.target === "codex");
  if (prior === undefined || next === undefined) return [];
  const statePath = codexInstallStatePath(ctx);
  const codexRoot = codexHomeDir(ctx);
  const nextComponentIds = new Set(next.components.map((component) => component.id));
  const componentsChanged = prior.components.some(
    (component) => !nextComponentIds.has(component.id),
  );
  const nextMcpIds = new Set(next.mcps.map((mcp) => mcp.slice("mcp:".length)));
  const opened = safeRead(codexRoot, statePath);
  if (opened === undefined) {
    if (componentsChanged || prior.mcps.some((mcp) => !next.mcps.includes(mcp))) {
      fail(`missing aih ECC Codex install state: ${statePath}`);
    }
    return [];
  }
  addRead(reads, statePath, opened.contents);
  const state = parseCodexAihState(opened.contents, statePath);
  const keptMcpNames = state.codexToml.mcpServers.filter((name) => nextMcpIds.has(name));
  const mcpsChanged = keptMcpNames.length !== state.codexToml.mcpServers.length;
  const removeAgentsBlock = next.components.length === 0;
  const nextState: CodexAihState = {
    ...state,
    codexToml: { ...state.codexToml, mcpServers: keptMcpNames },
    agentsBlock: removeAgentsBlock ? false : state.agentsBlock,
  };
  const mutations: EccReconcileMutation[] = [];
  if (mcpsChanged) {
    const configPath = join(codexRoot, "config.toml");
    const config = safeRead(codexRoot, configPath);
    if (config === undefined) fail(`missing Codex config claimed by ECC state: ${configPath}`);
    addRead(reads, configPath, config.contents);
    mutations.push({
      kind: "filter-codex-mcp-block",
      path: configPath,
      root: codexRoot,
      keepNames: keptMcpNames,
    });
  }
  if (componentsChanged && state.agentsBlock) {
    const agentsPath = join(codexRoot, "AGENTS.md");
    const agents = safeRead(codexRoot, agentsPath);
    if (agents === undefined) fail(`missing Codex AGENTS file claimed by ECC state: ${agentsPath}`);
    addRead(reads, agentsPath, agents.contents);
    mutations.push({
      kind: "filter-codex-agents-block",
      path: agentsPath,
      root: codexRoot,
      keepSkills: eccMaterializationSpec(targetSelection(reconciliation, "codex")).skills.sort(),
      removeBlock: removeAgentsBlock,
    });
  }
  if (mcpsChanged || (componentsChanged && state.agentsBlock)) {
    mutations.push({
      kind: "write-file",
      path: statePath,
      root: codexRoot,
      contents: `${JSON.stringify(nextState, null, 2)}\n`,
      mode: opened.mode,
    });
  }
  return mutations;
}

export function eccPruneReconciliationActions(
  ctx: PlanContext,
  droppedTargets: readonly Cli[] = [],
): Action[] {
  const home = resolve(ctx.env.HOME || ctx.env.USERPROFILE || homedir());
  const snapshot = readRegistrationLedgerSnapshot(home);
  if (snapshot === undefined) return [];
  const reconciliation = reconcileEccRegistrationLedger(snapshot.ledger, { droppedTargets });
  const reads = new Map<string, EccReconcileExpectedRead>();
  addRead(reads, snapshot.path, snapshot.contents);
  const mutations: EccReconcileMutation[] = [];
  const affectedStatePaths: string[] = [];
  const removedDestinations: string[] = [];

  for (const candidate of eccInstallStateCandidates(home, reconciliation)) {
    const opened = safeRead(candidate.root, candidate.statePath);
    if (opened === undefined) {
      if (candidate.scope === "home" && targetShrank(reconciliation, candidate.target)) {
        fail(`missing ECC install state for shrinking home target: ${candidate.statePath}`);
      }
      continue;
    }
    addRead(reads, candidate.statePath, opened.contents);
    const state = parseEccInstallState(opened.contents.toString("utf8"), candidate.statePath);
    if (
      resolve(state.target.root) !== resolve(candidate.root) ||
      state.target.target !== candidate.target ||
      state.target.id !== `${candidate.target}-${candidate.scope}`
    ) {
      fail(`ECC install-state target identity mismatch: ${candidate.statePath}`);
    }
    const stateReconciliation = reconcileEccInstallState(
      state,
      targetSelection(reconciliation, candidate.target),
    );
    if (stateReconciliation.removed.length === 0) continue;
    for (const operation of stateReconciliation.removed) {
      const destination = safeRead(candidate.root, operation.destinationPath);
      if (destination === undefined) continue;
      addRead(reads, operation.destinationPath, destination.contents);
      removedDestinations.push(operation.destinationPath);
      if (operation.kind === "copy-file") {
        mutations.push({
          kind: "remove-file",
          path: operation.destinationPath,
          root: candidate.root,
        });
      } else {
        const mergePayload = operation.mergePayload;
        if (mergePayload === undefined) {
          fail(`missing managed JSON payload in ECC install state: ${operation.destinationPath}`);
        }
        mutations.push({
          kind: "remove-json-subset",
          path: operation.destinationPath,
          root: candidate.root,
          payloads: [mergePayload],
        });
      }
    }
    mutations.push({
      kind: "write-file",
      path: candidate.statePath,
      root: candidate.root,
      contents: stateReconciliation.nextText,
      mode: opened.mode,
    });
    affectedStatePaths.push(candidate.statePath);
  }

  mutations.push(...codexMutations(ctx, reconciliation, reads));
  const nextLedger = serializeRegistrationLedger(reconciliation.ledger);
  const ledgerChanged = Buffer.compare(snapshot.contents, Buffer.from(nextLedger, "utf8")) !== 0;
  if (!ledgerChanged && mutations.length === 0) return [];
  const payload: EccReconcileTransactionPayload = {
    reads: [...reads.values()].sort((left, right) => left.path.localeCompare(right.path)),
    mutations,
    ledger: { path: snapshot.path, root: home, contents: nextLedger, mode: 0o600 },
  };
  const detail = lines(
    `Retired project roots: ${reconciliation.retiredProjects.join(", ") || "none"}`,
    `Orphan components: ${reconciliation.removedComponents.join(", ") || "none"}`,
    `Orphan MCPs: ${reconciliation.removedMcps.join(", ") || "none"}`,
    `Target states: ${affectedStatePaths.sort().join(", ") || "none"}`,
    `Managed destinations: ${removedDestinations.sort().join(", ") || "none"}`,
    "Apply runs one rollback-safe transaction and replaces the registration ledger last.",
  );
  return [
    eccReconcileTransactionAction(ctx, payload),
    digest("ECC component registration reconciliation", detail, {
      retiredProjects: reconciliation.retiredProjects,
      removedComponents: reconciliation.removedComponents,
      removedMcps: reconciliation.removedMcps,
      affectedStatePaths: affectedStatePaths.sort(),
      removedDestinations: removedDestinations.sort(),
    }),
  ];
}
