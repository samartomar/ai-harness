import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bootloaderPaths,
  CLI_BOOTLOADERS,
  SHARED_MARKER,
  sharedCanonicalBlockBody,
} from "../bootstrap-ai/canon.js";
import { eccLanguages } from "../ecc/select.js";
import { homeDir } from "../internals/cli-detect.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { gitRead } from "../internals/git.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { mcpServers } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import type { SupportTemplate } from "../support/render.js";
import { scanCliCoverage } from "./cli-coverage.js";
import { readinessDigest } from "./readiness.js";

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

/** File/dir names under `abs` matching the filter (basename, ext stripped); [] if missing. */
function listNames(abs: string, opts: { ext?: string; dirsOnly?: boolean }): string[] {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) =>
        opts.dirsOnly ? d.isDirectory() : opts.ext ? d.isFile() && d.name.endsWith(opts.ext) : true,
      )
      .map((d) => (opts.ext ? d.name.slice(0, -opts.ext.length) : d.name));
  } catch {
    return [];
  }
}

/** Count `.md` files under `abs`, recursing (ECC rules nest under `rules/<pack>/`); 0 if missing. */
function countMdRecursive(abs: string): number {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of dirents) {
    if (e.isDirectory()) n += countMdRecursive(join(abs, e.name));
    else if (e.isFile() && e.name.endsWith(".md")) n++;
  }
  return n;
}

/**
 * ECC version/commit/profile from its install manifest (`~/.claude/ecc/install-state.json`).
 * Only the metadata is taken from here — counts come from the LIVE install on disk, because the
 * manifest is a point-in-time snapshot (ECC rolls forward: it has since namespaced skills under
 * `skills/ecc/`, so the manifest's flat paths are stale). Undefined when ECC wasn't installed
 * via its tracked installer.
 */
function readEccMeta(
  home: string,
): { version?: string; commit?: string; profile?: string } | undefined {
  const text = readIfExists(join(home, ".claude", "ecc", "install-state.json"));
  if (text === undefined) return undefined;
  try {
    const s = JSON.parse(text) as {
      source?: { repoVersion?: unknown; repoCommit?: unknown };
      request?: { profile?: unknown };
    };
    return {
      version: typeof s.source?.repoVersion === "string" ? s.source.repoVersion : undefined,
      commit:
        typeof s.source?.repoCommit === "string" ? s.source.repoCommit.slice(0, 10) : undefined,
      profile: typeof s.request?.profile === "string" ? s.request.profile : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Names under `base/ecc/` (ECC's namespace) when present, else flat `base/` (older/flat installs). */
function eccNamespaced(base: string, opts: { ext?: string; dirsOnly?: boolean }): string[] {
  const ns = join(base, "ecc");
  return existsSync(ns) ? listNames(ns, opts) : listNames(base, opts);
}

/**
 * §1 ECC inventory — ECC is a SYSTEM-WIDE, rolling install, so the source of truth is what's
 * installed NOW at the machine level (~/.claude). ECC namespaces its content under `ecc/`
 * (`skills/ecc/`, `rules/ecc/`); we count there when present (else flat, for older installs) so
 * plugin skills sitting flat in `skills/` are never miscounted as ECC. Agents are flat. The
 * version/commit come from ECC's install manifest (metadata only — its counts are a stale
 * snapshot). Repo `.claude/.kiro` content is reported as TEAM OVERRIDES (never relabelled "ECC");
 * a repo item whose name is an ECC one is a fork to retire; packs = ECC packs for this stack
 * (impact). Machine-aware by design → not portable across machines. Undefined only when neither
 * machine nor repo carries anything.
 */
export function eccInventoryDigest(ctx: PlanContext): DigestAction | undefined {
  const r = ctx.root;
  const mClaude = join(homeDir(ctx), ".claude");
  const meta = readEccMeta(homeDir(ctx));
  // Current machine ECC — count the live ecc/ namespace (skills, rules) + flat agents.
  const eccAgentNames = eccNamespaced(join(mClaude, "agents"), { ext: ".md" });
  const eccSkillNames = eccNamespaced(join(mClaude, "skills"), { dirsOnly: true });
  const rulesBase = join(mClaude, "rules");
  const machine = {
    agents: eccAgentNames.length,
    skills: eccSkillNames.length,
    rules: existsSync(join(rulesBase, "ecc"))
      ? countMdRecursive(join(rulesBase, "ecc"))
      : countMdRecursive(rulesBase),
  };
  // Repo-local — team overrides committed under the repo's own .claude/.kiro (NOT ECC).
  const repoAgents = [
    ...listNames(join(r, ".claude", "agents"), { ext: ".md" }),
    ...listNames(join(r, ".kiro", "agents"), { ext: ".md" }),
  ];
  const repoSkills = [
    ...listNames(join(r, ".claude", "skills"), { dirsOnly: true }),
    ...listNames(join(r, ".kiro", "skills"), { dirsOnly: true }),
  ];
  const repo = {
    agents: repoAgents.length,
    skills: repoSkills.length,
    rules:
      countEntries(join(r, ".claude", "rules"), { ext: ".md" }) +
      countEntries(join(r, ".kiro", "steering"), { ext: ".md" }),
    hooks: countHooks(join(r, ".claude", "settings.json")),
  };
  if (
    machine.agents +
      machine.skills +
      machine.rules +
      repo.agents +
      repo.skills +
      repo.rules +
      repo.hooks ===
    0
  ) {
    return undefined;
  }
  // Duplication — a repo agent/skill whose NAME is an ECC one is a fork to retire.
  const eccAgents = new Set(eccAgentNames);
  const eccSkills = new Set(eccSkillNames);
  const dup =
    repoAgents.filter((n) => eccAgents.has(n)).length +
    repoSkills.filter((n) => eccSkills.has(n)).length;
  const stack = scanRepo(r, { maxDepth: 8, contextDir: ctx.contextDir });
  const packs = [...eccLanguages(stack).packs];
  const ver = meta?.version ? ` v${meta.version}` : "";
  const body = lines(
    `Machine ECC${ver} (~/.claude): ${machine.agents} agents · ${machine.skills} skills · ${machine.rules} rules`,
    meta
      ? "  (version from ECC install manifest; counts from the live install)"
      : "  (no ECC manifest — counts from the live install)",
    `Repo-local (team overrides): ${repo.agents} agents · ${repo.skills} skills · ${repo.rules} rules · ${repo.hooks} hooks`,
    dup > 0
      ? `  ⚠ ${dup} repo item(s) duplicate ECC — retire to inherit the rolling install.`
      : "  No repo duplication of ECC.",
    `  ECC packs for this stack: ${packs.join(", ") || "(none detected)"}`,
  );
  return digest(
    `ECC harness — machine ${machine.agents}a/${machine.skills}s, repo ${repo.agents}a/${repo.skills}s, ${dup} dup`,
    body,
    {
      machine,
      repo,
      dup,
      packs,
      skillNames: [...eccSkillNames].sort(),
      ...(meta?.version ? { version: meta.version } : {}),
      ...(meta?.commit ? { commit: meta.commit } : {}),
      ...(meta?.profile ? { profile: meta.profile } : {}),
    },
  );
}

/** Coherence verdict for one CLI/dimension cell. */
type Verdict = "ok" | "global" | "warn" | "bad";

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
    const router: Verdict = text?.includes("RULE_ROUTER.md") ? "ok" : "bad";
    // A global-scoped MCP (e.g. codex's ~/.codex, gemini's ~/.gemini) is wired and loads
    // but is NOT repo-portable. That's not a fixable divergence — those tools only read
    // MCP from their home config — so it gets its own neutral `global` verdict (distinct
    // glyph, counts as agreement) instead of an amber warn that implies something to fix.
    const mcp: Verdict =
      row.mcp.state === "wired"
        ? row.mcp.scope === "global"
          ? "global"
          : "ok"
        : row.mcp.state === "missing"
          ? "bad"
          : "warn";
    const loads: Verdict =
      row.load.verdict === "loads" ? "ok" : row.load.verdict === "wontLoad" ? "bad" : "warn";
    cells[row.cli] = [rules, router, mcp, loads];
  }
  const clis = targeted.map((r) => r.cli);
  const total = clis.length * dims.length;
  // `global` (codex/gemini MCP in ~/.codex / ~/.gemini) is wired and loads — it just
  // isn't repo-portable. It counts toward agreement (not a divergence the user can fix);
  // the matrix marks it with a distinct neutral glyph so it doesn't read as a problem.
  const ok = Object.values(cells)
    .flat()
    .filter((v) => v === "ok" || v === "global").length;
  const agreementPct = total > 0 ? Math.round((ok / total) * 100) : 0;
  const body = lines(
    `Cross-CLI canon coherence across ${clis.length} CLIs — ${agreementPct}% of cells agree.`,
    "A warn cell is one CLI diverging from canon; bad is missing/won't-load. A global cell",
    "(e.g. codex/gemini MCP in ~/.codex / ~/.gemini) is wired but machine-local — not",
    "repo-portable — and counts as agreement.",
  );
  return digest(`Coherence — ${agreementPct}% across ${clis.length} CLIs`, body, {
    clis,
    dims,
    cells,
    agreementPct,
  });
}

// ── run ledger (shared by §3 outcome/MTTR and §4 wins) ─────────────────────────

interface LedgerRow {
  capability?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  verification?: { pass?: number; fail?: number; skip?: number };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** All run-ledger rows under `.aih/runs/*.jsonl`, oldest first (empty when absent). */
function readLedger(root: string): LedgerRow[] {
  const dirAbs = join(root, ".aih", "runs");
  let files: string[];
  try {
    files = readdirSync(dirAbs)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
  const out: LedgerRow[] = [];
  for (const f of files) {
    const text = readIfExists(join(dirAbs, f));
    if (text === undefined) continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as LedgerRow);
      } catch {
        // skip malformed ledger lines
      }
    }
  }
  return out.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")));
}

/** "Jun 1" for a ledger timestamp (absolute, deterministic from the data). */
function sinceLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getUTCMonth()] ?? "?"} ${d.getUTCDate()}`;
}

function isFail(status: string | undefined): boolean {
  return status === "failed" || status === "error" || status === "partial";
}

/**
 * §3 Outcome deltas / MTTR — the honest "did productivity improve" measures. MTTR
 * (time a failing run stayed broken before a later success) comes from the run ledger;
 * rework rate + lead time come from the git seam. Gated on the ledger having ≥2
 * samples (the capability's real signal); otherwise undefined → panel PREVIEW.
 */
export async function outcomeDeltasDigest(ctx: PlanContext): Promise<DigestAction | undefined> {
  const ledger = readLedger(ctx.root);
  if (ledger.length < 2) return undefined;

  // MTTR per failure class: walk each capability's runs, measure failed→success gaps.
  const byCap = new Map<string, LedgerRow[]>();
  for (const r of ledger) {
    const cap = r.capability ?? "";
    const arr = byCap.get(cap) ?? [];
    arr.push(r);
    byCap.set(cap, arr);
  }
  const driftGaps: number[] = [];
  const externalGaps: number[] = [];
  for (const [cap, rows] of byCap) {
    let failedAt: number | undefined;
    for (const r of rows) {
      const ts = new Date(r.finishedAt ?? r.startedAt ?? "").getTime();
      if (Number.isNaN(ts)) continue;
      if (isFail(r.status)) {
        if (failedAt === undefined) failedAt = ts;
      } else if (r.status === "success" && failedAt !== undefined) {
        const hours = (ts - failedAt) / 3_600_000;
        (cap.includes("heal") ? externalGaps : driftGaps).push(hours);
        failedAt = undefined;
      }
    }
  }
  const avg = (xs: number[]): number =>
    xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  const driftHours = avg(driftGaps);
  const externalCheckDays = Math.round((avg(externalGaps) / 24) * 10) / 10;

  // Rework / revert rate + lead time from git (best-effort; 0 when unavailable).
  const log = await gitRead(ctx, ["log", "--since=30.days.ago", "--format=%s"]);
  const msgs = (log ?? "").split("\n").filter(Boolean);
  const reverts = msgs.filter((m) =>
    /^revert\b|\brevert\b|\bhotfix\b|\brollback\b/i.test(m),
  ).length;
  const reworkRatePct = msgs.length > 0 ? Math.round((reverts / msgs.length) * 100) : 0;
  const leadTimeDays = await leadTime(ctx);

  const body = lines(
    "Outcome deltas (DORA-flavored), from the run ledger + git seam:",
    "",
    `  lead time ${leadTimeDays}d · rework ${reworkRatePct}% · drift MTTR ${driftHours}h · external MTTR ${externalCheckDays}d`,
  );
  return digest(
    `Outcome deltas — MTTR ${driftHours}h drift / ${externalCheckDays}d external`,
    body,
    {
      leadTimeDays,
      reworkRatePct,
      mttr: { driftHours, externalCheckDays },
    },
  );
}

/** Average lead time (days) from a branch's first commit to its merge, over recent merges. */
async function leadTime(ctx: PlanContext): Promise<number> {
  const merges =
    (await gitRead(ctx, ["log", "--merges", "--format=%H %ct", "-n", "8", "HEAD"])) ?? "";
  const spans: number[] = [];
  for (const line of merges.split("\n").filter(Boolean)) {
    const [sha, mct] = line.split(" ");
    if (!sha || !mct) continue;
    const branch = await gitRead(ctx, ["log", "--format=%ct", `${sha}^1..${sha}^2`]);
    const times = (branch ?? "").split("\n").filter(Boolean).map(Number);
    const oldest = times[times.length - 1];
    if (oldest && Number.isFinite(oldest)) spans.push((Number(mct) - oldest) / 86_400);
  }
  return spans.length === 0
    ? 0
    : Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10;
}

/** The four host-runtime blockers `aih heal` clears, in dependency order. */
const HEAL_SCOPES = [
  { name: "Certificate trust chain", scope: "certs", detail: "corporate CA / TLS trust" },
  { name: "npm runtime", scope: "npm", detail: "npm / node runtime resolves" },
  { name: "PATH resolution", scope: "path", detail: "rg / fd / jq resolve" },
  { name: "MCP pre-flight", scope: "mcp", detail: "npx can launch MCP servers" },
] as const;

/**
 * §4 Wins / remediation ledger — what `aih heal` unblocked, from the run ledger
 * (network-free: no inline heal probe). Cumulative (cleared / runs / since /
 * open-over-time) is real from the ledger; the per-item rows show the four known heal
 * scopes, marked fixed only when the latest heal run was a clean success (richer
 * per-check detail needs heal to persist its result). Undefined when heal never ran.
 */
export function winsDigest(ctx: PlanContext): DigestAction | undefined {
  const heal = readLedger(ctx.root).filter((r) => r.capability === "heal");
  if (heal.length === 0) return undefined;
  const last = heal[heal.length - 1];
  const allGreen = last?.status === "success" && (last?.verification?.fail ?? 0) === 0;
  // §2b — which scopes the last heal actually probed, from `.aih/heal-last.json` (written
  // by `aih heal`). When absent, fall back to assuming all four were probed (back-compat).
  const probed = (() => {
    const text = readIfExists(join(ctx.root, ".aih", "heal-last.json"));
    if (text === undefined) return undefined;
    try {
      const p = JSON.parse(text) as { scopes?: unknown };
      return Array.isArray(p.scopes)
        ? p.scopes.filter((s): s is string => typeof s === "string")
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const when = sinceLabel(last?.finishedAt ?? last?.startedAt ?? "");
  const items = HEAL_SCOPES.map((s) => {
    const inScope = probed ? probed.includes(s.scope) : true;
    const status: "fixed" | "broken" | "na" = !inScope ? "na" : allGreen ? "fixed" : "broken";
    return {
      name: s.name,
      scope: s.scope,
      status,
      detail: status === "na" ? `${s.detail} (not probed)` : s.detail,
      when: status === "fixed" ? when : "",
    };
  });
  const cleared = items.filter((i) => i.status === "fixed").length;
  const openOverTime = heal.map((r) => r.verification?.fail ?? 0);
  const since = sinceLabel(heal[0]?.startedAt ?? "");
  const body = lines(
    `Remediation ledger — ${cleared} blocker(s) cleared across ${heal.length} heal run(s) since ${since}.`,
    "",
    ...items.map((i) => `  ${i.status === "fixed" ? "✓" : "·"} ${i.name} (${i.status})`),
  );
  return digest(`Remediation — ${cleared} cleared across ${heal.length} runs`, body, {
    items,
    cleared,
    runs: heal.length,
    since,
    openOverTime,
  });
}

/**
 * The v9-only extra digests, appended to the report's digests on the `--v9` path.
 * Developer readiness (always-renders "can I start?" gate). Phase A: drift + MCP
 * servers/egress. Phase B: ECC inventory, coherence, outcome deltas/MTTR and the wins
 * ledger (support is built from the caller's already-rendered templates and appended
 * separately). Async because the outcome digest reads git.
 */
export async function v9ExtraDigests(ctx: PlanContext): Promise<DigestAction[]> {
  return [
    // Readiness ALWAYS renders (even a harness-less repo earns a verdict), so its
    // `sec-ready` panel is always LIVE on the local report path.
    readinessDigest(ctx),
    driftDigest(ctx),
    mcpServersDigest(ctx),
    eccInventoryDigest(ctx),
    coherenceDigest(ctx),
    await outcomeDeltasDigest(ctx),
    winsDigest(ctx),
  ].filter((d): d is DigestAction => d !== undefined);
}
