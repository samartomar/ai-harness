import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bootloaderPaths,
  CLI_BOOTLOADERS,
  SHARED_MARKER,
  sharedCanonicalBlockBody,
} from "../bootstrap-ai/canon.js";
import { verifyBundleChecksums } from "../bundle/index.js";
import { eccLanguages } from "../ecc/select.js";
import { DEFAULT_EVIDENCE_OUT, EVIDENCE_FILE, EvidenceBundleSchema } from "../evidence/manifest.js";
import { homeDir } from "../internals/cli-detect.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { gitRead } from "../internals/git.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { ensureTrailingNewline, lines } from "../internals/render.js";
import { DEFAULT_MARKETPLACE_OUT, readMarketplaceManifest } from "../marketplace/manifest.js";
import { marketplaceReport } from "../marketplace/validate.js";
import { policyAwareMcpCatalog } from "../mcp/catalog.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { OrgPolicyError, readOrgPolicy } from "../org-policy/schema.js";
import { scanRepo } from "../profile/scan.js";
import { skillInventory } from "../skill/index.js";
import { AIH_SKILLS_LOCK_FILE, readSkillsLock } from "../skill/lockfile.js";
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

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const catalogResult = policyAwareMcpCatalog(ctx, {
    scope: "local",
    stack,
    includeDisabledServers: true,
  });
  if (catalogResult.error !== undefined || catalogResult.servers === undefined) {
    const catalogError =
      catalogResult.error !== undefined ? errorDetail(catalogResult.error) : "missing catalog";
    const servers: Array<[string, string]> = names.map((n) => [n, "unknown"]);
    const body = lines(
      `MCP servers configured in .mcp.json (${servers.length}); egress per server:`,
      "",
      ...servers.map(([n, e]) => `  · ${n}  (${e})`),
      "",
      `  policy-aware MCP catalog unavailable: ${catalogError}`,
      "  Refusing to assert third-party egress status until policy/catalog input is valid.",
    );
    return digest(`MCP servers — ${servers.length} configured, catalog unavailable`, body, {
      servers,
      catalogError,
    });
  }
  const catalog = catalogResult.servers;
  const disabled = new Set(catalogResult.policy?.mcp?.disabledServers ?? []);
  const servers: Array<[string, string]> = names.map((n) => {
    const entry = catalog[n] as { egress?: string } | undefined;
    return [n, egressLabel(entry?.egress)];
  });
  const thirdParty = servers.filter(([, e]) => e === "third-party").length;
  const policyDisabled = names.filter((n) => disabled.has(n));
  const body = lines(
    `MCP servers configured in .mcp.json (${servers.length}); egress per server:`,
    "",
    ...servers.map(([n, e]) => `  ${e === "third-party" ? "!" : "·"} ${n}  (${e})`),
    "",
    ...(policyDisabled.length > 0
      ? [
          `  Policy-disabled configured server(s): ${policyDisabled.join(", ")}.`,
          "  Remove them from .mcp.json or update aih-org-policy.json before rollout.",
          "",
        ]
      : []),
    thirdParty > 0
      ? `  ${thirdParty} third-party server(s) send queries off-box — confirm approved.`
      : "  No third-party egress.",
  );
  return digest(`MCP servers — ${servers.length} configured, ${thirdParty} third-party`, body, {
    servers,
    thirdParty,
    policyDisabled,
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

/** The publisher-signature filename beside `SHA256SUMS` (marketplace + bundles). */
const SIGNATURE_FILE = "SHA256SUMS.sig";

/**
 * Marketplace artifact state for the governance digest — present only when the
 * DEFAULT artifact (`.aih/marketplace`) exists under the target root; absent dir →
 * `undefined` → the panel renders byte-identically. Grades with the SAME pure-fs
 * join `marketplace validate` runs ({@link marketplaceReport} — no spawn; the
 * spawning signature probe is validate's verify-phase concern, never the digest's),
 * and reads `marketplace.json` for the packaged-skill count. `signed` reports only
 * that the signature FILE exists — a presence claim, NEVER "verified": proving the
 * signature needs cosign/gh, which is `aih marketplace validate`'s job (the
 * plan-purity floor, #35, keeps digest time spawn-free).
 */
function marketplaceState(
  ctx: PlanContext,
): { skills: number; findings: number; signed: boolean } | undefined {
  const dir = join(ctx.root, DEFAULT_MARKETPLACE_OUT);
  if (!existsSync(dir)) return undefined;
  const read = readMarketplaceManifest(dir);
  return {
    skills: read.ok ? read.manifest.skills.length : 0,
    findings: marketplaceReport(dir).findings.length,
    signed: existsSync(join(dir, SIGNATURE_FILE)),
  };
}

/**
 * The re-hash budget for the digest-time integrity check: past this many bundled
 * bytes (summed from `manifest.json`, one cheap read), `current` is reported as
 * `undefined` ("not re-verified") instead of re-hashing the whole bundle on every
 * report generation. Evidence bundles ACCUMULATE run logs and prior reports, so an
 * uncapped pass would make `aih report --v9` cost grow with bundle history —
 * disproportionate for a one-boolean answer that `aih verify-bundle` owns anyway.
 */
const EVIDENCE_REHASH_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * Evidence-bundle state for the governance digest — present only when the DEFAULT
 * bundle (`.aih/evidence-bundle`) exists under the target root; absent dir →
 * `undefined` → the panel renders byte-identically. Three honest, cheap reads:
 * `artifacts` counts the `evidence.json` kind-index entries; `current` reuses the
 * fleet bundle's {@link verifyBundleChecksums} (pure fs), which checks the BUNDLED
 * COPIES against the bundle's own SHA256SUMS — INTERNAL consistency, never
 * freshness vs the live repo — and is SKIPPED (`undefined`) when the bundle's
 * manifest-declared size exceeds {@link EVIDENCE_REHASH_BUDGET_BYTES}; `stale` is
 * the one freshness probe cheap enough to be worth making: the LIVE skills lock
 * compared byte-for-byte (after the write engine's trailing-newline normalization,
 * the same one `evidence build` hashes through) to its bundled copy. The lock is
 * the approval authority every other bundled artifact follows, so lock drift means
 * the bundle predates a governance change — the `aih evidence build --apply`
 * rebuild hint. Anything deeper stays `aih verify-bundle`'s job.
 */
function evidenceState(
  ctx: PlanContext,
): { artifacts: number; current?: boolean; stale: boolean } | undefined {
  const dir = join(ctx.root, DEFAULT_EVIDENCE_OUT);
  if (!existsSync(dir)) return undefined;
  const artifacts = (() => {
    const raw = readIfExists(join(dir, EVIDENCE_FILE));
    if (raw === undefined) return 0;
    try {
      const parsed = EvidenceBundleSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.artifacts.length : 0;
    } catch {
      return 0; // unreadable index → 0 indexed artifacts; `current` still grades the tree
    }
  })();
  // Manifest-declared size (one small read) gates the full re-hash. An unreadable
  // manifest grades as 0 declared bytes: verifyBundleChecksums then runs and fails
  // loudly on the missing/mismatched manifest rather than being silently skipped.
  const declaredBytes = (() => {
    const raw = readIfExists(join(dir, "manifest.json"));
    if (raw === undefined) return 0;
    try {
      const parsed = JSON.parse(raw) as { files?: Array<{ bytes?: unknown }> } | null;
      if (!Array.isArray(parsed?.files)) return 0;
      return parsed.files.reduce(
        (sum, f) => sum + (typeof f.bytes === "number" && f.bytes > 0 ? f.bytes : 0),
        0,
      );
    } catch {
      return 0;
    }
  })();
  const current =
    declaredBytes > EVIDENCE_REHASH_BUDGET_BYTES
      ? undefined
      : verifyBundleChecksums(dir).verdict === "pass";
  const norm = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : ensureTrailingNewline(text);
  const live = norm(readIfExists(join(ctx.root, AIH_SKILLS_LOCK_FILE)));
  const bundled = norm(readIfExists(join(dir, "files", AIH_SKILLS_LOCK_FILE)));
  return { artifacts, ...(current !== undefined ? { current } : {}), stale: live !== bundled };
}

/**
 * Org-policy state for the governance digest — presence + schema PARSE only, the
 * deliberately shallow read: deep validation (reference resolution, bundle rules)
 * stays `aih policy validate`'s job, and the digest line says so. Absent file →
 * `undefined` → absent field: vibe repos carry no org policy, and absence is not a
 * finding. `readOrgPolicy` THROWS {@link OrgPolicyError} on an unreadable or
 * schema-invalid file — here that is a `valid: false` datum (the report must render
 * through a broken policy, never crash on it), carrying the first error line with
 * control/bidi characters stripped and hard-capped so a hand-edited JSON message
 * cannot visually spoof or flood the panel.
 */
function orgPolicyState(
  ctx: PlanContext,
): { present: true; valid: boolean; error?: string } | undefined {
  try {
    // ONE read: readOrgPolicy returns undefined for an absent file (not a finding)
    // and throws OrgPolicyError for a present-but-broken one.
    if (readOrgPolicy(ctx.root, ctx.env) === undefined) return undefined;
    return { present: true, valid: true };
  } catch (err) {
    if (!(err instanceof OrgPolicyError)) throw err;
    const first = (err.message.split("\n")[0] ?? "").replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    );
    const error = first.length > 160 ? `${first.slice(0, 159)}…` : first;
    return { present: true, valid: false, ...(error.length > 0 ? { error } : {}) };
  }
}

/**
 * Skill governance — the read-only join over installed external skills and their
 * committed approvals (`skillInventory`), surfaced so the dashboard shows what is on
 * disk vs approved (richer than the lockfile alone: it also names unapproved and
 * pin-drifted skills). Also carries the v0.6 distribution/audit surfaces when they
 * exist on disk (marketplace artifact, evidence bundle, org policy — each absent one
 * stays absent, keeping the panel byte-identical). EMPTY only when there is nothing
 * to govern — no on-disk skills, no committed approvals, and no governance
 * artifacts; then the panel gates honestly instead of showing zeros. Pure fs
 * (nothing here spawns), so it is safe at digest time.
 */
export function skillGovernanceDigest(ctx: PlanContext): DigestAction | undefined {
  const inv = skillInventory(ctx);
  const marketplace = marketplaceState(ctx);
  const evidence = evidenceState(ctx);
  const orgPolicy = orgPolicyState(ctx);
  if (
    inv.counts.installed === 0 &&
    readSkillsLock(ctx.root).skills.length === 0 &&
    marketplace === undefined &&
    evidence === undefined &&
    orgPolicy === undefined
  ) {
    return undefined;
  }
  const { installed, approved, unapproved, stalePin, quarantined } = inv.counts;
  const notable = inv.skills.filter((s) => s.status !== "approved");
  const rows = inv.skills.map((s) => ({
    name: s.name,
    status: s.status,
    ...(s.verdict !== undefined ? { verdict: s.verdict } : {}),
    ...(s.source !== undefined ? { source: s.source } : {}),
    ...(s.commit !== undefined ? { commit: s.commit } : {}),
  }));
  // Pack rollup — installed skills grouped by their lock entry's `pack` tag. Rendered
  // (body line + data key) ONLY when at least one skill carries a tag, so a pack-free
  // repo's digest stays byte-identical (the quarantined-count pattern). Quarantined
  // members COUNT (their rows keep the lock entry's pack tag — the PR #111 fix): a
  // parked member is still the pack's, just disabled, so it widens `skills` without
  // widening `approved` and carries its own count. The per-pack `quarantined` key is
  // emitted only when non-zero — a quarantine-free pack repo's digest stays byte-identical.
  const byPack = new Map<
    string,
    { name: string; skills: number; approved: number; quarantined: number }
  >();
  for (const s of inv.skills) {
    if (s.pack === undefined) continue;
    const entry = byPack.get(s.pack) ?? { name: s.pack, skills: 0, approved: 0, quarantined: 0 };
    entry.skills += 1;
    if (s.status === "approved") entry.approved += 1;
    if (s.status === "quarantined") entry.quarantined += 1;
    byPack.set(s.pack, entry);
  }
  const packs = [...byPack.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      skills: p.skills,
      approved: p.approved,
      ...(p.quarantined > 0 ? { quarantined: p.quarantined } : {}),
    }));
  // v0.6 distribution/audit lines — one grouped section (the "by pack:" pattern),
  // rendered only when at least one surface exists so everything before it stays
  // byte-identical on repos without governance artifacts.
  const artifactLines = [
    ...(marketplace
      ? [
          `  marketplace artifact (${DEFAULT_MARKETPLACE_OUT}) — ${marketplace.skills} skill(s) · ` +
            `${marketplace.findings} finding(s) · ${marketplace.signed ? "signature file present" : "unsigned"} ` +
            "(verify: `aih marketplace validate`)",
        ]
      : []),
    ...(evidence
      ? [
          `  evidence bundle (${DEFAULT_EVIDENCE_OUT}) — ${evidence.artifacts} artifact(s) · ` +
            (evidence.current === undefined
              ? "integrity not re-verified (large bundle; check: `aih verify-bundle`)"
              : evidence.current
                ? "internally consistent"
                : "bundled copies do NOT match SHA256SUMS") +
            (evidence.stale ? " · live skills lock has moved past the bundled copy" : "") +
            (evidence.current === false || evidence.stale
              ? " (rebuild: `aih evidence build --apply`)"
              : ""),
        ]
      : []),
    ...(orgPolicy
      ? [
          `  org policy (${AIH_ORG_POLICY_FILE}) — ` +
            (orgPolicy.valid
              ? "present · parses against the org-policy schema"
              : `INVALID: ${orgPolicy.error ?? "unreadable"}`) +
            " (deep validation: `aih policy validate`)",
        ]
      : []),
  ];
  const body = lines(
    `${installed} external skill${installed === 1 ? "" : "s"} installed · ${approved} approved · ${unapproved} unapproved · ${stalePin} stale-pin · ${quarantined} quarantined.`,
    "",
    ...notable.map((s) =>
      s.status === "stale-pin"
        ? `  ! ${s.name} — stale pin (${s.driftReason ?? "commit drift"})`
        : s.status === "quarantined"
          ? `  ! ${s.name} — quarantined (disabled; move it back from .aih/quarantine to restore)`
          : `  ! ${s.name} — unapproved (run \`aih skill vet\` then \`aih skill approve\`)`,
    ),
    notable.length === 0
      ? `  All ${approved} installed skill${approved === 1 ? " is" : "s are"} approved and in sync.`
      : "",
    ...(packs.length > 0
      ? [
          "",
          "by pack:",
          ...packs.map(
            (p) =>
              `  ${p.name} — ${p.approved}/${p.skills} approved` +
              (p.quarantined !== undefined ? ` · ${p.quarantined} quarantined` : ""),
          ),
        ]
      : []),
    ...(artifactLines.length > 0 ? ["", "distribution & audit:", ...artifactLines] : []),
  );
  // The parenthetical breakdown must SUM to `installed` — quarantined rows count as
  // installed, so omitting them here would silently drop skills from the explanation.
  const breakdown =
    quarantined > 0
      ? `${approved} approved, ${unapproved} unapproved, ${stalePin} stale, ${quarantined} quarantined`
      : `${approved} approved, ${unapproved} unapproved, ${stalePin} stale`;
  return digest(`Skill governance — ${installed} installed (${breakdown})`, body, {
    installed,
    approved,
    unapproved,
    stalePin,
    quarantined,
    rows,
    ...(packs.length > 0 ? { packs } : {}),
    ...(marketplace !== undefined ? { marketplace } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(orgPolicy !== undefined ? { orgPolicy } : {}),
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
    skillGovernanceDigest(ctx),
  ].filter((d): d is DigestAction => d !== undefined);
}
