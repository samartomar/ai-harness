import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type Action,
  AihError,
  type Cli,
  digest,
  doc,
  lines,
  type PlanContext,
  readRegistrationLedgerSnapshot,
  readRegularFileWithStats,
  serializeRegistrationLedger,
} from "@aihq/core/framework-host";
import type { EccComponentSelection } from "./components.js";
import { isAihDirectEccInstallTarget } from "./install.js";
import {
  defaultProjectStatus,
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
    components: record.components
      .map((component) => component.id)
      .filter((componentId) => !componentId.startsWith("module:")),
    mcps: [...record.mcps],
    recommendations: [],
    moduleIds: record.components
      .map((component) => component.id)
      .filter((componentId) => componentId.startsWith("module:"))
      .map((componentId) => componentId.slice("module:".length)),
  };
}

function emptyTargetSelection(): EccComponentSelection {
  return {
    scope: "scoped",
    components: [],
    mcps: [],
    recommendations: [],
    moduleIds: [],
  };
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
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

function codexUnprovenPaths(
  reconciliation: ReturnType<typeof reconcileEccRegistrationLedger>,
  home: string,
): string[] {
  if (reconciliation.full) return [];
  const prior = reconciliation.prior.targets.find((entry) => entry.target === "codex");
  if (prior === undefined) return [];
  const next = reconciliation.ledger.targets.find((entry) => entry.target === "codex");
  const removedComponents = prior.components.some(
    (component) => !next?.components.some((remaining) => remaining.id === component.id),
  );
  const removedMcps = prior.mcps.some((mcp) => !next?.mcps.includes(mcp));
  if (!removedComponents && !removedMcps) return [];
  // The aih Codex state records table/key names, not the values or hashes it
  // wrote. It cannot distinguish a changed block from unchanged aih content.
  // Keep the state and ledger together for a manual, project-union-aware review.
  return [
    join(home, ".codex", "ecc-aih-install-state.json"),
    ...(removedComponents ? [join(home, ".codex", "AGENTS.md")] : []),
    ...(removedMcps ? [join(home, ".codex", "config.toml")] : []),
  ];
}
export function hasEccRegistrationLedger(ctx: PlanContext): boolean {
  const configuredHome = ctx.env.HOME ?? ctx.env.USERPROFILE;
  if (configuredHome === undefined) return false;
  const home = resolve(configuredHome);
  return readRegistrationLedgerSnapshot(home) !== undefined;
}

export function hasEccRegisteredTarget(ctx: PlanContext, target: Cli): boolean {
  const configuredHome = ctx.env.HOME ?? ctx.env.USERPROFILE;
  if (configuredHome === undefined) return false;
  const home = resolve(configuredHome);
  const snapshot = readRegistrationLedgerSnapshot(home);
  return snapshot?.ledger.targets.some((entry) => entry.target === target) ?? false;
}

export function eccPruneReconciliationActions(
  ctx: PlanContext,
  droppedTargets: readonly Cli[] = [],
  retireProjectRoot?: string,
): Action[] {
  const configuredHome = ctx.env.HOME ?? ctx.env.USERPROFILE;
  if (configuredHome === undefined) return [];
  const home = resolve(configuredHome);
  const snapshot = readRegistrationLedgerSnapshot(home);
  if (snapshot === undefined) return [];
  if (
    droppedTargets.length > 0 &&
    snapshot.ledger.projects.some(
      (project) =>
        resolve(project.root) !== resolve(ctx.root) &&
        defaultProjectStatus(project.root) === "live",
    )
  ) {
    const others = snapshot.ledger.projects
      .filter(
        (project) =>
          resolve(project.root) !== resolve(ctx.root) &&
          defaultProjectStatus(project.root) === "live",
      )
      .map((project) => project.root);
    const listed: string[] = [];
    const prior = reconcileEccRegistrationLedger(snapshot.ledger);
    for (const candidate of eccInstallStateCandidates(home, prior)) {
      if (!droppedTargets.includes(candidate.target)) continue;
      const opened = safeRead(candidate.root, candidate.statePath);
      if (opened === undefined) {
        listed.push(`${candidate.statePath} (state absent)`);
        continue;
      }
      const state = parseEccInstallState(opened.contents.toString("utf8"), candidate.statePath);
      listed.push(...state.operations.map((operation) => operation.destinationPath));
    }
    const paths = [...new Set(listed)].sort();
    return [
      doc(
        "Preserve shared ECC home registration",
        lines(
          "The ECC ledger does not map each target claim to a project. Another live project still shares this home registration.",
          ...others.map(
            (root) =>
              `  [manual] ${root}: keep its ECC files and registration; review this project's stale target pin separately`,
          ),
          ...paths.map(
            (path) =>
              `  [manual] ${path}: inspect this driver-listed destination before any removal`,
          ),
        ),
      ),
      digest("ECC shared home registration needs manual review", [...others, ...paths].join("\n"), {
        projects: others,
        paths,
      }),
    ];
  }
  const reconciliation = reconcileEccRegistrationLedger(snapshot.ledger, {
    droppedTargets,
    ...(retireProjectRoot === undefined
      ? {}
      : {
          projectStatus: (root: string) =>
            resolve(root) === resolve(retireProjectRoot)
              ? ("missing" as const)
              : defaultProjectStatus(root),
        }),
  });
  const reads = new Map<string, EccReconcileExpectedRead>();
  addRead(reads, snapshot.path, snapshot.contents);
  const mutations: EccReconcileMutation[] = [];
  const registeredTargets = new Set(snapshot.ledger.targets.map((target) => target.target));
  const receiptBoundDroppedTargets = new Set(
    droppedTargets.filter(
      (target) =>
        registeredTargets.has(target) &&
        (isAihDirectEccInstallTarget(target) || target === "codex"),
    ),
  );
  const priorCandidates = eccInstallStateCandidates(
    home,
    reconcileEccRegistrationLedger(snapshot.ledger),
  );
  const candidateMap = new Map(
    [
      ...eccInstallStateCandidates(home, reconciliation),
      ...priorCandidates.filter(
        (candidate) =>
          receiptBoundDroppedTargets.has(candidate.target) ||
          (retireProjectRoot !== undefined &&
            candidate.projectRoot !== undefined &&
            resolve(candidate.projectRoot) === resolve(retireProjectRoot)),
      ),
    ].map((candidate) => [pathIdentity(candidate.statePath), candidate]),
  );
  const candidates = [...candidateMap.values()].sort((left, right) =>
    pathIdentity(left.statePath).localeCompare(pathIdentity(right.statePath)),
  );
  const foundStateTargets = new Set<Cli>();
  const affectedStatePaths: string[] = [];
  const removedDestinations: string[] = [];
  const unprovenDestinations: string[] = [];

  for (const candidate of candidates) {
    const dropped =
      receiptBoundDroppedTargets.has(candidate.target) ||
      (retireProjectRoot !== undefined &&
        candidate.projectRoot !== undefined &&
        resolve(candidate.projectRoot) === resolve(retireProjectRoot));
    const opened = safeRead(candidate.root, candidate.statePath);
    if (opened === undefined) continue;
    foundStateTargets.add(candidate.target);
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
      dropped ? emptyTargetSelection() : targetSelection(reconciliation, candidate.target),
    );
    if (stateReconciliation.removed.length === 0 && !dropped) continue;
    if (stateReconciliation.removed.length > 0) {
      // The driver wrote this state, but its list can include pre-existing files
      // and JSON entries. A ledger registration plus this state is not a per-path
      // aih ownership receipt. Keep both records so a rerun remains inspectable.
      unprovenDestinations.push(
        ...stateReconciliation.removed.map((operation) => operation.destinationPath),
      );
      continue;
    }
    for (const operation of stateReconciliation.removed) {
      const destination = safeRead(candidate.root, operation.destinationPath);
      if (destination === undefined) continue;
      addRead(reads, operation.destinationPath, destination.contents);
      if (operation.kind === "copy-file") {
        const recordedDigest = operation.contentSha256;
        if (typeof recordedDigest !== "string" || !/^[a-f0-9]{64}$/i.test(recordedDigest)) {
          fail(
            `refusing to remove unverifiable ECC managed file without a recorded content digest; preserve it for manual cleanup: ${operation.destinationPath}`,
          );
        }
        if (sha256(destination.contents) !== recordedDigest.toLowerCase()) {
          fail(`refusing to remove modified ECC managed file: ${operation.destinationPath}`);
        }
        mutations.push({
          kind: "remove-file",
          phase: "owned-removal",
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
          phase: "owned-removal",
          path: operation.destinationPath,
          root: candidate.root,
          payloads: [mergePayload],
        });
      }
      removedDestinations.push(operation.destinationPath);
    }
    mutations.push(
      dropped
        ? {
            kind: "remove-file",
            phase: "target-state",
            path: candidate.statePath,
            root: candidate.root,
          }
        : {
            kind: "write-file",
            phase: "target-state",
            path: candidate.statePath,
            root: candidate.root,
            contents: stateReconciliation.nextText,
            mode: opened.mode,
          },
    );
    affectedStatePaths.push(candidate.statePath);
  }

  for (const target of receiptBoundDroppedTargets) {
    if (!foundStateTargets.has(target)) {
      fail(`missing ECC install state for dropped target: ${target}`);
    }
  }
  for (const target of reconciliation.ledger.targets) {
    if (
      targetShrank(reconciliation, target.target) &&
      candidates.some(
        (candidate) => candidate.target === target.target && candidate.scope === "home",
      ) &&
      !foundStateTargets.has(target.target)
    ) {
      fail(`missing ECC install state for shrinking home target: ${target.target}`);
    }
  }

  unprovenDestinations.push(...codexUnprovenPaths(reconciliation, home));
  if (unprovenDestinations.length > 0) {
    const paths = [...new Set(unprovenDestinations)].sort();
    return [
      doc(
        "Preserve unproven ECC driver destinations",
        lines(
          "AIH's ledger and ECC's install state together do not prove that aih created each destination.",
          ...paths.map(
            (path) =>
              `  [manual] ${path}: inspect the recorded ECC state and current bytes; remove only after confirming ownership`,
          ),
          "Use the upstream ECC uninstaller dry run for the named target before any manual removal.",
        ),
      ),
      digest("ECC driver destinations need manual review", paths.join("\n"), { paths }),
    ];
  }
  const nextLedger = serializeRegistrationLedger(reconciliation.ledger);
  const ledgerChanged = Buffer.compare(snapshot.contents, Buffer.from(nextLedger, "utf8")) !== 0;
  if (!ledgerChanged && mutations.length === 0) return [];
  const payload: EccReconcileTransactionPayload = {
    reads: [...reads.values()].sort((left, right) => left.path.localeCompare(right.path)),
    mutations,
    uninstalls: [],
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
