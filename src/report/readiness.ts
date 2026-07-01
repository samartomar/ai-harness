import { postureFromContext } from "../config/posture.js";
import { contractTruthCheck } from "../contract/check.js";
import { certStep } from "../heal/cert-verify.js";
import {
  classifyTool,
  type HealShared,
  REGISTRY_URL,
  tlsCheck,
  versionArgv,
} from "../heal/common.js";
import { mcpStep } from "../heal/mcp-probe.js";
import { pathStep } from "../heal/path-heal.js";
import { preCommitHookActive } from "../internals/git-hooks.js";
import type { Action, DigestAction, PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { scanRepo } from "../profile/scan.js";
import { scanConfigSecrets, scanSecrets } from "../secrets/scan.js";
import { inventory } from "../status.js";
import { scanCliCoverage } from "./cli-coverage.js";
import {
  type CheckResult,
  check,
  type DimensionResult,
  dim,
  type Grade,
  gradeOf,
} from "./grade.js";
import { remediationBlock } from "./render.js";

/**
 * DEVELOPER READINESS — "can this developer, on THIS machine, in THIS repo, make a
 * correct first change with an AI agent right now?" Unlike {@link scorecardDigest}
 * (harness MATURITY, which omits entirely off-canon), readiness ALWAYS renders: a
 * harness-less repo is the single most important readiness case — it earns warns and
 * a first-command handoff, never silence.
 *
 * Two axes over the SAME read-only probes the rest of aih already ships:
 *  - GATES (`severity: "gate"`): a failing gate is a BLOCKER — the banner reads
 *    `NOT READY` and the displayed score is capped at 69. These are the "you cannot
 *    work" conditions: no Node/npm, corporate TLS broken, a committed secret, a
 *    bootloader that won't load, core shell tools or git absent.
 *  - WARNS (`severity: "warn"`): a failing warn DINGS the 0–100 score across three
 *    equal-weight dimensions (machine · repo-contract · harness-wiring) but never
 *    blocks. These are the "you can work, but sand in the gears" conditions.
 *
 * A check is a pass/fail reused from the underlying probe's own `fail`/`pass`/`skip`
 * verdict; `skip`/not-applicable is neither pass nor fail and is EXCLUDED from both
 * scoring and blocking. Posture (see {@link postureFromContext}) promotes two amber
 * warn-at-vibe gates — a committed secret, and git-absent / stale-contract — to hard
 * gates at team/enterprise, following the same split `secrets`/governance already use.
 *
 * Pure composition: every signal is one of aih's existing read-only probes (heal's
 * node/npm/TLS ladder, per-CLI loadability, the contract truth check, the secret
 * scan). Deterministic — no Date.now/random — so dry-run and `--verify` agree.
 */

type Severity = "gate" | "warn";
type Dimension = "machine" | "repo-contract" | "harness-wiring";

/** One readiness signal: an underlying probe verdict, graded gate-vs-warn for a dimension. */
interface ReadinessCheck {
  id: string;
  title: string;
  severity: Severity;
  dimension: Dimension;
  /** Underlying verdict. `skip` ⇒ not-applicable ⇒ excluded from scoring AND blocking. */
  verdict: Check["verdict"];
  /** Copy-pasteable fix, surfaced when the check fails. */
  cmd: string;
}

/** A blocker/warn row echoed into `.data` for the (later) v9 panel + the text body. */
export interface ReadinessRow {
  id: string;
  title: string;
  cmd: string;
  dimension: Dimension;
}

/**
 * The full computed readiness picture — one composition of aih's read-only probes,
 * shared by the digest (rich body) and the `aih ready` gate (exit-code probe) so the
 * signal is computed ONCE per run. Deterministic: no clock, no random.
 */
export interface ReadinessResult {
  banner: "NOT READY" | "READY" | "READY, WITH GAPS";
  blockers: ReadinessRow[];
  warns: ReadinessRow[];
  score: number;
  rawScore: number;
  grade: Grade;
  dims: DimensionResult[];
  firstCommand: string | null;
}

const SCORE_CAP_WITH_BLOCKER = 69;
const READY_THRESHOLD = 70;

/** Turn a captured heal-step {@link Check} into a plain verdict (running its probe). */
async function verdictOf(action: Action | undefined, ctx: PlanContext): Promise<Check | undefined> {
  if (action?.kind !== "probe") return undefined;
  return action.run(ctx);
}

/**
 * Pull the authoritative {@link Check} a heal step captured, matched by its stable
 * `code`. Reusing the step's own diagnosis (rather than re-deriving) keeps readiness
 * byte-identical to what `aih heal` reports for the same box. `shared` carries the
 * one TLS handshake so cert/npm never re-probe the network.
 */
async function healCheck(
  step: { plan: (ctx: PlanContext, shared: HealShared) => Promise<Action[]> },
  ctx: PlanContext,
  shared: HealShared,
  code: Check["code"],
): Promise<Check | undefined> {
  const actions = await step.plan(ctx, shared);
  for (const action of actions) {
    const c = await verdictOf(action, ctx);
    if (c && c.code === code) return c;
    // A passing captured check carries no code — match by the step's canonical name.
    if (c && code === undefined) return c;
  }
  return undefined;
}

/** The first captured `probe` check a heal step emits (its primary diagnosis). */
async function firstHealCheck(
  step: { plan: (ctx: PlanContext, shared: HealShared) => Promise<Action[]> },
  ctx: PlanContext,
  shared: HealShared,
): Promise<Check | undefined> {
  const actions = await step.plan(ctx, shared);
  for (const action of actions) {
    const c = await verdictOf(action, ctx);
    if (c) return c;
  }
  return undefined;
}

/** node runtime on PATH (heal's own `versionArgv`/`classifyTool`) — GATE (machine). */
async function nodeVerdict(ctx: PlanContext): Promise<Check["verdict"]> {
  const res = await ctx.run(versionArgv(ctx.host.platform, "node"));
  return classifyTool(res, ctx.host.platform === "windows") === "absent" ? "fail" : "pass";
}

/** npm present and runnable — GATE (machine). Blocked on node ⇒ skip (node gate owns it). */
async function npmVerdict(ctx: PlanContext, nodeOk: boolean): Promise<Check["verdict"]> {
  if (!nodeOk) return "skip";
  const res = await ctx.run(versionArgv(ctx.host.platform, "npm"));
  return classifyTool(res, ctx.host.platform === "windows") === "ok" ? "pass" : "fail";
}

/** git resolvable on PATH — heal-shaped runner probe (mirrors doctor's `git available`). */
async function gitVerdict(ctx: PlanContext): Promise<Check["verdict"]> {
  const res = await ctx.run(["git", "--version"]);
  return res.spawnError ? "fail" : "pass";
}

/** rg/fd/jq — reuse {@link toolsInstalledDigest}'s coreMissing without a second spawn set. */
async function coreToolsMissing(ctx: PlanContext): Promise<string[]> {
  const missing: string[] = [];
  for (const bin of ["rg", "fd", "jq"]) {
    const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
    const res = await ctx.run(argv);
    if (res.spawnError || res.code !== 0 || res.stdout.trim().length === 0) missing.push(bin);
  }
  return missing;
}

/** Any committed plaintext / hardcoded secret (value-blind) — the secret gate signal. */
function secretsPresent(root: string): boolean {
  return scanSecrets(root).matches.length > 0 || scanConfigSecrets(root).length > 0;
}

/**
 * Build every readiness check from aih's existing read-only probes. Each carries a
 * severity + dimension so the composer can split them into blockers (failing gates)
 * and scored warns. `skip` verdicts stay in the list but are dropped by the composer.
 */
async function buildChecks(ctx: PlanContext): Promise<ReadinessCheck[]> {
  const { root, contextDir } = ctx;
  const posture = postureFromContext(ctx);
  const out: ReadinessCheck[] = [];

  // ---- machine: host runtime + tooling -----------------------------------
  const tlsRegistry = await tlsCheck(ctx, "tls: registry", REGISTRY_URL);
  const shared: HealShared = { tlsRegistry, tlsPypi: tlsRegistry };

  const node = await nodeVerdict(ctx);
  const nodeOk = node === "pass";
  out.push({
    id: "node-runtime",
    title: "Node.js runtime (>= 20) on PATH",
    severity: "gate",
    dimension: "machine",
    verdict: node,
    cmd: "install Node 20+ (nvm/winget/brew) and re-open the shell",
  });

  out.push({
    id: "npm-runtime",
    title: "npm present and runnable",
    severity: "gate",
    dimension: "machine",
    verdict: await npmVerdict(ctx, nodeOk),
    cmd: "aih heal --scope npm",
  });

  // Corporate TLS/CA trust: the live handshake is the authoritative signal; a set-but-
  // broken NODE_EXTRA_CA_CERTS surfaces through cert-verify's own `cert.ca-missing`.
  const certCode = tlsRegistry.verdict === "fail" ? "tls.verify-failed" : "cert.ca-missing";
  const cert =
    (await healCheck(certStep, ctx, shared, certCode)) ??
    (await firstHealCheck(certStep, ctx, shared));
  out.push({
    id: "tls-ca-trust",
    title: "Corporate TLS/CA trust intact",
    severity: "gate",
    dimension: "machine",
    verdict: tlsRegistry.verdict === "fail" ? "fail" : (cert?.verdict ?? "skip"),
    cmd: "aih heal --scope certs",
  });

  // PATH: a gate ONLY when the installed-tool dir exists but is off PATH (path-heal's
  // own `path.missing`). A non-existent dir ⇒ `skip` ⇒ not-applicable (omitted).
  const path = await firstHealCheck(pathStep, ctx, shared);
  out.push({
    id: "toolbin-on-path",
    title: "Installed-tool dir on PATH",
    severity: "gate",
    dimension: "machine",
    verdict: path?.verdict ?? "skip",
    cmd: "aih heal --scope path",
  });

  // git: WARN at vibe, GATE at team/enterprise (an amber promote, like the secret gate).
  out.push({
    id: "git-present",
    title: "git available on PATH",
    severity: posture === "vibe" ? "warn" : "gate",
    dimension: "machine",
    verdict: await gitVerdict(ctx),
    cmd: "install git (winget/apt/brew) and re-run",
  });

  // Core shell tools (rg/fd/jq) — a real gap the agent guidance leans on. GATE.
  const coreMissing = await coreToolsMissing(ctx);
  out.push({
    id: "core-shell-tools",
    title: "Core shell tools (rg, fd, jq) on PATH",
    severity: "gate",
    dimension: "machine",
    verdict: coreMissing.length === 0 ? "pass" : "fail",
    cmd: "install rg, fd, jq (winget/scoop/brew) or add your VDI bundle to PATH",
  });

  // A runnable AI CLI on this machine (config-only ⇒ no CLI can drive the change). WARN.
  const coverage = scanCliCoverage(ctx);
  const anyLoadable = coverage.provenLoadable > 0 || coverage.structurallyConfigured > 0;
  out.push({
    id: "runnable-ai-cli",
    title: "A configured AI CLI for this repo",
    severity: "warn",
    dimension: "machine",
    verdict: anyLoadable ? "pass" : "fail",
    cmd: "install a CLI (claude/codex/…) then: aih bootstrap-ai --apply",
  });

  // ---- repo-contract: freshness + declared commands + secrets ------------
  // A stale/non-portable contract is an amber warn-at-vibe that ENTERPRISE promotes to
  // a hard GATE (the locked taxonomy). Two teeth combine: contractTruthCheck already
  // posture-grades the VERDICT (stale stays `pass` at vibe/team, fails at enterprise),
  // and here the SEVERITY flips to `gate` at enterprise so a real stale-contract fail
  // BLOCKS rather than just dinging — mirroring the git/secret amber-gate promotion.
  const contract = await contractTruthCheck(ctx);
  out.push({
    id: "contract-fresh",
    title: "Repo contract present, portable, and current",
    severity: posture === "enterprise" ? "gate" : "warn",
    dimension: "repo-contract",
    verdict: contract.verdict,
    cmd: "aih contract --apply",
  });

  // Declared build/test/lint are unverified until Phase-2 command running — surfaced
  // as a WARN when a repo declares none of them (nothing for the agent to lean on).
  const stack = scanRepo(root, { maxDepth: 8, contextDir });
  const hasRunnable = Boolean(stack.testRunner || stack.buildCommand || stack.startCommand);
  out.push({
    id: "declared-commands",
    title: "Declared build/test/start command",
    severity: "warn",
    dimension: "repo-contract",
    verdict: hasRunnable ? "pass" : "skip",
    cmd: "add a test/build/start script to package.json",
  });

  // Plaintext/hardcoded committed secret: GATE at team/enterprise, WARN at vibe — the
  // exact split the `secrets` control uses. A finding is a fail; none ⇒ pass.
  out.push({
    id: "no-committed-secret",
    title: "No plaintext/hardcoded secret committed",
    severity: posture === "vibe" ? "warn" : "gate",
    dimension: "repo-contract",
    verdict: secretsPresent(root) ? "fail" : "pass",
    cmd: "move secrets to env refs; run: aih secrets --apply",
  });

  // ---- harness-wiring: loadability + guardrails --------------------------
  // Bootloader loadability: a targeted CLI whose bootloader is present-but-`wontLoad`
  // is a hard GATE (the agent silently loads nothing). `unverified` ⇒ not-applicable.
  const targeted = coverage.rows.filter((r) => r.targeted);
  const wontLoad = targeted.some((r) => r.load.verdict === "wontLoad");
  const anyLoads = targeted.some((r) => r.load.verdict === "loads");
  out.push({
    id: "bootloader-loads",
    title: "Targeted CLI bootloader actually loads",
    severity: "gate",
    dimension: "harness-wiring",
    verdict: wontLoad ? "fail" : anyLoads ? "pass" : "skip",
    cmd: "aih bootstrap-ai --apply",
  });

  // Bootloader WIRING (present + in sync) — a WARN: a `missing` bootloader cell dings
  // the score but is not itself a blocker (the loadability gate above owns "won't load").
  const bootloaderMissing = targeted.some((r) => r.bootloader.state === "missing");
  const anyTargeted = targeted.length > 0;
  out.push({
    id: "bootloader-wired",
    title: "Targeted CLI bootloader present + in sync",
    severity: "warn",
    dimension: "harness-wiring",
    verdict: !anyTargeted ? "skip" : bootloaderMissing ? "fail" : "pass",
    cmd: "aih bootstrap-ai --apply",
  });

  // pre-commit config present but the git hook is not installed — a WARN (inert config).
  const inv = inventory(root, contextDir);
  const preCommitConfig = inv.find((i) => i.name === "pre-commit")?.present ?? false;
  out.push({
    id: "pre-commit-active",
    title: "pre-commit hook active (not just configured)",
    severity: "warn",
    dimension: "harness-wiring",
    verdict: !preCommitConfig ? "skip" : preCommitHookActive(root) ? "pass" : "fail",
    cmd: "git config core.hooksPath .githooks",
  });

  // Guardrail artifacts (gitleaks config) absent — a WARN.
  const gitleaks = inv.find((i) => i.name === "gitleaks")?.present ?? false;
  out.push({
    id: "guardrail-artifacts",
    title: "Leak-prevention guardrail configured",
    severity: "warn",
    dimension: "harness-wiring",
    verdict: gitleaks ? "pass" : "fail",
    cmd: "aih guardrails --apply",
  });

  // Third-party MCP egress unvetted / npx MCP can't launch. The launch failure is a
  // conditional GATE (only when the repo declares an npx MCP — mcp-probe's `mcp.blocked`);
  // not-applicable ⇒ `skip`.
  const mcp =
    (await healCheck(mcpStep, ctx, shared, "mcp.blocked")) ??
    (await firstHealCheck(mcpStep, ctx, shared));
  out.push({
    id: "mcp-launches",
    title: "Declared npx MCP servers can launch",
    severity: "gate",
    dimension: "harness-wiring",
    verdict: mcp?.verdict === "fail" ? "fail" : "skip",
    cmd: "aih heal --scope mcp",
  });

  return out;
}

/**
 * A dimension's warn-tier checks → a scored {@link DimensionResult} (pass/fail only).
 * A dimension with NO applicable warn checks scores 100 (nothing to ding) rather than
 * `dimScore([])`'s 0 — an all-`skip` dimension is fully ready, not fully failing.
 */
function dimensionOf(name: Dimension, checks: ReadinessCheck[]): DimensionResult {
  const warns = checks.filter(
    (c) => c.dimension === name && c.severity === "warn" && c.verdict !== "skip",
  );
  if (warns.length === 0) return { name, weight: 1, score: 100, checks: [] };
  const results: CheckResult[] = warns.map((c) =>
    check(c.id, c.verdict === "pass", c.cmd, c.title),
  );
  return dim(name, 1, results);
}

/**
 * Compute the full {@link ReadinessResult} from aih's read-only probes. Failing gates
 * ⇒ blockers; failing warns ⇒ score dings; `skip` never counts. The single source of
 * truth shared by {@link readinessDigest} (the rich body) and the `aih ready` gate
 * (the exit-code probe), so both agree without double-computing.
 */
export async function computeReadiness(ctx: PlanContext): Promise<ReadinessResult> {
  const checks = await buildChecks(ctx);

  const blockers: ReadinessRow[] = checks
    .filter((c) => c.severity === "gate" && c.verdict === "fail")
    .map((c) => ({ id: c.id, title: c.title, cmd: c.cmd, dimension: c.dimension }));

  const warns: ReadinessRow[] = checks
    .filter((c) => c.severity === "warn" && c.verdict === "fail")
    .map((c) => ({ id: c.id, title: c.title, cmd: c.cmd, dimension: c.dimension }));

  const dims: DimensionResult[] = [
    dimensionOf("machine", checks),
    dimensionOf("repo-contract", checks),
    dimensionOf("harness-wiring", checks),
  ];
  const rawScore = Math.round(dims.reduce((n, d) => n + d.score, 0) / dims.length);
  const hasBlocker = blockers.length > 0;
  const score = hasBlocker ? Math.min(rawScore, SCORE_CAP_WITH_BLOCKER) : rawScore;
  const grade: Grade = gradeOf(score);

  const banner: ReadinessResult["banner"] = hasBlocker
    ? "NOT READY"
    : score >= READY_THRESHOLD
      ? "READY"
      : "READY, WITH GAPS";

  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const firstCommand = stack.startCommand ?? stack.testRunner ?? null;

  return { banner, blockers, warns, score, rawScore, grade, dims, firstCommand };
}

/** Failing gates ⇒ blockers; failing warns ⇒ score dings. `skip` never counts. */
export function readinessDigest(ctx: PlanContext): DigestAction {
  return {
    kind: "digest",
    describe: "Developer readiness",
    run: async () => {
      const r = await computeReadiness(ctx);
      const data = {
        banner: r.banner,
        blockers: r.blockers,
        score: r.score,
        rawScore: r.rawScore,
        grade: r.grade,
        warns: r.warns,
        firstCommand: r.firstCommand,
      };
      return { text: renderReadinessBody(r), data };
    },
  };
}

/** Terse, deterministic human summary: banner, blockers, per-dimension line, warn count. */
export function renderReadinessBody(r: ReadinessResult): string {
  const { banner, blockers, warns, dims, score, grade } = r;
  const mark = (s: number): string => (s >= READY_THRESHOLD ? "✓" : s >= 50 ? "~" : "·");
  return lines(
    `${banner} — ${score}/100 (${grade})`,
    "",
    ...(blockers.length > 0
      ? remediationBlock(
          `  ${blockers.length} blocker${blockers.length === 1 ? "" : "s"} — must fix before an agent can work:`,
          blockers.map((b) => ({ command: b.cmd, label: b.title })),
        )
      : ["  No blockers — nothing stops an agent from working here."]),
    "",
    ...dims.map((d) => `  ${mark(d.score)} ${d.name.padEnd(16)} ${d.score}/100`),
    "",
    warns.length > 0
      ? `  ${warns.length} warn${warns.length === 1 ? "" : "s"} dinging the score (see the dimension lines above).`
      : "  No warnings — every applicable check passes.",
  );
}
