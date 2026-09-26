import { claudeUsageHookCommand } from "../usage/hooks.js";
import { PACKAGE_NAME, REPO } from "../version.js";
import {
  type AihHookBehaviour,
  type AihHookControl,
  type AihPolicyControl,
  aihPolicyControls,
  type PolicyAuthoringCatalog,
  type PolicyAuthoringHook,
  type PolicyAuthoringHookRegistryEntry,
  type PolicyAuthoringHost,
  policyAuthoringHosts,
  policyAuthoringMcpCatalog,
  policyAuthoringNonProjectableMcpCatalog,
  policyAuthoringUnavailableMcpCatalog,
} from "./catalog.js";
import { hookOverlaps, hookSpawnProjection } from "./hook-registrar.js";
import type { HookRegistration } from "./schema.js";

/**
 * Core's own product declarations as the Catalog carries them in
 * `core-product-declarations-v1.json`: the hosts Core recognizes, its MCP
 * servers and controls, and its own hooks. Core is the authority for their
 * meaning; this is the only place that renders them for the Catalog, from the
 * same functions the runtime uses, so the Catalog never needs a hand refresh.
 */
export interface CoreProductDeclarationsSourceV1 {
  /** Exact release version, `MAJOR.MINOR.PATCH`. */
  version: string;
  /** Full lowercase commit the declarations were rendered at. */
  commit: string;
}

export interface CoreProductDeclarationsV1 {
  format: "aih-catalog-core-product-declarations";
  version: 1;
  source: { package: string; version: string; repository: string; commit: string };
  hosts: PolicyAuthoringHost[];
  mcp: PolicyAuthoringCatalog["mcp"];
  nonProjectableMcp: PolicyAuthoringCatalog["nonProjectableMcp"];
  unavailableMcp: PolicyAuthoringCatalog["unavailableMcp"];
  hooks: PolicyAuthoringHook[];
  hookRegistry: {
    entries: PolicyAuthoringHookRegistryEntry[];
    registrations: HookRegistration[];
    overlaps: ReturnType<typeof hookOverlaps>;
    spawnProjection: ReturnType<typeof hookSpawnProjection>;
  };
}

const LABEL = "Core product declarations";

/**
 * Every AIH-owned hook must state what it does before it can ship into the
 * authoring surface. Keyed by control id so a new hook fails closed here rather
 * than reaching an administrator as a bare identity.
 */
const AIH_HOOK_DISCLOSURES: Record<string, { description: string; behaviour: AihHookBehaviour }> = {
  "usage-metering": {
    description:
      "Appends one usage event per tool call so `aih track` can report this repository's agent activity.",
    behaviour: {
      trigger: "PostToolUse",
      records:
        "one JSON event per tool call — timestamp, CLI, kind (tool, mcp, skill or subagent), name, and a best-effort source",
      artifact: ".aih/usage.jsonl",
      failureMode: "Best-effort: a failure never blocks a commit or an agent turn",
    },
  },
};

/** AIH's own registrations, priced from the launcher that actually ships. */
function aihHookRegistrations(): HookRegistration[] {
  return [
    {
      id: "usage-metering",
      event: "PostToolUse",
      command: claudeUsageHookCommand(),
      functionTags: ["usage-metering"],
      // One process: AIH registers one composite entry per event.
      spawns: 1,
      owner: { kind: "aih" },
    },
  ];
}

function disclosure(id: string): { description: string; behaviour: AihHookBehaviour } {
  const found = AIH_HOOK_DISCLOSURES[id];
  if (found === undefined) throw new Error(`AIH hook ${id} ships without a behaviour disclosure`);
  return found;
}

function assertSource(source: CoreProductDeclarationsSourceV1): void {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(source.version))
    throw new Error(
      `${LABEL} require an exact release version, got ${JSON.stringify(source.version)}`,
    );
  if (!/^[0-9a-f]{40}$/u.test(source.commit))
    throw new Error(
      `${LABEL} require a full lowercase commit, got ${JSON.stringify(source.commit)}`,
    );
}

/** Render Core's declarations for the named release and commit. */
export function coreProductDeclarationsV1(
  source: CoreProductDeclarationsSourceV1,
): CoreProductDeclarationsV1 {
  assertSource(source);
  const catalog = policyAuthoringMcpCatalog();
  const controls = aihPolicyControls(catalog);
  const mcp = Object.entries(catalog).flatMap(([id, server]) => {
    const control = controls.find(
      (candidate): candidate is AihPolicyControl => candidate.kind === "mcp" && candidate.id === id,
    );
    return control === undefined
      ? []
      : [
          {
            id,
            description: server.description,
            server,
            control,
            availability: id === "playwright" ? ("web-target" as const) : ("always" as const),
          },
        ];
  });
  const hooks = controls
    .filter((control): control is AihHookControl => control.source.type === "hook")
    .map((control) => ({ id: control.id, ...disclosure(control.id), control }));
  const registrations = aihHookRegistrations();
  return {
    format: "aih-catalog-core-product-declarations",
    version: 1,
    source: {
      package: PACKAGE_NAME,
      version: source.version,
      repository: REPO,
      commit: source.commit,
    },
    hosts: policyAuthoringHosts(),
    mcp,
    nonProjectableMcp: policyAuthoringNonProjectableMcpCatalog(catalog),
    unavailableMcp: policyAuthoringUnavailableMcpCatalog(),
    hooks,
    hookRegistry: {
      entries: Object.entries(AIH_HOOK_DISCLOSURES).map(([id, { description }]) => ({
        id,
        owner: "aih" as const,
        ownerLabel: "AIH",
        source: "AIH",
        description,
        enforcement: "aih-enforced" as const,
        selectable: true as const,
      })),
      registrations,
      overlaps: hookOverlaps(registrations),
      spawnProjection: hookSpawnProjection(registrations),
    },
  };
}

/** Plain JSON with every object's keys in code-unit order; anything else is refused. */
function sortedJson(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${LABEL}: ${path} is not a finite number`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => sortedJson(item, `${path}[${index}]`));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          if (record[key] === undefined) throw new Error(`${LABEL}: ${path}.${key} is undefined`);
          return [key, sortedJson(record[key], `${path}.${key}`)];
        }),
    );
  }
  throw new Error(`${LABEL}: ${path} is not plain JSON`);
}

/**
 * The exact bytes of `core-product-declarations-v1.json`: the envelope, `source`
 * and `hookRegistry` keep their declared order, every record inside is written
 * with sorted keys, as two-space JSON followed by one newline.
 */
export function coreProductDeclarationsV1Bytes(
  source: CoreProductDeclarationsSourceV1,
): Uint8Array {
  const declarations = coreProductDeclarationsV1(source);
  const envelope = {
    format: declarations.format,
    version: declarations.version,
    source: {
      package: declarations.source.package,
      version: declarations.source.version,
      repository: declarations.source.repository,
      commit: declarations.source.commit,
    },
    hosts: sortedJson(declarations.hosts, "hosts"),
    mcp: sortedJson(declarations.mcp, "mcp"),
    nonProjectableMcp: sortedJson(declarations.nonProjectableMcp, "nonProjectableMcp"),
    unavailableMcp: sortedJson(declarations.unavailableMcp, "unavailableMcp"),
    hooks: sortedJson(declarations.hooks, "hooks"),
    hookRegistry: {
      entries: sortedJson(declarations.hookRegistry.entries, "hookRegistry.entries"),
      registrations: sortedJson(
        declarations.hookRegistry.registrations,
        "hookRegistry.registrations",
      ),
      overlaps: sortedJson(declarations.hookRegistry.overlaps, "hookRegistry.overlaps"),
      spawnProjection: sortedJson(
        declarations.hookRegistry.spawnProjection,
        "hookRegistry.spawnProjection",
      ),
    },
  };
  return new TextEncoder().encode(`${JSON.stringify(envelope, null, 2)}\n`);
}
