/** Exact pinned sources for ECC hook-profile and per-hook-disable semantics. */
export const ECC_HOOK_CONTROL_PROVENANCE = {
  repository: "affaan-m/ECC",
  commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
  sources: [
    {
      path: "hooks/hooks.json",
      sha256: "57d7e373deb8551169db88b5b6bc473c972177e496b682c8274d56af16aa882f",
    },
    {
      path: "scripts/hooks/session-start-bootstrap.js",
      sha256: "48f949ebc4ab83a9e8d3b6bee91bb201511046a8c504f53f8d1e48e29f03bc0d",
    },
    {
      path: "scripts/hooks/bash-hook-dispatcher.js",
      sha256: "b6e4163536d8092b63cfca205372d699f38550d6dd0fe2e74abde2f029f6ecbe",
    },
    {
      path: "scripts/hooks/posttooluse-dispatcher.js",
      sha256: "79b841ca3106ea891dc7df22faa2e6fb8b20ec8fbc8a33407f745cade2d1765c",
    },
    {
      path: "scripts/hooks/run-with-flags.js",
      sha256: "0f13516dbc51e6443c504d5f84cc531dae35b1eba7b993b6427207c224fd0e2f",
    },
    {
      path: "scripts/lib/hook-flags.js",
      sha256: "16f5288b4e242d5bbbfc98c5ffc331ac8699049d616be136086363baaba9c294",
    },
  ],
  /**
   * SHA-256 of JSON.stringify(sources.map(({ path, sha256 }) => [path, sha256])).
   * This binds the reviewed inventory and the runtime flag grammar together.
   */
  contentSha256: "1aef3f95cb5e91c0248998c26889c1a7806ecee76d10e8338107a849963cd7eb",
} as const;

export const ECC_HOOK_CONTROL_SOURCE_CONTENT_SHA256 = ECC_HOOK_CONTROL_PROVENANCE.contentSha256;

export const ECC_HOOK_PROFILES = [
  { id: "minimal", label: "Minimal" },
  { id: "standard", label: "Standard" },
  { id: "strict", label: "Strict" },
] as const;

export type EccHookProfile = (typeof ECC_HOOK_PROFILES)[number]["id"];

export interface EccHookControlsSelection {
  profile: EccHookProfile;
  disabledIds?: readonly string[];
}

export interface EccHookControlCatalogEntry {
  id: string;
  event: string;
  profiles: readonly EccHookProfile[];
  /** False only for the outer Bash wrapper whose children own the actual gates. */
  disableEligible: boolean;
}

const ALL: readonly EccHookProfile[] = ["minimal", "standard", "strict"];
const STANDARD_STRICT: readonly EccHookProfile[] = ["standard", "strict"];
const STRICT: readonly EccHookProfile[] = ["strict"];

/**
 * Source order: non-gated wrapper, manifest/bootstrap gates, Bash dispatcher
 * gates, then PostToolUse dispatcher gates. AIH never contacts or executes ECC
 * to build this browser inventory.
 */
export const eccHookControlCatalog: readonly EccHookControlCatalogEntry[] = [
  { id: "pre:bash:dispatcher", event: "PreToolUse", profiles: ALL, disableEligible: false },
  {
    id: "pre:write:doc-file-warning",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "pre:edit-write:suggest-compact",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "pre:observe", event: "PreToolUse", profiles: STANDARD_STRICT, disableEligible: true },
  {
    id: "pre:governance-capture",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "pre:config-protection",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "pre:mcp-health-check",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "pre:edit-write:gateguard-fact-force",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "pre:compact", event: "PreCompact", profiles: STANDARD_STRICT, disableEligible: true },
  { id: "session:start", event: "SessionStart", profiles: ALL, disableEligible: true },
  {
    id: "session-start:plan-canvas-sessions",
    event: "SessionStart",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "post:dispatcher:sync", event: "PostToolUse", profiles: ALL, disableEligible: true },
  { id: "post:dispatcher:async", event: "PostToolUse", profiles: ALL, disableEligible: true },
  {
    id: "post:mcp-health-check",
    event: "PostToolUseFailure",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "stop:format-typecheck",
    event: "Stop",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "stop:check-console-log",
    event: "Stop",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "stop:session-end", event: "Stop", profiles: ALL, disableEligible: true },
  { id: "stop:evaluate-session", event: "Stop", profiles: ALL, disableEligible: true },
  { id: "stop:cost-tracker", event: "Stop", profiles: ALL, disableEligible: true },
  {
    id: "stop:desktop-notify",
    event: "Stop",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "session:end:marker", event: "SessionEnd", profiles: ALL, disableEligible: true },
  { id: "pre:bash:block-no-verify", event: "PreToolUse", profiles: ALL, disableEligible: true },
  {
    id: "pre:bash:auto-tmux-dev",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "pre:bash:tmux-reminder", event: "PreToolUse", profiles: STRICT, disableEligible: true },
  {
    id: "pre:bash:git-push-reminder",
    event: "PreToolUse",
    profiles: STRICT,
    disableEligible: true,
  },
  { id: "pre:bash:commit-quality", event: "PreToolUse", profiles: STRICT, disableEligible: true },
  {
    id: "pre:bash:gateguard-fact-force",
    event: "PreToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:bash:command-log-audit",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:bash:command-log-cost",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:bash:pr-created",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:bash:build-complete",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:edit:design-quality-check",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:edit:accumulator",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:edit:console-warn",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:governance-capture",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:session-activity-tracker",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "post:ecc-metrics-bridge", event: "PostToolUse", profiles: ALL, disableEligible: true },
  {
    id: "post:ecc-context-monitor",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  { id: "post:bash:dispatcher", event: "PostToolUse", profiles: ALL, disableEligible: true },
  {
    id: "post:quality-gate",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
  {
    id: "post:observe:continuous-learning",
    event: "PostToolUse",
    profiles: STANDARD_STRICT,
    disableEligible: true,
  },
] as const;

export const ECC_DISABLE_ELIGIBLE_HOOK_IDS = eccHookControlCatalog
  .filter((hook) => hook.disableEligible)
  .map((hook) => hook.id);

const BY_ID = new Map(eccHookControlCatalog.map((hook) => [hook.id, hook] as const));

function invalid(message: string): never {
  throw new Error(`invalid ECC hook control inventory: ${message}`);
}

const uniqueIds = new Set(eccHookControlCatalog.map((hook) => hook.id));
const eligible = eccHookControlCatalog.filter((hook) => hook.disableEligible);
if (
  eccHookControlCatalog.length !== 41 ||
  uniqueIds.size !== 41 ||
  eligible.length !== 40 ||
  eligible.filter((hook) => hook.profiles.includes("minimal")).length !== 10 ||
  eligible.filter((hook) => hook.profiles.includes("standard")).length !== 37 ||
  eligible.filter((hook) => hook.profiles.includes("strict")).length !== 40
) {
  invalid(
    "the pinned inventory must contain 41 distinct rows, 40 gated ids, and 10/37/40 profile eligibility",
  );
}

/** Validate and return ids in pinned source order. */
export function canonicalEccDisabledHookIds(
  ids: readonly string[],
  profile: EccHookProfile,
): string[] {
  if (new Set(ids).size !== ids.length) {
    throw new Error("ECC disabled hook ids must be unique");
  }
  const requested = new Set(ids);
  for (const id of ids) {
    const hook = BY_ID.get(id);
    if (hook === undefined) throw new Error(`ECC hook ${id} is not in the pinned inventory`);
    if (!hook.disableEligible) {
      throw new Error(`ECC hook ${id} is a wrapper, not an individually disable-eligible hook`);
    }
    if (!hook.profiles.includes(profile)) {
      throw new Error(`ECC hook ${id} is not eligible under the ${profile} profile`);
    }
  }
  return ECC_DISABLE_ELIGIBLE_HOOK_IDS.filter((id) => requested.has(id));
}
