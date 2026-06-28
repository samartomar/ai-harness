import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bootloaderPaths,
  CLI_BOOTLOADERS,
  SHARED_MARKER,
  sharedCanonicalBlockBody,
} from "../bootstrap-ai/canon.js";
import { eccLanguages } from "../ecc/select.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import type { SupportTemplate } from "../support/render.js";
import { scanCliCoverage } from "./cli-coverage.js";

/**
 * v9-only report digests — the capabilities the v9 dashboard binds that the legacy
 * report and `--v4` do not. They live OUTSIDE `localPanels` so legacy output stays
 * byte-identical (a new shared digest would surface in the legacy "More" section);
 * `aih report --v9` appends these before rendering. Each is read-only, pure over
 * fs/ctx (no clock in output), and returns `undefined`/empty so its panel gates
 * honestly. Phase A wires drift + MCP servers/egress + support; Phase B adds the
 * ECC scan, coherence diff, outcome/MTTR and the wins ledger.
 */

/** ~tokens for a string (bytes/4, matching the context-footprint estimate). */
function estTokens(s: string): number {
  return Math.round(s.length / 4);
}

/**
 * Canon drift — per-bootloader managed-block sync vs the freshly generated canonical
 * block (the same primitives the maturity scorecard's `bootloaders-in-sync` check
 * uses, surfaced per file so the dashboard can list which drifted). Off-canon → undefined.
 */
export function driftDigest(ctx: PlanContext): DigestAction | undefined {
  const dir = ctx.contextDir;
  if (!existsSync(join(ctx.root, dir, "RULE_ROUTER.md"))) return undefined;
  const sharedBody = sharedCanonicalBlockBody(dir).trim();
  const present = bootloaderPaths(SUPPORTED_CLIS).filter((rel) => existsSync(join(ctx.root, rel)));
  const drifted: Array<{ file: string; delta: string; status: string; when: string }> = [];
  const synced: string[] = [];
  for (const rel of present) {
    const text = readIfExists(join(ctx.root, rel));
    if (text === undefined) continue;
    const block = extractManagedBlock(text, SHARED_MARKER);
    if (block === undefined) continue; // file carries no managed block → not tracked
    if (block.trim() === sharedBody) {
      synced.push(rel);
    } else {
      const delta = estTokens(block.trim()) - estTokens(sharedBody);
      drifted.push({
        file: rel,
        delta: `${delta >= 0 ? "+" : ""}${delta} tok`,
        status: "drifted",
        when: "",
      });
    }
  }
  const tracked = drifted.length + synced.length;
  if (tracked === 0) return undefined;
  const body = lines(
    `Managed-block drift across ${tracked} tracked bootloader${tracked === 1 ? "" : "s"}:`,
    "",
    ...drifted.map((d) => `  ✗ ${d.file}  (${d.delta} out of sync)`),
    ...synced.map((s) => `  ✓ ${s}  (in sync)`),
  );
  return digest(`Canon drift — ${drifted.length} of ${tracked} drifted`, body, {
    drifted,
    synced,
    tracked,
  });
}

/** Map the catalog's egress axis to the dashboard's display class. */
function egressLabel(egress: string | undefined): string {
  if (egress === "third-party") return "third-party";
  if (egress === "vendor-incumbent") return "vendor API";
  if (egress === "none" || egress === "local-only") return "local";
  return "unknown";
}

/** Configured MCP server names from this repo's `.mcp.json` (undefined when absent). */
function configuredServerNames(root: string): string[] | undefined {
  const text = readIfExists(join(root, ".mcp.json"));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers && typeof parsed.mcpServers === "object"
      ? Object.keys(parsed.mcpServers)
      : [];
  } catch {
    return [];
  }
}

/**
 * MCP servers + egress — the repo's configured MCP servers (`.mcp.json`) mapped to the
 * curated catalog's egress classification (`src/mcp/servers.ts`). No runtime metering;
 * pure supply-chain truth (local / vendor / third-party). Undefined when no `.mcp.json`.
 */
export function mcpServersDigest(ctx: PlanContext): DigestAction | undefined {
  const names = configuredServerNames(ctx.root);
  if (names === undefined) return undefined;
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const catalog = mcpServers("local", stack);
  const servers: Array<[string, string]> = names.map((n) => {
    const entry = catalog[n] as { egress?: string } | undefined;
    return [n, egressLabel(entry?.egress)];
  });
  const thirdParty = servers.filter(([, e]) => e === "third-party").length;
  const body = lines(
    `MCP servers configured in .mcp.json (${servers.length}); egress per server:`,
    "",
    ...servers.map(([n, e]) => `  ${e === "third-party" ? "!" : "·"} ${n}  (${e})`),
    "",
    thirdParty > 0
      ? `  ${thirdParty} third-party server(s) send queries off-box — confirm approved.`
      : "  No third-party egress.",
  );
  return digest(`MCP servers — ${servers.length} configured, ${thirdParty} third-party`, body, {
    servers,
    thirdParty,
  });
}

/**
 * Support pipeline summary — the report's own advisory findings, already routed and
 * (for escalations) redacted by the caller (`reportSupportTemplates`). Counts findings
 * by who acts (self-fix / improvement / escalation) and surfaces the first escalation
 * ticket for the copy-to-IT card.
 */
export function supportDigest(templates: SupportTemplate[]): DigestAction {
  let selfFix = 0;
  let improvement = 0;
  let escalation = 0;
  let ticket = "";
  for (const t of templates) {
    if (t.kind === "escalation") {
      escalation++;
      if (ticket === "") ticket = `Subject: ${t.subject}\n\n${t.body}`;
    } else if (t.kind === "improvement") {
      improvement++;
    } else {
      selfFix++;
    }
  }
  const body = lines(
    `Findings routed by who acts: ${selfFix} self-fix · ${improvement} improvement · ${escalation} escalation`,
    escalation > 0 ? "" : "No external blockers to escalate to IT.",
  );
  return digest("Support pipeline", body, {
    findings: { selfFix, improvement, escalation },
    ticket,
  });
}

/** Count directory entries matching a filter (missing dir → 0). */
function countEntries(abs: string, opts: { ext?: string; dirsOnly?: boolean }): number {
  try {
    return readdirSync(abs, { withFileTypes: true }).filter((d) => {
      if (opts.dirsOnly) return d.isDirectory();
      if (opts.ext) return d.isFile() && d.name.endsWith(opts.ext);
      return true;
    }).length;
  } catch {
    return 0;
  }
}

/** Count hook commands declared in a Claude `settings.json` (array or event-keyed object). */
function countHooks(abs: string): number {
  const text = readIfExists(abs);
  if (text === undefined) return 0;
  try {
    const parsed = JSON.parse(text) as { hooks?: unknown };
    const h = parsed.hooks;
    if (!h) return 0;
    const groups = Array.isArray(h) ? h : Object.values(h as Record<string, unknown>).flat();
    let n = 0;
    for (const g of groups) {
      const inner = (g as { hooks?: unknown })?.hooks;
      n += Array.isArray(inner) ? inner.length : 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * §1 ECC-inventory scan — what an ECC install actually put on disk (agents / skills /
 * rules / hooks under `.claude/` + `.kiro/`) plus the stack packs ECC selects for this
 * repo. Honest file counts ("scanned from .claude/.kiro"). Undefined when no ECC
 * content is present, so the panel gates to PREVIEW. The dormant set (installed minus
 * invoked) needs the usage recorder and stays PREVIEW until that lands.
 */
export function eccInventoryDigest(ctx: PlanContext): DigestAction | undefined {
  const r = ctx.root;
  const agents =
    countEntries(join(r, ".claude", "agents"), { ext: ".md" }) +
    countEntries(join(r, ".kiro", "agents"), { ext: ".md" });
  const skills =
    countEntries(join(r, ".claude", "skills"), { dirsOnly: true }) +
    countEntries(join(r, ".kiro", "skills"), { dirsOnly: true });
  const rules =
    countEntries(join(r, ".claude", "rules"), { ext: ".md" }) +
    countEntries(join(r, ".kiro", "steering"), { ext: ".md" });
  const hooks = countHooks(join(r, ".claude", "settings.json"));
  if (agents + skills + rules + hooks === 0) return undefined;
  const stack = scanRepo(r, { maxDepth: 8, contextDir: ctx.contextDir });
  const packs = [...eccLanguages(stack).packs];
  const body = lines(
    "ECC content on disk (scanned from .claude/.kiro):",
    "",
    `  agents ${agents} · skills ${skills} · rules ${rules} · hooks ${hooks}`,
    `  stack packs: ${packs.join(", ") || "(none detected)"}`,
  );
  return digest(
    `ECC harness — ${agents} agents, ${skills} skills, ${rules} rules, ${hooks} hooks`,
    body,
    { agents, skills, rules, hooks, packs },
  );
}

/** Coherence verdict for one CLI/dimension cell. */
type Verdict = "ok" | "warn" | "bad";

/**
 * §2 Cross-CLI coherence diff — do all targeted CLIs load the SAME canon? For each
 * targeted CLI, compare four dimensions against the canonical expectation: rules
 * (managed block in sync), router (points at RULE_ROUTER), mcp (wired) and loads
 * (loadable). Reuses the same primitives as drift + the maturity scorecard. Undefined
 * off-canon or with fewer than two targeted CLIs (no cross-CLI question to answer).
 */
export function coherenceDigest(ctx: PlanContext): DigestAction | undefined {
  const dir = ctx.contextDir;
  if (!existsSync(join(ctx.root, dir, "RULE_ROUTER.md"))) return undefined;
  const targeted = scanCliCoverage(ctx).rows.filter((row) => row.targeted);
  if (targeted.length < 2) return undefined;
  const sharedBody = sharedCanonicalBlockBody(dir).trim();
  const dims = ["rules", "router", "mcp", "loads"];
  const cells: Record<string, Verdict[]> = {};
  for (const row of targeted) {
    let text: string | undefined;
    for (const p of CLI_BOOTLOADERS[row.cli] ?? []) {
      const t = readIfExists(join(ctx.root, p));
      if (t !== undefined) {
        text = t;
        break;
      }
    }
    const block = text !== undefined ? extractManagedBlock(text, SHARED_MARKER) : undefined;
    const rules: Verdict =
      block === undefined ? "bad" : block.trim() === sharedBody ? "ok" : "warn";
    const router: Verdict = text !== undefined && text.includes("RULE_ROUTER.md") ? "ok" : "bad";
    const mcp: Verdict =
      row.mcp.state === "wired" ? "ok" : row.mcp.state === "missing" ? "bad" : "warn";
    const loads: Verdict =
      row.load.verdict === "loads" ? "ok" : row.load.verdict === "wontLoad" ? "bad" : "warn";
    cells[row.cli] = [rules, router, mcp, loads];
  }
  const clis = targeted.map((r) => r.cli);
  const total = clis.length * dims.length;
  const ok = Object.values(cells)
    .flat()
    .filter((v) => v === "ok").length;
  const agreementPct = total > 0 ? Math.round((ok / total) * 100) : 0;
  const body = lines(
    `Cross-CLI canon coherence across ${clis.length} CLIs — ${agreementPct}% of cells agree.`,
    "A warn cell is one CLI diverging from canon; bad is missing/won't-load.",
  );
  return digest(`Coherence — ${agreementPct}% across ${clis.length} CLIs`, body, {
    clis,
    dims,
    cells,
    agreementPct,
  });
}

/**
 * The v9-only extra digests, appended to the report's digests on the `--v9` path.
 * Phase A: drift + MCP servers/egress. Phase B: ECC inventory + coherence (support is
 * built from the caller's already-rendered templates and appended separately).
 */
export function v9ExtraDigests(ctx: PlanContext): DigestAction[] {
  return [
    driftDigest(ctx),
    mcpServersDigest(ctx),
    eccInventoryDigest(ctx),
    coherenceDigest(ctx),
  ].filter((d): d is DigestAction => d !== undefined);
}
