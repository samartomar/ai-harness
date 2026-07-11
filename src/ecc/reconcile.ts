import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import type { EccComponentId, EccMcpComponentId } from "./components.js";
import {
  machineRegistrationUnion,
  parseRegistrationLedger,
  type RegistrationLedger,
  type RegistrationUnion,
} from "./registration.js";

export type EccProjectStatus = "live" | "missing";

export interface EccLedgerReconciliation {
  prior: RegistrationLedger;
  ledger: RegistrationLedger;
  desired: RegistrationUnion;
  retiredProjects: string[];
  full: boolean;
  removedComponents: EccComponentId[];
  removedMcps: EccMcpComponentId[];
}

export interface EccReconciliationOptions {
  projectStatus?: (root: string) => EccProjectStatus;
  droppedTargets?: readonly Cli[];
}

export interface EccInstallStateCandidate {
  target: Cli;
  scope: "home" | "project";
  root: string;
  statePath: string;
  projectRoot?: string;
}

interface TargetLocation {
  scope: "home" | "project";
  rootSegment: string;
  stateSegments: readonly string[];
}

const TARGET_LOCATIONS: Partial<Record<Cli, TargetLocation>> = {
  claude: { scope: "home", rootSegment: ".claude", stateSegments: ["ecc", "install-state.json"] },
  codex: { scope: "home", rootSegment: ".codex", stateSegments: ["ecc-install-state.json"] },
  cursor: { scope: "project", rootSegment: ".cursor", stateSegments: ["ecc-install-state.json"] },
  antigravity: {
    scope: "project",
    rootSegment: ".agent",
    stateSegments: ["ecc-install-state.json"],
  },
  gemini: { scope: "project", rootSegment: ".gemini", stateSegments: ["ecc-install-state.json"] },
  opencode: { scope: "home", rootSegment: ".opencode", stateSegments: ["ecc-install-state.json"] },
  zed: { scope: "project", rootSegment: ".zed", stateSegments: ["ecc-install-state.json"] },
};

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function defaultProjectStatus(root: string): EccProjectStatus {
  try {
    const stats = lstatSync(root);
    if (stats.isSymbolicLink()) {
      throw new AihError(`refusing symlinked ECC registered project root: ${root}`, "AIH_CONFIG");
    }
    if (!stats.isDirectory()) {
      throw new AihError(`ECC registered project root is not a directory: ${root}`, "AIH_CONFIG");
    }
    return "live";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    if (error instanceof AihError) throw error;
    throw new AihError(
      `cannot inspect ECC registered project root ${root}: ${(error as Error).message}`,
      "AIH_CONFIG",
    );
  }
}

function difference<T extends string>(prior: readonly T[], next: readonly T[]): T[] {
  const retained = new Set(next);
  return uniqueSorted(prior.filter((value) => !retained.has(value)));
}

export function reconcileEccRegistrationLedger(
  ledger: RegistrationLedger,
  options: EccReconciliationOptions = {},
): EccLedgerReconciliation {
  const prior = parseRegistrationLedger(JSON.stringify(ledger));
  const projectStatus = options.projectStatus ?? defaultProjectStatus;
  const statuses = prior.projects.map((project) => ({
    project,
    status: projectStatus(project.root),
  }));
  const projects = statuses.filter(({ status }) => status === "live").map(({ project }) => project);
  const retiredProjects = statuses
    .filter(({ status }) => status === "missing")
    .map(({ project }) => project.root)
    .sort((left, right) => left.localeCompare(right));
  const droppedTargets = new Set(options.droppedTargets ?? []);
  const full = projects.some((project) => project.scope === "full");
  const desired = machineRegistrationUnion({ schemaVersion: 1, projects, targets: [] });
  const desiredComponents = new Set(desired.components);
  const desiredMcps = new Set(desired.mcps);
  const targets = prior.targets
    .filter((target) => !droppedTargets.has(target.target))
    .map((target) =>
      full
        ? target
        : {
            ...target,
            components: target.components.filter((component) =>
              desiredComponents.has(component.id),
            ),
            mcps: target.mcps.filter((mcp) => desiredMcps.has(mcp)),
          },
    );
  const next = parseRegistrationLedger(JSON.stringify({ schemaVersion: 1, projects, targets }));
  const priorUnion = machineRegistrationUnion(prior);

  return {
    prior,
    ledger: next,
    desired,
    retiredProjects,
    full,
    removedComponents: full ? [] : difference(priorUnion.components, desired.components),
    removedMcps: full ? [] : difference(priorUnion.mcps, desired.mcps),
  };
}

export function eccInstallStateCandidates(
  home: string,
  reconciliation: EccLedgerReconciliation,
): EccInstallStateCandidate[] {
  if (!isAbsolute(home)) {
    throw new AihError("ECC reconciliation home must be absolute", "AIH_CONFIG");
  }
  const normalizedHome = resolve(home);
  const candidates: EccInstallStateCandidate[] = [];
  for (const target of reconciliation.ledger.targets) {
    const location = TARGET_LOCATIONS[target.target];
    if (location === undefined) continue;
    if (location.scope === "home") {
      const root = join(normalizedHome, location.rootSegment);
      candidates.push({
        target: target.target,
        scope: "home",
        root,
        statePath: join(root, ...location.stateSegments),
      });
      continue;
    }
    for (const project of reconciliation.ledger.projects) {
      const root = join(project.root, location.rootSegment);
      candidates.push({
        target: target.target,
        scope: "project",
        projectRoot: project.root,
        root,
        statePath: join(root, ...location.stateSegments),
      });
    }
  }
  return candidates.sort((left, right) =>
    [left.target, left.projectRoot ?? "", left.statePath]
      .join("\0")
      .localeCompare([right.target, right.projectRoot ?? "", right.statePath].join("\0")),
  );
}
