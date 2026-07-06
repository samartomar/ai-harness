import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { readAihConfig } from "../config/marker.js";
import { resolvePosture } from "../config/posture.js";
import { loadSettings } from "../config/settings.js";
import { AihError } from "../errors.js";
import { optionSource } from "../internals/commander-options.js";
import {
  executePlan,
  type PlanResult,
  summarizeResult,
  writeArtifact,
} from "../internals/execute.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type CommandOption,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { makeHostAdapter } from "../platform/detect.js";
import { AIH_SKILLS_LOCK_FILE } from "../skill/lockfile.js";
import { buildSupport, supportSummary } from "../support/integrate.js";
import { localDriftChecks } from "../trust/commands.js";
import { cleanupQuarantine, resolveTrustSource, type TrustSource } from "../trust/fetch.js";
import { readTrustLock } from "../trust/lock.js";
import { TRUST_SKIP_DIRS } from "../trust/scan.js";
import {
  type ClearedWorkspaceAddTrustGate,
  captureClearedWorkspaceAddTrustGate,
  workspaceAddPhase1Plan,
  workspaceAddPhase2Plan,
} from "../workspace/acquire.js";
import { AIH_PACKS_FILE } from "./manifest.js";
import { type PackSkillStatus, type PackStatus, packStatus } from "./status.js";

/**
 * `aih pack install` / `aih pack plan` — slice 3 of packs: drive the EXISTING
 * two-phase gated acquisition pipeline (`workspace add`'s fetch → scan → gate →
 * promote) once per SOURCE the pack curates, promoting ONLY the pack's refs
 * (`selectSkills` subset through {@link workspaceAddPhase2Plan}). Three
 * fail-closed properties define the command:
 *
 * 1. APPROVAL-DRIVEN AT EVERY POSTURE — `packStatus` is the entry gate: any ref
 *    with a `missing-approval` or `pin-mismatch` refuses BEFORE any fetch.
 *    Installing from a curation manifest without clean approvals is a
 *    contradiction, so vibe's advisory ladder deliberately does not apply.
 * 2. PINS COME FROM THE LOCK — each github ref resolves `owner/repo` pinned to
 *    its `aih-skills.lock.json` commit (the pin authority); local refs resolve
 *    the recorded path. The manifest never invents a pin.
 * 3. GATE ALL SOURCES BEFORE PROMOTING ANY — phase A runs fetch+scan+capture
 *    for EVERY source (sequential, one quarantine at a time on the wire);
 *    phase B promotes only when every source cleared. One poisoned source
 *    blocks the whole pack; quarantines are cleaned in `finally` either way.
 *
 * `aih pack plan` is the read-only preview of the same resolution + gate: it
 * never fetches and never writes (a remote scan is fetch-blocked in dry-run
 * anyway). `pack install` without `--apply` behaves exactly like `plan`.
 */

interface PackInstallDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  now?: () => Date;
  newRunId?: () => string;
}

type PackSkillOutcome =
  | "installed"
  | "already-installed"
  | "failed-scan"
  | "skipped-because-gate-failed";

interface PackSourceGroup {
  /** Lock-recorded source string (github: `owner/repo@<sha>`; local: the recorded path). */
  source: string;
  /** Lock-pinned commit (full SHA) or `"local"`. */
  commit: string;
  kind: "github" | "local";
  /** Refs still to install from this source. */
  pending: PackSkillStatus[];
  /** Refs already live on disk (idempotent re-run: reported, never re-promoted). */
  installed: PackSkillStatus[];
  /** Pending refs that are on disk but DRIFTED from trust-lock receipts (reinstalling). */
  driftedNames: string[];
}

/** One source's trip through the two-phase pipeline. */
interface SourceRun {
  group: PackSourceGroup;
  /** Absent when the source failed to RESOLVE (recorded in `failure`). */
  source?: TrustSource;
  /** The pack's refs for this source — the `selectSkills` promotion subset. */
  select: ReadonlySet<string>;
  phase1?: PlanResult;
  gate?: ClearedWorkspaceAddTrustGate;
  phase2?: PlanResult;
  /** Failure detail when this source's scan / gate / promotion failed. */
  failure?: string;
}

interface PackSkillOutcomeRow {
  name: string;
  source: string;
  commit: string;
  outcome: PackSkillOutcome;
  detail?: string;
}

const FULL_SHA = /^[a-f0-9]{40}$/;

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function requirePackName(ctx: PlanContext, command: string): string {
  const raw = ctx.options.pack;
  const name = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  if (name === undefined) {
    throw refuse(`pack ${command} requires --pack <name> — the pack to ${command}`);
  }
  return name;
}

/**
 * v1 keeps acknowledgement scoping OUT of pack installs: an acknowledgement is a
 * per-source, per-fingerprint operator decision, and a pack run spans several
 * sources — a blanket flag here would silently widen a targeted override.
 */
function refuseAcknowledgeFlags(ctx: PlanContext): void {
  if (ctx.options.acknowledge !== undefined || ctx.options.acknowledgeAll === true) {
    throw refuse(
      "pack install does not take --acknowledge — acknowledgements are per-source; run " +
        "`aih workspace add <source> --acknowledge <fingerprints> --reason <text>` for that flow",
    );
  }
}

function shortCommit(commit: string): string {
  return commit === "local" ? "local" : commit.slice(0, 12);
}

/**
 * The fail-closed entry gate shared by `plan` and `install`, enforced at EVERY
 * posture: every ref must be cleanly approved (`packStatus` approval axis)
 * before anything is fetched or scanned.
 */
function gatedPackStatus(ctx: PlanContext, command: string): PackStatus {
  const packName = requirePackName(ctx, command);
  const report = packStatus(ctx, packName);
  if (!report.manifestPresent) {
    throw refuse(
      `no ${AIH_PACKS_FILE} at the repo root — nothing to ${command}; curate one with \`aih pack add\``,
    );
  }
  const pack = report.packs[0];
  if (pack === undefined) {
    throw refuse(`no pack named "${packName}" in ${AIH_PACKS_FILE}`);
  }
  const blocked = pack.skills.filter((ref) => ref.approval !== "approved");
  if (blocked.length > 0) {
    const listing = blocked
      .map((ref) => `  - ${ref.name}: ${ref.approval}  (${ref.source}@${shortCommit(ref.commit)})`)
      .join("\n");
    throw refuse(
      `pack ${packName} is blocked — every ref needs a clean ${AIH_SKILLS_LOCK_FILE} approval before any fetch:\n` +
        `${listing}\n` +
        `run \`aih pack validate --pack ${packName}\` for the coded findings; approve with ` +
        "`aih skill vet <source> --apply` then `aih skill approve <source> --pin <sha> --owner <team> --apply`",
    );
  }
  return pack;
}

/**
 * Skill names whose PROMOTED files no longer match the trust-lock receipts —
 * missing or hash-changed on disk (tampered, hand-edited, or partially deleted).
 * An "already installed" ref with drift must NOT be skipped as a success: it is
 * routed back through the full gated pipeline so the pinned source's content is
 * re-promoted (the dirty-worktree gate still fronts any overwrite). Pure fs.
 */
function driftedSkillNames(ctx: PlanContext): Set<string> {
  const drifted = new Set<string>();
  for (const source of readTrustLock(ctx.root).sources) {
    for (const check of localDriftChecks(ctx, source)) {
      if (check.verdict !== "fail") continue;
      const path = (check.location?.uri ?? "").replace(/\\/g, "/");
      const hits = source.promotedSkills.filter(
        (name) => path === `skills/${name}` || path.startsWith(`skills/${name}/`),
      );
      // A drifted artifact that maps to no specific skill (root-level layouts)
      // conservatively re-drives every skill the source promoted.
      for (const name of hits.length > 0 ? hits : source.promotedSkills) drifted.add(name);
    }
  }
  return drifted;
}

/** Group the pack's refs by (source, commit), sorted — one pipeline run per group.
 * Installed refs whose promoted files DRIFTED from the trust-lock receipts are
 * routed back to `pending` (reinstall through the gate), never counted as done. */
function groupBySource(pack: PackStatus, drifted: ReadonlySet<string>): PackSourceGroup[] {
  const groups = new Map<string, PackSourceGroup>();
  for (const ref of pack.skills) {
    const key = JSON.stringify([ref.source, ref.commit]);
    const group = groups.get(key) ?? {
      source: ref.source,
      commit: ref.commit,
      kind: ref.commit === "local" ? ("local" as const) : ("github" as const),
      pending: [],
      installed: [],
      driftedNames: [],
    };
    if (ref.install === "installed" && drifted.has(ref.name)) {
      group.pending.push(ref);
      group.driftedNames.push(ref.name);
    } else {
      (ref.install === "installed" ? group.installed : group.pending).push(ref);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.commit.localeCompare(b.commit),
  );
}

/** The `owner/repo` part of a lock source string (`owner/repo@<sha>` → `owner/repo`). */
function githubRepoPart(source: string): string {
  const at = source.indexOf("@");
  return at >= 0 ? source.slice(0, at) : source;
}

/**
 * Resolve one group's trust source. The LOCK is the pin authority: github refs
 * resolve `owner/repo` pinned to the lock entry's commit; local refs
 * (`commit: "local"`) resolve the recorded path. Fail-closed on kind confusion —
 * a sha-pinned ref that resolves to a local directory (or a "local" ref that
 * resolves remote) is refused, never silently reinterpreted: that would install
 * content the pin does not govern.
 */
function resolveGroupSource(ctx: PlanContext, group: PackSourceGroup): TrustSource {
  if (group.kind === "local") {
    const source = resolveTrustSource(group.source, { root: ctx.root, skipDirs: TRUST_SKIP_DIRS });
    if (source.kind !== "local") {
      throw refuse(
        `pack ref source ${group.source} is approved as local (commit "local") but does not resolve to a local path`,
      );
    }
    return source;
  }
  if (!FULL_SHA.test(group.commit)) {
    throw refuse(
      `pack ref source ${group.source} carries commit "${group.commit}" — not a full lowercase Git SHA ` +
        'and not "local"; re-approve with `aih skill approve <source> --pin <full-sha>`',
    );
  }
  const repo = githubRepoPart(group.source);
  const source = resolveTrustSource(repo, {
    root: ctx.root,
    pin: group.commit,
    skipDirs: TRUST_SKIP_DIRS,
  });
  if (source.kind !== "github") {
    throw refuse(
      `pack ref source ${group.source} is pinned to ${shortCommit(group.commit)} but "${repo}" ` +
        "resolves to a local directory — refusing the ambiguous source",
    );
  }
  return source;
}

function previewSourceLines(ctx: PlanContext, group: PackSourceGroup): string[] {
  const localMissing = group.kind === "local" && !existsSync(resolve(ctx.root, group.source));
  const action =
    group.kind === "github"
      ? "fetch → scan → promote"
      : localMissing
        ? "scan → promote (local source path is MISSING — install will refuse)"
        : "scan → promote";
  return [
    `${group.source} (${group.kind}${group.kind === "github" ? `, pin ${shortCommit(group.commit)}` : ""}):`,
    ...group.pending.map((ref) => `  - ${ref.name} — ${action}`),
    ...group.installed.map((ref) => `  - ${ref.name} — already installed (no action)`),
  ];
}

function previewData(pack: PackStatus, groups: PackSourceGroup[]): unknown {
  return {
    pack: pack.name,
    pending: groups.reduce((n, g) => n + g.pending.length, 0),
    alreadyInstalled: groups.reduce((n, g) => n + g.installed.length, 0),
    sources: groups.map((group) => ({
      source: group.source,
      commit: group.commit,
      kind: group.kind,
      skills: [
        ...group.pending.map((ref) => ({ name: ref.name, action: "install" as const })),
        ...group.installed.map((ref) => ({
          name: ref.name,
          action: "already-installed" as const,
        })),
      ],
    })),
  };
}

/**
 * The read-only preview both commands share: the same gate + resolution, a
 * per-source / per-skill digest of what install WOULD do — no fetch, no writes
 * (github sources are never resolved here, so not even a quarantine dir is
 * created).
 */
function previewPlan(ctx: PlanContext, pack: PackStatus): Plan {
  const groups = groupBySource(pack, driftedSkillNames(ctx));
  const pending = groups.reduce((n, g) => n + g.pending.length, 0);
  if (pending === 0) {
    return plan(
      "pack install",
      digest(
        "pack install plan",
        lines(
          `pack ${pack.name} is fully installed — ${pack.counts.skills} skill(s) already on disk; nothing to do`,
        ),
        previewData(pack, groups),
      ),
    );
  }
  const activeSources = groups.filter((group) => group.pending.length > 0).length;
  const body: string[] = [
    `pack ${pack.name} — ${pack.counts.skills} skills · ${pack.counts.approved} approved · ${pack.counts.installed} installed`,
    `would install ${pending} skill(s) from ${activeSources} source(s), gated per source: fetch (github) → trust scan → capture → promote only the pack's refs`,
    "",
  ];
  groups.forEach((group, i) => {
    if (i > 0) body.push("");
    body.push(...previewSourceLines(ctx, group));
  });
  body.push(
    "",
    "nothing fetched, nothing written — remote scans are fetch-blocked in dry-run.",
    `run \`aih pack install --pack ${pack.name} --apply\` to execute the gated install.`,
  );
  return plan(
    "pack install",
    digest("pack install plan", lines(...body), previewData(pack, groups)),
  );
}

function packPlanPlan(ctx: PlanContext): Plan {
  refuseAcknowledgeFlags(ctx);
  return previewPlan(ctx, gatedPackStatus(ctx, "plan"));
}

function hasFailedExec(result: PlanResult): boolean {
  return result.execs.some((item) => item.ran && item.ok === false);
}

function readSetupText(root: string): string | undefined {
  for (const rel of ["SETUP.md", "docs/SETUP.md", ".aih/SETUP.md"]) {
    const text = readIfExists(join(root, rel));
    if (text !== undefined) return text;
  }
  return undefined;
}

/** Mirrors `workspace add`'s support glue — ticket-ready escalations from the checks. */
function saveSupport(
  ctx: PlanContext,
  checks: Check[],
  opts: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  runId: string,
  timestamp: string,
): void {
  if (checks.length === 0) return;
  const support = buildSupport({
    capability: "pack install",
    checks,
    projectName: basename(ctx.root) || "this project",
    root: ctx.root,
    command: "aih pack install --apply --verify",
    contextDir: ctx.contextDir,
    targets: (readAihConfig(ctx.root)?.targets ?? []).join(", ") || "none",
    platform: ctx.host.platform,
    runId,
    timestamp,
    setupText: readSetupText(ctx.root),
    env,
  });
  let saved: Record<string, string> | undefined;
  const supportOut = opts.supportOut;
  if (typeof supportOut === "string" && supportOut.length > 0) {
    saved = {};
    for (const template of support.templates) {
      const rel = `${supportOut}/${template.code.replace(/[^a-z0-9.-]/gi, "_")}.md`;
      writeArtifact(ctx, rel, `${template.subject}\n\n${template.body}`);
      saved[template.code] = rel;
    }
  }
  write(supportSummary(support, saved));
}

function contextFromCommand(command: Command, deps: PackInstallDeps): PlanContext {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const resolvedRoot = resolve((opts.root as string | undefined) ?? env.AIH_ROOT ?? process.cwd());
  const marker = readAihConfig(resolvedRoot);
  const contextDirSource = optionSource(command, "contextDir");
  const contextDirFromFlag = contextDirSource === "cli" ? (opts.contextDir as string) : undefined;
  const contextDirFromMarker = contextDirFromFlag === undefined ? marker?.contextDir : undefined;
  const postureFlagSource = optionSource(command, "posture") === "cli" ? "cli" : undefined;
  const resolvedPosture = resolvePosture({
    root: resolvedRoot,
    env,
    flag: opts.posture,
    flagSource: postureFlagSource,
    marker,
  });
  const settings = loadSettings(env, {
    apply: opts.apply as boolean | undefined,
    verify: true,
    json: opts.json as boolean | undefined,
    contextDir: contextDirFromFlag ?? contextDirFromMarker,
    root: resolvedRoot,
  });
  const host = makeHostAdapter({ run, env });
  return {
    root: settings.root,
    contextDir: settings.contextDir,
    posture: resolvedPosture.posture,
    postureSource: resolvedPosture.postureSource,
    apply: settings.apply,
    verify: true,
    json: settings.json,
    run,
    host,
    env,
    options: {
      pack: opts.pack,
      force: opts.force,
      acknowledge: opts.acknowledge,
      acknowledgeAll: opts.acknowledgeAll,
    },
  };
}

/** The outcome for one pending ref, from its source's run. */
function pendingOutcome(run: SourceRun): PackSkillOutcome {
  if (run.failure !== undefined) return "failed-scan";
  return run.phase2 !== undefined ? "installed" : "skipped-because-gate-failed";
}

function outcomeRows(
  groups: PackSourceGroup[],
  runs: ReadonlyMap<PackSourceGroup, SourceRun>,
): PackSkillOutcomeRow[] {
  return groups.flatMap((group) => {
    const run = runs.get(group);
    const failure = run?.failure;
    return [
      ...group.pending.map((ref) => ({
        name: ref.name,
        source: ref.source,
        commit: ref.commit,
        outcome: run !== undefined ? pendingOutcome(run) : ("skipped-because-gate-failed" as const),
        ...(failure !== undefined ? { detail: failure } : {}),
      })),
      ...group.installed.map((ref) => ({
        name: ref.name,
        source: ref.source,
        commit: ref.commit,
        outcome: "already-installed" as const,
      })),
    ];
  });
}

function outcomeText(packName: string, rows: PackSkillOutcomeRow[]): string {
  const count = (outcome: PackSkillOutcome): number =>
    rows.filter((row) => row.outcome === outcome).length;
  return lines(
    `pack ${packName} — install outcome`,
    ...rows.map(
      (row) =>
        `  - ${row.name}  [${row.outcome}]  (${row.source}@${shortCommit(row.commit)})${
          row.detail !== undefined ? ` — ${row.detail}` : ""
        }`,
    ),
    `${count("installed")} installed · ${count("already-installed")} already installed · ` +
      `${count("failed-scan")} failed · ${count("skipped-because-gate-failed")} skipped`,
  );
}

/**
 * The install runner — mirrors `runWorkspaceAdd`'s shape (context → phase 1 →
 * gate → phase 2 → summaries + support), looped per source with the gate-all
 * ordering documented on the module. Registered with a dedicated commander
 * action (like `workspace add`) because one invocation composes several plans.
 */
export async function runPackInstall(
  command: Command,
  deps: PackInstallDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const runId = (deps.newRunId ?? (() => `run_${randomUUID().slice(0, 8)}`))();
  const startedAt = (deps.now ?? (() => new Date()))();
  let json = false;
  const resolved: TrustSource[] = [];
  try {
    const ctx = contextFromCommand(command, deps);
    json = ctx.json;
    refuseAcknowledgeFlags(ctx);
    const pack = gatedPackStatus(ctx, "install");
    const groups = groupBySource(pack, driftedSkillNames(ctx));
    const pendingCount = groups.reduce((n, g) => n + g.pending.length, 0);

    // No --apply behaves exactly like `aih pack plan`; a fully installed pack is
    // the friendly idempotent no-op either way (exit 0, nothing re-promoted).
    if (!ctx.apply || pendingCount === 0) {
      const result = await executePlan(previewPlan(ctx, pack), ctx);
      if (json) write(`${JSON.stringify({ plan: result }, null, 2)}\n`);
      else write(`${summarizeResult(result)}\n`);
      return 0;
    }

    // Resolve EVERY source before any fetch or scan — a broken ref poisons the
    // whole install while the workspace is still byte-for-byte untouched. Each
    // resolution is try/caught so a source that VANISHED after packStatus (or any
    // resolver throw) lands in that source's outcome row, not a generic error.
    let anyFailure = false;
    const runs: SourceRun[] = groups
      .filter((group) => group.pending.length > 0)
      .map((group) => {
        const run: SourceRun = {
          group,
          select: new Set(group.pending.map((ref) => ref.name)),
        };
        try {
          run.source = resolveGroupSource(ctx, group);
          resolved.push(run.source);
        } catch (err) {
          run.failure = err instanceof Error ? err.message : String(err);
          anyFailure = true;
        }
        return run;
      });

    // PHASE A — fetch + scan + capture the cleared gate for ALL sources. Every
    // source is scanned even after a failure so the digest is complete, but a
    // single failure poisons the whole run.
    // Every step below is per-source try/caught: a mid-loop THROW (a source dir
    // vanished after packStatus, a dirty-worktree refusal, an fs error) must land
    // in that source's outcome row — never escape to the generic outer catch,
    // which would discard the whole per-source report. In phase B that matters
    // doubly: an earlier source's promotion may ALREADY be on disk, and the
    // operator must see the accurate partial picture, not a bare error line.
    for (const run of runs) {
      if (run.source === undefined) continue; // resolution already failed above
      try {
        const phase1 = await executePlan(await workspaceAddPhase1Plan(ctx, run.source), ctx);
        run.phase1 = phase1;
        if ((phase1.report?.exitCode() ?? 0) !== 0 || hasFailedExec(phase1)) {
          run.failure = `trust scan failed for ${run.group.source}`;
          anyFailure = true;
          continue;
        }
        run.gate = await captureClearedWorkspaceAddTrustGate(
          ctx,
          phase1.report,
          run.source,
          run.select,
        );
        const blockingChecks = run.gate.blockingChecks ?? [];
        if (blockingChecks.length > 0) {
          const codes = blockingChecks
            .map((check) => check.code ?? check.name)
            .filter((code, index, all) => all.indexOf(code) === index)
            .join(", ");
          run.failure = `trust gate blocked ${run.group.source}: ${codes}`;
          anyFailure = true;
        }
      } catch (err) {
        run.failure = err instanceof Error ? err.message : String(err);
        anyFailure = true;
      }
    }

    // PHASE B — promote only when EVERY source cleared phase A. Nothing has
    // been written before this point, so a phase-A failure leaves zero installs.
    // Inside the loop, STOP at the first failure: phase-2 re-verifies each source
    // against its captured gate (binding/hash replay), and once one source fails
    // that re-check, promoting the REST would widen a partial install the operator
    // hasn't seen yet. Earlier successes stay on disk (reported accurately below);
    // an idempotent re-run resumes exactly where this stopped.
    if (!anyFailure) {
      for (const run of runs) {
        if (run.source === undefined || run.gate === undefined) continue;
        try {
          const phase2 = await executePlan(
            await workspaceAddPhase2Plan(ctx, run.gate, run.source, run.select),
            ctx,
          );
          run.phase2 = phase2;
          if ((phase2.report?.exitCode() ?? 0) !== 0 || hasFailedExec(phase2)) {
            run.failure = `promotion failed for ${run.group.source}`;
            anyFailure = true;
            break;
          }
        } catch (err) {
          run.failure = err instanceof Error ? err.message : String(err);
          anyFailure = true;
          break;
        }
      }
    }

    const runsByGroup = new Map(runs.map((run) => [run.group, run]));
    const rows = outcomeRows(groups, runsByGroup);
    const exitCode = anyFailure ? 1 : 0;

    if (json) {
      const payload = {
        pack: pack.name,
        sources: runs.map((run) => ({
          source: run.group.source,
          commit: run.group.commit,
          kind: run.group.kind,
          skills: [...run.select].sort(),
          phase1: run.phase1,
          phase2: run.phase2,
          failure: run.failure,
        })),
        skills: rows,
        exitCode,
      };
      write(`${JSON.stringify(payload, null, 2)}\n`);
      return exitCode;
    }

    for (const run of runs) {
      write(`── ${run.group.source}@${shortCommit(run.group.commit)}\n`);
      if (run.phase1) write(`${summarizeResult(run.phase1)}\n`);
      if (run.phase2) write(`${summarizeResult(run.phase2)}\n`);
      if (run.failure !== undefined && run.phase2 === undefined) {
        // Capture-gate refusals throw instead of reporting — surface the detail.
        write(`  gate: ${run.failure}\n`);
      }
    }
    write(outcomeText(pack.name, rows));
    const allChecks = runs.flatMap((run) => [
      ...(run.phase1?.report?.checks ?? []),
      ...(run.gate?.blockingChecks ?? []),
      ...(run.phase2?.report?.checks ?? []),
    ]);
    saveSupport(ctx, allChecks, opts, env, write, runId, startedAt.toISOString());
    return exitCode;
  } catch (err) {
    const code = err instanceof AihError ? err.code : "AIH_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    if (json) write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    else write(`error [${code}]: ${message}\n`);
    return 1;
  } finally {
    for (const source of resolved) cleanupQuarantine(source);
  }
}

const PACK_INSTALL_OPTION: CommandOption = {
  flags: "--pack <name>",
  description: "the pack to install (required)",
};

export const packPlanCommand: CommandSpec = {
  name: "plan",
  summary: "Preview a pack install per source — read-only, never fetches, never writes",
  readOnly: true,
  options: [{ flags: "--pack <name>", description: "the pack to preview (required)" }],
  plan: packPlanPlan,
};

export const packInstallCommand: CommandSpec = {
  name: "install",
  summary:
    "Install a pack's approved skills through the gated two-phase trust pipeline (--apply executes)",
  options: [
    PACK_INSTALL_OPTION,
    {
      flags: "--acknowledge <fingerprints>",
      description: "refused here — acknowledgements are per-source (use `aih workspace add`)",
    },
    {
      flags: "--acknowledge-all",
      description: "refused here — acknowledgements are per-source (use `aih workspace add`)",
    },
  ],
  plan: packPlanPlan,
  alwaysVerify: true,
};
