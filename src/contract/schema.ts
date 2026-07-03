import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";

/**
 * `project.json` — the machine-readable repo contract. It is the SEAM between the
 * synthesizer (Phase 1, its sole writer) and every downstream consumer (Phase 2
 * report/hooks/governance, which only READ it). Unlike `.aih-config.json` (the
 * committed bootstrap-intent marker at the repo ROOT — see {@link ../config/marker}),
 * the contract lives UNDER the context dir, is RE-DERIVED from the live tree on every
 * run, and records the synthesized stack/commands/scale/gaps a fresh agent needs to
 * make its first diff correct. The two are siblings with different lifecycles.
 *
 * Schema discipline (the §5 additive seam): every field is optional-with-default or
 * plainly optional, so an OLD committed contract still parses after the schema grows
 * and a MISSING contract degrades to omitted panels — never a fabricated metric. A
 * Phase-2 change may ADD optional fields; it may never add a required field or a
 * second writer.
 */
export const PROJECT_CONTRACT_FILE = "project.json";
/** The human-readable mirror, rendered from {@link PROJECT_CONTRACT_FILE} every run. */
export const PROJECT_DOC_FILE = "project.md";
/** The write-once first-run setup seed a team owns. */
export const SETUP_DOC_FILE = "setup.md";

/**
 * How sure we are a command is the right one to run.
 *  - `verified` — actually executed (exit 0). DEFERRED to Phase 2 (2E); never emitted
 *                 in Phase 1, but kept in the enum so 2E adds it without a schema bump.
 *  - `detected` — the repo DECLARES it (an explicit `package.json` script).
 *  - `inferred` — derived from a dependency, a linter config file, or a language
 *                 default — plausible, but unconfirmed (surfaced as a `knownGap`).
 */
const ConfidenceSchema = z.enum(["verified", "detected", "inferred"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** A canonical command plus the confidence tier behind it (never a bare string). */
const CommandSchema = z.object({ value: z.string(), confidence: ConfidenceSchema });
const CommandsSchema = z
  .object({
    test: CommandSchema.optional(),
    build: CommandSchema.optional(),
    lint: CommandSchema.optional(),
    start: CommandSchema.optional(),
    cdkSynth: CommandSchema.optional(),
    cdkDiff: CommandSchema.optional(),
    cdkDeploy: CommandSchema.optional(),
  })
  .default({});

const WorkspaceContractSchema = z.object({
  languages: z.array(z.string()).default([]),
  packageManager: z.string().optional(),
  commands: CommandsSchema,
});

/**
 * Coarse repo-size bucket, derived purely from the tracked-file count (+ a monorepo
 * floor). `unknown` when the count is unavailable (not a git repo) — distinct from a
 * genuine `small`, so a consumer never reads "0 files" as "tiny repo".
 */
const ScaleClassSchema = z.enum(["small", "medium", "large", "unknown"]);
export type ScaleClass = z.infer<typeof ScaleClassSchema>;

const McpServerLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/);

export const ProjectContractSchema = z.object({
  schemaVersion: z.literal(1),
  /** The canonical context dir this contract lives under (echoes `ctx.contextDir`). */
  contextDir: z.string(),
  /** Resolved CLI targets at synthesis time (defaulted so a partial contract parses). */
  targets: z.array(z.string()).default([]),
  /** One-line repo description (from `package.json`), when the stack carries one. */
  description: z.string().optional(),
  languages: z.array(z.string()).default([]),
  frameworks: z.array(z.string()).default([]),
  cloud: z.array(z.string()).default([]),
  databases: z.array(z.string()).default([]),
  deployment: z.array(z.string()).default([]),
  packageManager: z.string().optional(),
  /** Notable entry points (repo-relative POSIX; validated portable by the probe). */
  entrypoints: z.array(z.string()).default([]),
  /** MCP servers declared in the repo's root .mcp.json, if present. */
  mcpServers: z.array(McpServerLabelSchema).default([]),
  /** The canonical commands, each tagged with its confidence; absent keys are omitted. */
  commands: CommandsSchema,
  /**
   * Per-workspace facts for polyglot/monorepo packages, keyed by repo-relative POSIX
   * workspace path. Optional/additive so older contracts continue to parse.
   */
  workspaces: z.record(z.string(), WorkspaceContractSchema).optional(),
  scale: z.object({
    /** Tracked-file count from `git ls-files`; omitted when the root is not a git repo. */
    trackedFiles: z.number().int().nonnegative().optional(),
    class: ScaleClassSchema,
    isMonorepo: z.boolean(),
  }),
  /**
   * Value-blind paths of on-disk secret material (`.env` files, a root `secrets/`
   * dir) — path + presence only, NEVER a value. Mirrors the `Read(./.env*)` deny set.
   */
  sensitivePaths: z.array(z.string()).default([]),
  /**
   * Honest, actionable gaps the next agent should close before trusting the contract:
   * un-imported CLI canon, legacy scripts to retire, inferred (unconfirmed) commands.
   */
  knownGaps: z.array(z.string()).default([]),
});

export type ProjectContract = z.infer<typeof ProjectContractSchema>;

/**
 * Read the committed contract from `<root>/<contextDir>/project.json`, or `undefined`
 * when it is absent, unreadable, or fails validation. Fail-SOFT by design (like
 * {@link readAihConfig}, unlike fail-closed settings): a malformed contract must never
 * break a consumer — Phase-2 panels degrade to omitted, never to a fabricated metric.
 */
export function readProjectContract(root: string, contextDir: string): ProjectContract | undefined {
  const raw = readIfExists(join(root, contextDir, PROJECT_CONTRACT_FILE));
  if (raw === undefined) return undefined;
  try {
    return ProjectContractSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Validate a synthesized contract through the schema before it is written — the seam's
 * one guarantee: only a schema-valid contract is ever persisted (and key order is
 * normalized to the schema's, so the JSON is stable). Throws on a synthesizer bug
 * rather than writing a contract a reader would later reject.
 */
export function projectContractJson(contract: ProjectContract): ProjectContract {
  return ProjectContractSchema.parse(contract);
}
