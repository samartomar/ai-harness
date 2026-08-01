import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { AIH_CONFIG_FILE, readAihConfig } from "../config/marker.js";
import { bootloadersFor, entry, REGISTRY_IDS } from "../internals/cli-registry.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readIfExists, readRegularFile } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  remove,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import {
  MANAGED_MCP_PROJECTION_KEYS,
  MANAGED_SETTINGS_PATH,
  type ManagedMcpProjectionResidue,
  managedMcpProjectionOnDisk,
  managedMcpSubtractionAction,
  unprovableResidueReason,
} from "../mcp/managed-projection.js";
import { isExternalMcp } from "../mcp/render.js";
import { parseTrustLockSource, TRUST_LOCK_FILE, type TrustLockSource } from "../trust/lock.js";

type UninstallDisposition = "backup" | "subtract" | "advisory";

interface UninstallArtifact {
  path: string;
  kind:
    | "context-dir"
    | "marker"
    | "mcp"
    | "cache"
    | "bootloader"
    | "kiro-steering"
    | "kiro-hook"
    | "managed-settings";
  disposition: UninstallDisposition;
  reason: string;
}

interface UninstallSet {
  artifacts: UninstallArtifact[];
  /**
   * Content whose ownership ONLY the marker proves. Uninstall removes that marker,
   * so this must be reconciled — or reported as about to become unattributable —
   * BEFORE the marker goes (issue #567).
   */
  managedMcp?: ManagedMcpProjectionResidue;
}

function cleanRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function removableContextDir(path: string): string | undefined {
  const rel = cleanRel(path);
  const parts = rel.split("/");
  if (
    rel.length === 0 ||
    rel === "." ||
    rel.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return undefined;
  }
  return rel;
}

function exists(ctx: PlanContext, relPath: string): boolean {
  return existsSync(join(ctx.root, relPath));
}

function read(ctx: PlanContext, relPath: string): string | undefined {
  return readIfExists(join(ctx.root, relPath));
}

function canonicalExistingRel(ctx: PlanContext, relPath: string): string | undefined {
  const parts = cleanRel(relPath).split("/");
  const actual: string[] = [];
  let current = ctx.root;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return undefined;
    }
    const entry =
      entries.find((name) => name === part) ??
      entries.find((name) => name.toLowerCase() === part.toLowerCase());
    if (entry === undefined) return undefined;
    actual.push(entry);
    current = join(current, entry);
  }
  const rel = actual.join("/");
  return exists(ctx, rel) ? rel : undefined;
}

function hasManagedContextEvidence(ctx: PlanContext, contextDir: string): boolean {
  const shared = read(ctx, `${contextDir}/adapters/_shared-canonical-block.md`);
  if (shared?.trim() !== sharedCanonicalBlockBody(contextDir).trim()) return false;
  return (
    read(ctx, `${contextDir}/RULE_ROUTER.md`) !== undefined &&
    read(ctx, `${contextDir}/rules/agent-behavior-core.md`) !== undefined
  );
}

function registeredConfigDirOwner(ctx: PlanContext, contextDir: string): string | undefined {
  const rel = cleanRel(contextDir);
  const contextIdentity = existingPathIdentity(ctx, rel);
  return REGISTRY_IDS.find((cli) =>
    entry(cli).configDirs.some((configDir) => {
      const registered = cleanRel(configDir);
      const registeredIdentity = existingPathIdentity(ctx, registered);
      if (contextIdentity !== undefined && registeredIdentity !== undefined) {
        return ctx.host.platform === "windows"
          ? contextIdentity.toLowerCase() === registeredIdentity.toLowerCase()
          : contextIdentity === registeredIdentity;
      }
      return ctx.host.platform === "windows"
        ? rel.toLowerCase() === registered.toLowerCase()
        : rel === registered;
    }),
  );
}

function existingPathIdentity(ctx: PlanContext, relPath: string): string | undefined {
  try {
    return realpathSync.native(join(ctx.root, relPath));
  } catch {
    return undefined;
  }
}

const CONTEXT_ARTIFACT_CANDIDATES = [
  "RULE_ROUTER.md",
  "adapters/_shared-canonical-block.md",
  "adapters/other-tools.md",
  "rules/agent-behavior-core.md",
  "REGENERATION.md",
  "harness-update.md",
  "project.md",
  "SETUP-TASKS.md",
  "VALIDATION.md",
  "guardrails-taxonomy.md",
  "command-policy.md",
  "risk-gates.json",
  "hardware-profile.txt",
  "mcp-fallback.md",
  "mcp-gateway-rbac.json",
  "repo-discipline.md",
  "workspace-router.md",
  "workspace-contracts.md",
  "workspace-lock.json",
  "telemetry/collector.yaml",
  "telemetry/fetch-analytics.mjs",
] as const;

// These are seeded by aih but are operator-owned or co-owned immediately: their
// writers either preserve the whole file after creation or merge operator keys.
// Existence alone can therefore never prove that the current file is safe cleanup.
const OPERATOR_CONTEXT_ARTIFACT_CANDIDATES = [
  "project.json",
  "setup.md",
  "INDEX.md",
  "architecture.md",
  "conventions.md",
  "tasks.md",
  "project-guardrails.md",
  "skills/example-skill/SKILL.md",
  "skill-cards/",
  "cross-repo-architecture.md",
] as const;

const FIXED_GENERATED_CLI_ARTIFACTS: Readonly<Record<string, readonly string[]>> = {
  cursor: [
    ".cursor/rules/01-stack.mdc",
    ".cursor/rules/02-node.mdc",
    ".cursor/rules/03-serverless.mdc",
    ".cursor/rules/03-efcore.mdc",
  ],
  opencode: [".opencode/plugins/aih-usage-metering.js"],
  kiro: [
    ".kiro/steering/agent-tools.md",
    ".kiro/steering/superpowers-methodology.md",
    ".kiro/hooks/aih-secret-scan-on-create.kiro.hook",
    ".kiro/hooks/aih-tests-on-edit.kiro.hook",
    ".kiro/hooks/aih-metrics-on-stop.kiro.hook",
    ".kiro/hooks/aih-quality-gate.kiro.hook",
    ".kiro/hooks/aih-usage-metering.kiro.hook",
  ],
};

const FIXED_COOWNED_CLI_ARTIFACTS: Readonly<Record<string, readonly string[]>> = {
  codex: [".codex/hooks.json"],
  cursor: [".cursor/hooks.json", ".cursor/mcp.json"],
  gemini: [".gemini/settings.json"],
  windsurf: [".windsurf/hooks.json"],
  kimi: [".kimi/config.toml"],
  kiro: [".kiro/settings/mcp.json"],
};

// Uninstall needs only enough bytes to prove an unchanged receipt hash. Refuse
// pathological files before allocation; an unproven file stays operator-owned.
const MAX_UNINSTALL_OWNERSHIP_FILE_BYTES = 64 * 1024 * 1024;

function hasUnsafeOwnershipParent(root: string, relPath: string): boolean {
  const parts = cleanRel(relPath).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function isContainedOwnershipFile(ctx: PlanContext, relPath: string): boolean {
  const inspected = inspectContainedRelativePath(ctx.root, relPath);
  return (
    inspected.state === "present" &&
    inspected.kind === "file" &&
    !hasUnsafeOwnershipParent(ctx.root, relPath)
  );
}

function readContainedOwnershipFile(ctx: PlanContext, relPath: string): Buffer | undefined {
  const before = inspectContainedRelativePath(ctx.root, relPath);
  if (
    before.state !== "present" ||
    before.kind !== "file" ||
    hasUnsafeOwnershipParent(ctx.root, relPath)
  ) {
    return undefined;
  }
  const bytes = readRegularFile(before.realPath, {
    maxBytes: MAX_UNINSTALL_OWNERSHIP_FILE_BYTES,
  });
  if (bytes === undefined || hasUnsafeOwnershipParent(ctx.root, relPath)) return undefined;
  const after = inspectContainedRelativePath(ctx.root, relPath);
  return after.state === "present" && after.kind === "file" && after.realPath === before.realPath
    ? bytes
    : undefined;
}

interface PromotedSkillRoute {
  skill: string;
  parts: string[];
}

interface PromotedRouteTrie {
  routes: PromotedSkillRoute[];
  children: Map<string, PromotedRouteTrie>;
}

interface PromotedSourceLayout {
  routes: PromotedSkillRoute[];
  routeTrie: PromotedRouteTrie;
  rootSkill?: string;
}

// GitHub acquisition promotes from `<quarantine>/tree`; unlike a local source,
// the lock's owner/repo origin does not preserve that filesystem basename.
const GITHUB_PROMOTION_ROOT_SKILL = "tree";

function promotedRouteTrie(routes: PromotedSkillRoute[]): PromotedRouteTrie {
  const root: PromotedRouteTrie = { routes: [], children: new Map() };
  for (const route of routes) {
    let node = root;
    for (const part of route.parts) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { routes: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.routes.push(route);
  }
  return root;
}

function matchingPromotedRoutes(
  routeTrie: PromotedRouteTrie,
  artifactPath: string,
): Array<{ route: PromotedSkillRoute; rel: string }> {
  const parts = artifactPath.split("/");
  const starts = [0];
  for (let index = 1; index <= parts.length - 2; index += 1) {
    if (parts[index - 1] === "skills") starts.push(index);
  }
  const matches = new Map<string, { route: PromotedSkillRoute; rel: string }>();
  for (const start of starts) {
    let node = routeTrie;
    for (let index = start; index < parts.length - 1; index += 1) {
      const child = node.children.get(parts[index] ?? "");
      if (child === undefined) break;
      node = child;
      for (const route of node.routes) {
        if (!matches.has(route.skill)) {
          matches.set(route.skill, { route, rel: parts.slice(index + 1).join("/") });
        }
      }
    }
  }
  return [...matches.values()];
}

function promotedSourceLayout(source: TrustLockSource): PromotedSourceLayout {
  const routes = [...new Set(source.promotedSkills)].map(
    (skill): PromotedSkillRoute => ({
      skill,
      parts: skill.split("/"),
    }),
  );
  const routeTrie = promotedRouteTrie(routes);
  // GitHub promotions originate at the fixed quarantine tree directory; the
  // lock's `source` is owner/repo and therefore cannot recover that basename.
  const sourceName =
    source.kind === "github"
      ? GITHUB_PROMOTION_ROOT_SKILL
      : cleanRel(source.source)
          .split("/")
          .at(-1)
          ?.replace(/\.git$/i, "");
  const receiptProvesSourceRoot = source.artifactHashes.some(
    (artifact) => artifact.path === "SKILL.md",
  );
  const explicitSourceRoot = receiptProvesSourceRoot
    ? routes.find((route) => route.skill === sourceName)?.skill
    : undefined;
  const prefixedSkills = new Set<string>();
  for (const artifact of source.artifactHashes) {
    for (const { route } of matchingPromotedRoutes(routeTrie, artifact.path)) {
      if (route.skill === explicitSourceRoot) continue;
      prefixedSkills.add(route.skill);
    }
  }
  const rootSkills = routes.filter((route) => !prefixedSkills.has(route.skill));
  return {
    routes,
    routeTrie,
    rootSkill: explicitSourceRoot ?? (rootSkills.length === 1 ? rootSkills[0]?.skill : undefined),
  };
}

function promotedArtifactTargets(
  contextDir: string,
  source: TrustLockSource,
  layout: PromotedSourceLayout,
  artifactPath: string,
): string[] {
  const targets = matchingPromotedRoutes(layout.routeTrie, artifactPath).flatMap(
    ({ route, rel }) => {
      if (route.skill === layout.rootSkill) return [];
      return [`${contextDir}/skills/${source.id}/${route.skill}/${rel}`];
    },
  );
  // A source-root skill has no source-path prefix: its receipts are `SKILL.md`,
  // README.md, or paths through nested skills. Promotion copies every such file
  // beneath the one promoted skill name not represented by a receipt prefix.
  // More than one unmatched name is ambiguous lock evidence, so claim neither.
  if (layout.rootSkill !== undefined) {
    targets.push(`${contextDir}/skills/${source.id}/${layout.rootSkill}/${artifactPath}`);
  }
  return [...new Set(targets)];
}

function promotedContextArtifacts(ctx: PlanContext, contextDir: string): string[] {
  const bytes = readContainedOwnershipFile(ctx, TRUST_LOCK_FILE);
  if (bytes === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  const rawSources =
    typeof parsed === "object" && parsed !== null && "sources" in parsed
      ? (parsed as { sources?: unknown }).sources
      : undefined;
  const sources = Array.isArray(rawSources)
    ? rawSources.flatMap((source) => {
        const parsedSource = parseTrustLockSource(source);
        return parsedSource === undefined ? [] : [parsedSource];
      })
    : [];
  const paths = sources.flatMap((source) => {
    const layout = promotedSourceLayout(source);
    return source.artifactHashes.flatMap((artifact) => {
      return promotedArtifactTargets(contextDir, source, layout, artifact.path).filter((target) => {
        const bytes = readContainedOwnershipFile(ctx, target);
        return (
          bytes !== undefined &&
          createHash("sha256").update(bytes).digest("hex") === artifact.sha256
        );
      });
    });
  });
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function coOwnedContextReason(ctx: PlanContext, contextDir: string, cli: string): string {
  const contextPrefix = `${cleanRel(contextDir)}/`;
  const fixedGenerated = (FIXED_GENERATED_CLI_ARTIFACTS[cli] ?? []).filter((path) =>
    path.startsWith(contextPrefix),
  );
  const generated = [
    ...CONTEXT_ARTIFACT_CANDIDATES.map((path) => `${contextDir}/${path}`),
    ...REGISTRY_IDS.map((target) => `${contextDir}/adapters/${target}.md`),
    ...fixedGenerated,
    ...promotedContextArtifacts(ctx, contextDir),
  ].filter((path) => isContainedOwnershipFile(ctx, path));
  const fixedCoOwned = (FIXED_COOWNED_CLI_ARTIFACTS[cli] ?? []).filter(
    (path) => path.startsWith(contextPrefix) && exists(ctx, path),
  );
  const operatorSiblings = [
    ...OPERATOR_CONTEXT_ARTIFACT_CANDIDATES.map((path) => `${contextDir}/${path}`)
      .filter((path) => exists(ctx, path))
      .map((path) => `${path} (seeded or merged; operator/co-owned)`),
    ...fixedCoOwned.map((path) => `${path} (merged tool-native config; co-owned)`),
    ...(cleanRel(contextDir) === ".claude"
      ? [
          `${contextDir}/settings.json`,
          `${contextDir}/agents/`,
          `${contextDir}/commands/`,
          `operator-owned content in ${contextDir}/managed-settings.json`,
        ]
      : []),
    ...(exists(ctx, `${contextDir}/crispy`)
      ? [`${contextDir}/crispy/ (co-owned CRISPY working notes)`]
      : []),
    `all other content under ${contextDir}/ not listed as aih-generated`,
  ];
  return [
    `co-owned ${entry(cli).label} config directory; aih leaves the complete directory in place`,
    `aih-generated context artifacts left for manual cleanup: ${generated.join(", ")}`,
    `operator-owned siblings left untouched: ${operatorSiblings.join(", ")}`,
  ].join("; ");
}

function bootloaderAdvisories(ctx: PlanContext): UninstallArtifact[] {
  return bootloadersFor(REGISTRY_IDS).flatMap((path): UninstallArtifact[] => {
    const text = read(ctx, path);
    if (text === undefined || extractManagedBlock(text, SHARED_MARKER) === undefined) return [];
    return [
      {
        path,
        kind: "bootloader",
        disposition: "advisory",
        reason: "co-owned bootloader still carries an aih managed block",
      },
    ];
  });
}

function repoMcpAdvisories(ctx: PlanContext): UninstallArtifact[] {
  const paths = new Set<string>();
  for (const cli of REGISTRY_IDS) {
    const configPath = entry(cli).mcp.configPath;
    if (configPath === undefined || isExternalMcp(configPath) || !exists(ctx, configPath)) {
      continue;
    }
    paths.add(configPath);
  }
  return [...paths].map((path) => ({
    path,
    kind: "mcp",
    disposition: "advisory",
    reason: "co-owned project MCP config; entries have no on-disk ownership marker",
  }));
}

function kiroHookFiles(ctx: PlanContext): string[] {
  try {
    return readdirSync(join(ctx.root, ".kiro", "hooks"))
      .filter((name) => name.startsWith("aih-") && name.endsWith(".kiro.hook"))
      .sort()
      .map((name) => `.kiro/hooks/${name}`);
  } catch {
    return [];
  }
}

function hasKiroOwnershipEvidence(ctx: PlanContext): boolean {
  const text = read(ctx, ".kiro/steering/00-canon.md");
  return text !== undefined && extractManagedBlock(text, SHARED_MARKER) !== undefined;
}

function kiroExtraArtifacts(ctx: PlanContext, owned: boolean): UninstallArtifact[] {
  const disposition = owned ? "backup" : "advisory";
  const ownership = owned
    ? "with marker-backed Kiro ownership evidence"
    : "found, but no valid Kiro target marker proves ownership";
  const artifacts: UninstallArtifact[] = [];
  if (exists(ctx, ".kiro/steering/agent-tools.md")) {
    artifacts.push({
      path: ".kiro/steering/agent-tools.md",
      kind: "kiro-steering",
      disposition,
      reason: `aih Kiro steering extra ${ownership}`,
    });
  }
  for (const hook of kiroHookFiles(ctx)) {
    artifacts.push({
      path: hook,
      kind: "kiro-hook",
      disposition,
      reason: `aih-namespaced Kiro hook ${ownership}`,
    });
  }
  return artifacts;
}

/** Repo-relative paths this run would remove wholesale (directories included). */
function removedTrees(artifacts: readonly UninstallArtifact[]): string[] {
  return artifacts.filter((a) => a.disposition === "backup").map((a) => cleanRel(a.path));
}

/**
 * True when `path` IS `tree` or lives beneath it — segment-wise, never a substring.
 *
 * Both sides are resolved through {@link canonicalExistingRel} first, so the compare is
 * EXACT rather than case-folded. `canonicalExistingRel` walks the real directory
 * entries and prefers an exact-case match before falling back to a case-insensitive
 * one, which gets both filesystems right: on a case-insensitive one a `.CLAUDE` tree
 * and `.claude/managed-settings.json` resolve to the same casing and match, while on a
 * case-sensitive one where BOTH exist they resolve distinctly and do not — so a blunt
 * `toLowerCase()` compare would have suppressed a real subtraction there.
 */
function isUnderTree(ctx: PlanContext, path: string, tree: string): boolean {
  const a = canonicalExistingRel(ctx, path) ?? cleanRel(path);
  const b = canonicalExistingRel(ctx, tree) ?? cleanRel(tree);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * The managed-MCP artifact, if any. The projected `.claude/managed-settings.json`
 * is not in the registered per-CLI artifact set, so nothing else here would ever
 * look at it — yet the marker uninstall is about to remove is the ONLY record of
 * which of its keys aih wrote. Exact match → subtract those two keys. Anything
 * else → report what is about to become unattributable, and touch nothing.
 */
function managedMcpArtifact(residue: ManagedMcpProjectionResidue): UninstallArtifact {
  if (residue.matches) {
    return {
      path: residue.path,
      kind: "managed-settings",
      disposition: "subtract",
      reason: `marker-proven aih managed-MCP keys (${MANAGED_MCP_PROJECTION_KEYS.join(", ")}); every other key is preserved`,
    };
  }
  return {
    path: residue.path,
    kind: "managed-settings",
    disposition: "advisory",
    reason: `aih managed-MCP residue becomes unattributable once the marker is removed — ${unprovableResidueReason(residue.unprovable ?? "pair-drifted")}`,
  };
}

function coreUninstallSet(ctx: PlanContext): UninstallSet {
  const marker = readAihConfig(ctx.root);
  const markerTargets = new Set((marker?.targets ?? []).map((target) => target.toLowerCase()));
  const markerContextDir = marker ? removableContextDir(marker.contextDir) : undefined;
  const artifacts: UninstallArtifact[] = [];
  let ownsContextDir = false;

  if (markerContextDir !== undefined) {
    const contextDir = canonicalExistingRel(ctx, markerContextDir);
    if (contextDir !== undefined && hasManagedContextEvidence(ctx, contextDir)) {
      ownsContextDir = true;
      const configOwner = registeredConfigDirOwner(ctx, contextDir);
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: configOwner === undefined ? "backup" : "advisory",
        reason:
          configOwner === undefined
            ? "aih-managed canon/context tree with marker-backed ownership evidence"
            : coOwnedContextReason(ctx, contextDir, configOwner),
      });
    } else if (contextDir !== undefined) {
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: "advisory",
        reason: "valid marker points here, but generated canon evidence is missing",
      });
    }
  } else {
    const fallbackContextDir = removableContextDir(ctx.contextDir);
    const contextDir =
      fallbackContextDir !== undefined ? canonicalExistingRel(ctx, fallbackContextDir) : undefined;
    if (contextDir !== undefined && hasManagedContextEvidence(ctx, contextDir)) {
      artifacts.push({
        path: contextDir,
        kind: "context-dir",
        disposition: "advisory",
        reason: "aih-looking context tree found, but no valid root install marker proves ownership",
      });
    }
  }

  // Marker-proven content comes BEFORE the marker itself, in the artifact list and
  // in the plan: once `.aih-config.json` is gone nothing can attribute these keys
  // again (issue #567). An absent/malformed/revoked/hash-invalid marker yields no
  // residue at all — there was never a provable claim to reconcile.
  //
  // Skipped entirely when the projected file sits INSIDE a tree this run already
  // removes — a repo bootstrapped with `--context-dir .claude` is the real case.
  // Subtracting two keys from a file that is about to be moved wholesale is at best
  // futile and at worst a false promise in the preview ("every other key is
  // preserved" while the whole directory goes to backup).
  const managedMcp = removedTrees(artifacts).some((tree) =>
    isUnderTree(ctx, MANAGED_SETTINGS_PATH, tree),
  )
    ? undefined
    : managedMcpProjectionOnDisk(ctx.root);
  if (managedMcp !== undefined && managedMcp.unprovable !== "settings-absent") {
    artifacts.push(managedMcpArtifact(managedMcp));
  }

  if (exists(ctx, AIH_CONFIG_FILE)) {
    artifacts.push({
      path: AIH_CONFIG_FILE,
      kind: "marker",
      disposition: "backup",
      reason: "committed aih install marker",
    });
  }
  artifacts.push(...repoMcpAdvisories(ctx));
  artifacts.push(...bootloaderAdvisories(ctx));
  artifacts.push(
    ...kiroExtraArtifacts(ctx, markerTargets.has("kiro") && hasKiroOwnershipEvidence(ctx)),
  );

  if (exists(ctx, ".aih") && ownsContextDir) {
    artifacts.push({
      path: ".aih",
      kind: "cache",
      disposition: "backup",
      reason: "aih cache/output directory with marker-backed ownership evidence",
    });
  } else if (exists(ctx, ".aih")) {
    artifacts.push({
      path: ".aih",
      kind: "cache",
      disposition: "advisory",
      reason:
        "aih-looking cache/output directory found, but no valid root install marker proves ownership",
    });
  }

  return { artifacts, ...(managedMcp === undefined ? {} : { managedMcp }) };
}

function body(set: UninstallSet): string {
  if (set.artifacts.length === 0) {
    return "No aih core install footprint found.";
  }
  const owned = set.artifacts.filter((a) => a.disposition !== "advisory");
  const advisory = set.artifacts.filter((a) => a.disposition === "advisory");
  return lines(
    "Core install footprint preview:",
    ...owned.map((a) => `  [${a.disposition}] ${a.path} - ${a.reason}`),
    ...(advisory.length > 0
      ? [
          "",
          "Manual review - co-owned files are never auto-removed:",
          ...advisory.map((a) => `  [advisory] ${a.path} - ${a.reason}`),
        ]
      : []),
    "",
    "Dry-run by default; pass --apply to move owned paths to reversible *.aih.bak backups.",
    ...(set.artifacts.some((a) => a.disposition === "subtract")
      ? ["Keys marked [subtract] are removed in place; their file is never deleted."]
      : []),
  );
}

function uninstallPlan(ctx: PlanContext): Plan {
  const set = coreUninstallSet(ctx);
  const actions: Action[] = [];
  // Owned content whose ownership only the marker proves is subtracted FIRST — the
  // established owned-content -> ownership-state -> ledger-last order
  // (`src/ecc/reconcile-driver.ts:485`, `:511`, `:514`). The executor stages this
  // write and the removals below in ONE transaction (writes commit before removals,
  // and a failure rolls both back), so an interrupted uninstall can never leave a
  // removed marker beside unsubtracted content. Clearing the marker's ownership
  // record is unnecessary here: the whole marker is being removed.
  if (set.managedMcp?.matches === true) {
    actions.push(
      managedMcpSubtractionAction(
        set.managedMcp,
        "subtract the aih-owned Claude managed-MCP keys before removing the ownership marker",
      ),
    );
  }
  for (const artifact of set.artifacts) {
    if (artifact.disposition !== "backup") continue;
    actions.push(remove(artifact.path, artifact.reason, { hardDelete: true }));
  }
  actions.push(digest("core install footprint", body(set), set));
  return plan("uninstall", ...actions);
}

export const command: CommandSpec = {
  name: "uninstall",
  aliases: ["clean"],
  summary: "Remove the core aih install footprint from this repo (dry-run by default)",
  plan: uninstallPlan,
};
