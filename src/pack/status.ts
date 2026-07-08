import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type CommandOption,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { type SkillInventoryRow, skillInventory } from "../skill/inventory.js";
import { readSkillsLock, type SkillLockEntry } from "../skill/lockfile.js";
import { AIH_PACKS_FILE, type Pack, type PackSkillRef, readPacksFile } from "./manifest.js";

/**
 * `aih pack status` / `aih pack validate` — slice 1 of packs: the READ-ONLY join
 * that answers "is each curated pack approved and installed?". It is the packs'
 * analog of `skillInventory`: pure fs (plan-purity floor, #35) over three
 * committed/on-disk truths — the `aih-packs.json` manifest, the
 * `aih-skills.lock.json` approvals (the PIN AUTHORITY the manifest refs are
 * cross-checked against), and the on-disk skill inventory. It never re-derives
 * state a write command already recorded, and it never writes.
 */

/**
 * The approval axis for one pack ref, judged against the lock entry of the same
 * name. `pin-mismatch` = a lock entry EXISTS but its source or commit disagrees
 * with the manifest ref — the fail-closed cross-check signal (the lock is the
 * pin authority; a disagreeing manifest is stale or tampered, never a new pin).
 */
export type PackRefApproval = "approved" | "missing-approval" | "pin-mismatch";

/** The install axis for one pack ref, from the on-disk inventory rows of that name. */
export type PackRefInstall = "installed" | "not-installed" | "quarantined" | "stale-pin";

/** One pack skill ref, graded on the two ORTHOGONAL axes (approval × install). */
export interface PackSkillStatus {
  name: string;
  source: string;
  commit: string;
  approval: PackRefApproval;
  install: PackRefInstall;
}

export interface PackStatus {
  name: string;
  description?: string;
  requiredChecks?: string[];
  /** `ready` = every ref approved; `blocked` = any pin-mismatch or missing-approval. */
  rollup: "ready" | "blocked";
  counts: { skills: number; approved: number; installed: number };
  skills: PackSkillStatus[];
}

/** One coded validation finding; `pack` names the flagged pack (unset = manifest-wide). */
export interface PackFinding {
  pack?: string;
  check: Check;
}

export interface PackStatusReport {
  /** Whether `aih-packs.json` exists at all (absent ⇒ friendly empty, never a finding). */
  manifestPresent: boolean;
  packs: PackStatus[];
  findings: PackFinding[];
}

/**
 * The approval cross-check for one ref: the lock entry (keyed by name) must exist
 * AND agree on source + commit. The manifest never overrides the lock — a
 * disagreement fails closed as `pin-mismatch`.
 */
function refApproval(ref: PackSkillRef, entry: SkillLockEntry | undefined): PackRefApproval {
  if (entry === undefined) return "missing-approval";
  return entry.source === ref.source && entry.commit === ref.commit ? "approved" : "pin-mismatch";
}

/**
 * The install axis from the inventory rows sharing the ref's name. A LIVE row
 * outranks a parked one (quarantine only reports when no live copy exists);
 * `stale-pin` surfaces drift on the live copy; `not-installed` (no row at all)
 * is the normal "approve now, install later" state — NOT an error.
 */
function refInstall(rows: readonly SkillInventoryRow[]): PackRefInstall {
  if (rows.length === 0) return "not-installed";
  const live = rows.filter((row) => row.status !== "quarantined");
  if (live.length === 0) return "quarantined";
  if (live.some((row) => row.status === "stale-pin")) return "stale-pin";
  return "installed";
}

/** The coded fail Check for a ref whose approval axis is not clean. */
function approvalFinding(
  packName: string,
  ref: PackSkillRef,
  approval: PackRefApproval,
  entry: SkillLockEntry | undefined,
): PackFinding | undefined {
  if (approval === "missing-approval") {
    return {
      pack: packName,
      check: {
        name: "pack missing approval",
        verdict: "fail",
        code: "pack.missing-approval",
        detail: `pack ${packName}: skill ${ref.name} has no entry in aih-skills.lock.json`,
        location: { uri: AIH_PACKS_FILE },
        fingerprint: `pack-missing-approval:${packName}:${ref.name}`,
      },
    };
  }
  if (approval === "pin-mismatch" && entry !== undefined) {
    return {
      pack: packName,
      check: {
        name: "pack pin mismatch",
        verdict: "fail",
        code: "pack.pin-mismatch",
        detail:
          `pack ${packName}: skill ${ref.name} manifest ref ${ref.source}@${ref.commit} ` +
          `disagrees with the lock entry ${entry.source}@${entry.commit} (the lock is the pin authority)`,
        location: { uri: AIH_PACKS_FILE },
        fingerprint: `pack-pin-mismatch:${packName}:${ref.name}`,
      },
    };
  }
  return undefined;
}

/**
 * Duplicate-name findings across the WHOLE manifest — the same skill name twice
 * in one pack, or in two different packs, flags EVERY pack involved (curation
 * must be unambiguous: one name, one owning pack, once). Computed over the full
 * manifest so a `--pack` filter cannot hide a cross-pack duplicate the filtered
 * pack participates in.
 */
function duplicateFindings(packs: readonly Pack[]): PackFinding[] {
  const occurrences = new Map<string, string[]>();
  for (const pack of packs) {
    for (const ref of pack.skills) {
      const list = occurrences.get(ref.name) ?? [];
      list.push(pack.name);
      occurrences.set(ref.name, list);
    }
  }
  const findings: PackFinding[] = [];
  for (const [name, packNames] of occurrences) {
    if (packNames.length < 2) continue;
    const involved = [...new Set(packNames)];
    for (const packName of involved) {
      findings.push({
        pack: packName,
        check: {
          name: "pack duplicate name",
          verdict: "fail",
          code: "pack.duplicate-name",
          detail: `pack ${packName}: skill ${name} is listed ${packNames.length}× across packs ${involved.join(", ")}`,
          location: { uri: AIH_PACKS_FILE },
          fingerprint: `pack-duplicate-name:${packName}:${name}`,
        },
      });
    }
  }
  return findings;
}

function requiredChecksFinding(pack: Pack): PackFinding | undefined {
  if ((pack.requiredChecks ?? []).length === 0) return undefined;
  return {
    pack: pack.name,
    check: {
      name: "pack required checks unsupported",
      verdict: "fail",
      code: "pack.required-checks-unsupported",
      detail:
        `pack ${pack.name}: requiredChecks are declared (${pack.requiredChecks?.join(", ")}) ` +
        "but pack-level check enforcement is not implemented yet; remove the field or enforce it before install",
      location: { uri: AIH_PACKS_FILE },
      fingerprint: `pack-required-checks-unsupported:${pack.name}`,
    },
  };
}

function packBlocked(pack: Pack, skills: readonly PackSkillStatus[]): boolean {
  return skills.some((s) => s.approval !== "approved") || (pack.requiredChecks ?? []).length > 0;
}

/**
 * The pure join: manifest × committed approvals × on-disk inventory. Per pack,
 * per ref, two orthogonal axes (approval, install) plus coded findings for
 * `validate`. No spawns, no git, no writes — reused by both commands.
 */
export function packStatus(ctx: PlanContext, packName?: string): PackStatusReport {
  const manifestPresent = existsSync(join(ctx.root, AIH_PACKS_FILE));
  const manifest = readPacksFile(ctx.root);
  const lockByName = new Map(readSkillsLock(ctx.root).skills.map((entry) => [entry.name, entry]));
  const rowsByName = new Map<string, SkillInventoryRow[]>();
  for (const row of skillInventory(ctx).skills) {
    const list = rowsByName.get(row.name) ?? [];
    list.push(row);
    rowsByName.set(row.name, list);
  }

  const selected =
    packName === undefined ? manifest.packs : manifest.packs.filter((p) => p.name === packName);

  const findings: PackFinding[] = [];
  // A present file that yields ZERO valid packs after the fail-soft read is a
  // manifest-wide finding — someone committed a curation nothing can read.
  if (manifestPresent && manifest.packs.length === 0) {
    findings.push({
      check: {
        name: "pack manifest",
        verdict: "fail",
        code: "pack.unknown-manifest",
        detail: `${AIH_PACKS_FILE} is present but contains no valid packs (each pack needs a name and at least one {name, source, commit} skill ref)`,
        location: { uri: AIH_PACKS_FILE },
        fingerprint: "pack-unknown-manifest",
      },
    });
  }

  const packs: PackStatus[] = selected.map((pack) => {
    const requiredFinding = requiredChecksFinding(pack);
    if (requiredFinding !== undefined) findings.push(requiredFinding);
    const skills: PackSkillStatus[] = pack.skills.map((ref) => {
      const entry = lockByName.get(ref.name);
      const approval = refApproval(ref, entry);
      const finding = approvalFinding(pack.name, ref, approval, entry);
      if (finding !== undefined) findings.push(finding);
      return {
        name: ref.name,
        source: ref.source,
        commit: ref.commit,
        approval,
        install: refInstall(rowsByName.get(ref.name) ?? []),
      };
    });
    return {
      name: pack.name,
      ...(pack.description !== undefined ? { description: pack.description } : {}),
      ...(pack.requiredChecks !== undefined ? { requiredChecks: pack.requiredChecks } : {}),
      rollup: packBlocked(pack, skills) ? "blocked" : "ready",
      counts: {
        skills: skills.length,
        approved: skills.filter((s) => s.approval === "approved").length,
        installed: skills.filter((s) => s.install === "installed").length,
      },
      skills,
    };
  });

  // Duplicates are judged over the FULL manifest, then narrowed to the selected
  // view — so `--pack a` still surfaces a's cross-pack duplicate, without b's.
  const selectedNames = new Set(selected.map((p) => p.name));
  findings.push(
    ...duplicateFindings(manifest.packs).filter(
      (f) => f.pack !== undefined && selectedNames.has(f.pack),
    ),
  );

  return { manifestPresent, packs, findings };
}

/** One digest row per ref: `  - <skill>  [approval] [install]  (<source>@<commit12>)`. */
function rowLine(s: PackSkillStatus): string {
  return `  - ${s.name}  [${s.approval}] [${s.install}]  (${s.source}@${s.commit.slice(0, 12)})`;
}

/** One pack's digest section: rollup header + per-skill rows. */
function packSection(p: PackStatus): string[] {
  return [
    `${p.name} — ${p.rollup} · ${p.counts.skills} skills · ${p.counts.approved} approved · ${p.counts.installed} installed`,
    ...p.skills.map(rowLine),
  ];
}

/** The status digest text — per-pack sections, or a friendly empty/no-match note. */
function statusText(report: PackStatusReport, filter?: string): string {
  if (!report.manifestPresent) {
    return lines(
      `no packs defined — create ${AIH_PACKS_FILE} at the repo root to curate approved skills into named packs (authoring commands arrive in a later slice)`,
    );
  }
  if (report.packs.length === 0) {
    return lines(
      filter !== undefined
        ? `no pack named "${filter}" in ${AIH_PACKS_FILE}`
        : `${AIH_PACKS_FILE} is present but contains no valid packs — run \`aih pack validate\` for the finding`,
    );
  }
  const body: string[] = [];
  report.packs.forEach((pack, i) => {
    if (i > 0) body.push("");
    body.push(...packSection(pack));
  });
  return lines(...body);
}

/** The optional `--pack <name>` narrowing filter, shared by both commands. */
function packOption(ctx: PlanContext): string | undefined {
  const raw = ctx.options.pack;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

const PACK_FILTER_OPTION: CommandOption = {
  flags: "--pack <name>",
  description: "limit to the named pack",
};

function packStatusPlan(ctx: PlanContext): Plan {
  const filter = packOption(ctx);
  const report = packStatus(ctx, filter);
  return plan("pack status", digest("pack status", statusText(report, filter), report));
}

export const packStatusCommand: CommandSpec = {
  name: "status",
  summary:
    "Show each pack's approval + install status against the lockfile pin authority (read-only)",
  readOnly: true,
  options: [PACK_FILTER_OPTION],
  plan: packStatusPlan,
};

function packValidatePlan(ctx: PlanContext): Plan {
  const report = packStatus(ctx, packOption(ctx));
  // Absent manifest = nothing to validate: a SKIP (never fails the run), so a
  // repo that has not adopted packs stays green in CI.
  if (!report.manifestPresent) {
    return plan(
      "pack validate",
      probe("pack manifest", () => ({
        name: "pack manifest",
        verdict: "skip",
        detail: `no ${AIH_PACKS_FILE} — no packs to validate`,
      })),
    );
  }
  const flagged = new Set(
    report.findings.map((f) => f.pack).filter((p): p is string => p !== undefined),
  );
  return plan(
    "pack validate",
    // One coded probe per finding (the CI gate shape, like `trust verify`)…
    ...report.findings.map((f) => probe(f.check.detail ?? f.check.name, () => f.check)),
    // …plus one pass per CLEAN pack (ready rollup, no finding names it).
    ...report.packs
      .filter((p) => p.rollup === "ready" && !flagged.has(p.name))
      .map((p) =>
        probe(`pack ${p.name} valid`, () => ({
          name: `pack ${p.name} valid`,
          verdict: "pass" as const,
          detail: `${p.counts.skills} skills · ${p.counts.approved} approved · ${p.counts.installed} installed`,
        })),
      ),
  );
}

export const packValidateCommand: CommandSpec = {
  name: "validate",
  summary:
    "Validate the committed pack manifest against approvals and installs (read-only CI gate)",
  readOnly: true,
  alwaysVerify: true,
  options: [PACK_FILTER_OPTION],
  plan: packValidatePlan,
};
