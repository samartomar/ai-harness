import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../../internals/merge.js";
import { CLAUDE_MCP_KEY, ClaudeHostWriteError } from "./surfaces.js";

/**
 * W3e: context-cost inventory for the Claude host binding.
 *
 * Per the Project Framework Binding v1 plan, every binding carries a
 * context-cost inventory "with a defined evidence source per adapter
 * (host-reported projections such as `claude plugin details` where
 * available; AIH estimates labeled as estimates elsewhere)". The Framework
 * Card (W7) surfaces this as "context-cost estimate at session start
 * (labeled estimate, with its evidence source)" — this module produces the
 * {@link ContextCostReport} that data comes from, via exactly two entry points:
 *
 *  - {@link contextCostFromPluginDetails} — HOST-REPORTED. Parses an already
 *    fetched `claude plugin details --json` payload (the W3b `pluginDetails`
 *    wrapper in `./plugins.ts` invokes the CLI; this module never shells out
 *    itself). Tolerant of absent sections (they count as zero) but fails
 *    closed on a payload with no recognizable shape at all, and NEVER invents
 *    a token number the host did not report.
 *  - {@link estimateContextCostFromTree} — AIH-ESTIMATE. Walks a framework
 *    tree on disk (a scanned checkout or an installed surface dir) and
 *    derives a labeled, deterministic estimate from file counts and byte
 *    sizes — no tokenizer, no network, no magic numbers beyond the
 *    documented bytes/4 divisor.
 *
 * Both paths return the SAME {@link ContextCostReport} shape so a caller (or
 * the Framework Card renderer) never has to branch on which adapter produced
 * it — only on `source`/`estimate` to label it correctly.
 */

export type ContextCostEvidenceSource = "host-reported" | "aih-estimate";

export interface ContextCostReport {
  source: ContextCostEvidenceSource;
  /** Non-authoritative human label, e.g. "claude plugin details" or "aih static tree estimate". */
  evidence: string;
  /** Projected session-start token cost; undefined when the evidence source cannot provide one. */
  projectedTokens?: number;
  /** Counted surfaces feeding the projection. */
  counts: {
    skills: number;
    agents: number;
    commands: number;
    rules: number;
    hooks: number;
    mcpServers: number;
  };
  /** Total bytes of the counted surface files (estimate basis). */
  totalBytes: number;
  /** True when numbers are AIH estimates rather than host-reported. */
  estimate: boolean;
}

// -- Host-reported path: `claude plugin details --json` ----------------------

/**
 * Host-reported context cost: parse a `claude plugin details --json` payload
 * (already fetched by the caller via the W3b `pluginDetails` wrapper — this
 * function never invokes the CLI itself). The exact 2.1.214 payload field
 * paths are pinned during W4's real-VM runs; parsing here stays intentionally
 * tolerant (every section independently optional) so that run only needs to
 * adjust field paths, not this function's control flow.
 *
 * Tolerant-but-typed: every `components.*` section and `projectedTokens` may
 * be absent (absence counts as zero / `undefined`), but the payload as a
 * whole must carry at least one recognizable field (`components` or
 * `projectedTokens`) — a payload with neither is refused rather than silently
 * reported as an all-zero cost. A present field with the wrong shape (e.g. a
 * non-array `components.skills`, or a non-numeric `projectedTokens.total`)
 * fails closed the same way: this function never fabricates a token number or
 * silently coerces a malformed field into zero.
 *
 * `counts.rules` is always `0` here — a Claude plugin's `details` payload has
 * no "rules" concept (that is an AIH/framework-tree surface); only
 * {@link estimateContextCostFromTree} ever counts rules.
 */
export function contextCostFromPluginDetails(payload: unknown): ContextCostReport {
  if (!isPlainObject(payload)) {
    throw new ClaudeHostWriteError("unrecognized plugin details payload — expected a JSON object");
  }
  if (payload.components === undefined && payload.projectedTokens === undefined) {
    throw new ClaudeHostWriteError(
      "unrecognized plugin details payload — expected a components map and/or a projectedTokens field",
    );
  }

  const componentsValue = payload.components;
  if (componentsValue !== undefined && !isPlainObject(componentsValue)) {
    throw new ClaudeHostWriteError(
      'unrecognized plugin details payload — "components" must be an object',
    );
  }
  const components = isPlainObject(componentsValue) ? componentsValue : undefined;

  return {
    source: "host-reported",
    evidence: "claude plugin details",
    projectedTokens: projectedTokensFromPayload(payload.projectedTokens),
    counts: {
      skills: componentArrayLength(components, "skills"),
      agents: componentArrayLength(components, "agents"),
      commands: componentArrayLength(components, "commands"),
      rules: 0,
      hooks: componentArrayLength(components, "hooks"),
      mcpServers: componentArrayLength(components, "mcpServers"),
    },
    totalBytes: 0,
    estimate: false,
  };
}

/** One `components.<key>` section: absent -> 0; present -> its array length; anything else -> fail closed. */
function componentArrayLength(
  components: Record<string, unknown> | undefined,
  key: string,
): number {
  if (components === undefined) return 0;
  const value = components[key];
  if (value === undefined) return 0;
  if (!Array.isArray(value)) {
    throw new ClaudeHostWriteError(
      `unrecognized plugin details payload — "components.${key}" must be an array`,
    );
  }
  return value.length;
}

/** `projectedTokens` as a bare number or `{ total }`; absent (either form) -> undefined, never fabricated. */
function projectedTokensFromPayload(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ClaudeHostWriteError(
        "unrecognized plugin details payload — projectedTokens must be a finite number",
      );
    }
    return value;
  }
  if (isPlainObject(value)) {
    const total = value.total;
    if (total === undefined) return undefined;
    if (typeof total !== "number" || !Number.isFinite(total)) {
      throw new ClaudeHostWriteError(
        "unrecognized plugin details payload — projectedTokens.total must be a finite number",
      );
    }
    return total;
  }
  throw new ClaudeHostWriteError(
    "unrecognized plugin details payload — projectedTokens must be a number or { total }",
  );
}

// -- AIH-estimate path: static tree walk --------------------------------------

/** Heuristic: ~4 chars/token for mostly-ASCII markdown/JSON. A rough estimate, not a tokenizer. */
const CHARS_PER_TOKEN = 4;

/**
 * AIH-estimate context cost: walk `treePath` (a scanned framework checkout or
 * an installed surface dir) and derive a deterministic, labeled estimate.
 * Fails closed ({@link ClaudeHostWriteError}) when `treePath` is not a
 * directory; every SURFACE within it is independently optional (a missing
 * `agents/`, `commands/`, `rules/`, `skills/`, `hooks/hooks.json`, or
 * `.mcp.json`/`mcp.json` counts as zero, not an error) — but a surface file
 * that EXISTS and does not parse/shape as expected fails closed, because a
 * write-path-style silent default here would silently miscount the one
 * estimate this function is the source of truth for.
 *
 * Heuristics (deterministic; no tokenizer, no network, no magic beyond the
 * documented bytes/4 divisor):
 *  - skills: `skills/<name>/SKILL.md` (nested layout) UNION top-level
 *    `<name>/SKILL.md` (the tree itself IS a skills collection, e.g. an
 *    installed `.claude/skills/` dir) — one counted skill per matching dir.
 *  - agents: immediate `agents/*.md` files (one level, not recursive).
 *  - commands: immediate `commands/*.md` files (one level, not recursive).
 *  - rules: every `.md` file anywhere under `rules/` (recursive — nested rule
 *    dirs count as files, matching a `rules/**\/*.md` glob).
 *  - hooks: `hooks/hooks.json`, summing hook-entry ARRAY LENGTHS across every
 *    top-level event key (a `{"PreToolUse": [...], "PostToolUse": [...]}`
 *    shape) — absent file -> 0; present-but-unparsable or a non-array event
 *    value -> fail closed.
 *  - mcpServers: `.mcp.json` (checked first) or `mcp.json`, counting the keys
 *    of the top-level `mcpServers` map — absent file -> 0; present-but-
 *    unparsable, or `mcpServers` present-but-not-an-object -> fail closed.
 *
 * `totalBytes` is the byte sum of every counted file (every counted
 * SKILL.md/agent/command/rule file, plus the whole `hooks.json`/mcp file when
 * present) — the estimate basis `projectedTokens` derives from via the
 * standard rough chars-per-token divisor (`Math.round(totalBytes / 4)`).
 */
export function estimateContextCostFromTree(treePath: string): ContextCostReport {
  if (!isDirectory(treePath)) {
    throw new ClaudeHostWriteError(
      `refusing to estimate context cost — framework tree is not a directory: ${treePath}`,
    );
  }

  const skillFiles = collectSkillFiles(treePath);
  const agentFiles = collectMarkdownFiles(join(treePath, "agents"));
  const commandFiles = collectMarkdownFiles(join(treePath, "commands"));
  const ruleFiles = collectMarkdownFilesRecursive(join(treePath, "rules"));
  const hooks = countHooks(treePath);
  const mcp = countMcpServers(treePath);

  const surfaceBytes = [...skillFiles, ...agentFiles, ...commandFiles, ...ruleFiles].reduce(
    (sum, path) => sum + fileByteSize(path),
    0,
  );
  const totalBytes = surfaceBytes + hooks.bytes + mcp.bytes;

  return {
    source: "aih-estimate",
    evidence: "aih static tree estimate (bytes/4)",
    projectedTokens: Math.round(totalBytes / CHARS_PER_TOKEN),
    counts: {
      skills: skillFiles.length,
      agents: agentFiles.length,
      commands: commandFiles.length,
      rules: ruleFiles.length,
      hooks: hooks.count,
      mcpServers: mcp.count,
    },
    totalBytes,
    estimate: true,
  };
}

// -- Tree-walk primitives (tolerant of a missing dir/file; never throw on absence) --

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileByteSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** List a directory's entries, tolerating a missing/unreadable dir as empty. */
function listDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Absolute `SKILL.md` paths per the skills heuristic (nested `skills/` layout UNION top-level layout). */
function collectSkillFiles(treePath: string): string[] {
  const found: string[] = [];
  const skillsDir = join(treePath, "skills");
  if (isDirectory(skillsDir)) {
    for (const name of listDirSafe(skillsDir)) {
      const candidate = join(skillsDir, name, "SKILL.md");
      if (isDirectory(join(skillsDir, name)) && isRegularFile(candidate)) found.push(candidate);
    }
  }
  for (const name of listDirSafe(treePath)) {
    const dir = join(treePath, name);
    if (!isDirectory(dir)) continue;
    const candidate = join(dir, "SKILL.md");
    if (isRegularFile(candidate)) found.push(candidate);
  }
  return found;
}

/** Immediate (non-recursive) `*.md` files directly under `dir`. */
function collectMarkdownFiles(dir: string): string[] {
  return listDirSafe(dir)
    .map((name) => join(dir, name))
    .filter((full) => full.endsWith(".md") && isRegularFile(full));
}

/** Every `*.md` file anywhere under `dir`, recursively (nested dirs counted as files). */
function collectMarkdownFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of listDirSafe(dir)) {
    const full = join(dir, name);
    if (isDirectory(full)) out.push(...collectMarkdownFilesRecursive(full));
    else if (name.endsWith(".md") && isRegularFile(full)) out.push(full);
  }
  return out;
}

/** Parse JSON/JSONC text, rethrowing any parse failure as a typed {@link ClaudeHostWriteError}. */
function parseTreeJson(text: string, path: string): unknown {
  try {
    return parseJsoncText(text);
  } catch (err) {
    throw new ClaudeHostWriteError(
      `refusing to estimate context cost — ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

/** `hooks/hooks.json`: sum hook-entry array lengths across every top-level event key. */
function countHooks(treePath: string): { count: number; bytes: number } {
  const path = join(treePath, "hooks", "hooks.json");
  const text = readIfExists(path);
  if (text === undefined) return { count: 0, bytes: 0 };

  const parsed = parseTreeJson(text, path);
  if (!isPlainObject(parsed)) {
    throw new ClaudeHostWriteError(
      `refusing to estimate context cost — ${path} must be a JSON object of event -> hook array`,
    );
  }
  let count = 0;
  for (const [event, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) {
      throw new ClaudeHostWriteError(
        `refusing to estimate context cost — ${path} event ${JSON.stringify(event)} is not an array`,
      );
    }
    count += value.length;
  }
  return { count, bytes: Buffer.byteLength(text, "utf8") };
}

/** `.mcp.json` (checked first) or `mcp.json`: count the top-level `mcpServers` map's keys. */
function countMcpServers(treePath: string): { count: number; bytes: number } {
  for (const name of [".mcp.json", "mcp.json"]) {
    const path = join(treePath, name);
    const text = readIfExists(path);
    if (text === undefined) continue;

    const parsed = parseTreeJson(text, path);
    if (!isPlainObject(parsed)) {
      throw new ClaudeHostWriteError(
        `refusing to estimate context cost — ${path} must be a JSON object`,
      );
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const serverMap = parsed[CLAUDE_MCP_KEY];
    if (serverMap === undefined) return { count: 0, bytes };
    if (!isPlainObject(serverMap)) {
      throw new ClaudeHostWriteError(
        `refusing to estimate context cost — ${path} "${CLAUDE_MCP_KEY}" must be an object`,
      );
    }
    return { count: Object.keys(serverMap).length, bytes };
  }
  return { count: 0, bytes: 0 };
}
