import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { homeDir } from "../internals/cli-detect.js";
import { type CommandSpec, digest, type Plan, type PlanContext, plan } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { readTrustLock, type TrustLockSource } from "../trust/lock.js";
import { collectSkillDirs, promotedSkillRel } from "../workspace/acquire.js";
import { readSkillCard } from "./card.js";
import { readSkillsLock, type SkillLockEntry } from "./lockfile.js";

/**
 * `aih skill inventory` — slice 3 of the skill lifecycle: the READ-ONLY join that
 * answers "which external skills are on disk, and which are approved?". It reuses
 * the same discovery contract `skillShape` uses (`collectSkillDirs` +
 * `promotedSkillRel`) and the committed `aih-skills.lock.json` approvals, so it
 * never re-derives state a write command already recorded. Pure fs — no spawns, no
 * git — so it is safe at plan/digest time (the plan-purity floor, #35) and is the
 * one join both this command and the report's "Skill governance" digest consume.
 */

/** One discovered skill, joined to its approval + drift state. */
export interface SkillInventoryRow {
  /** Logical skill name (matches the lockfile entry name). */
  name: string;
  /** The root label the skill was discovered under. */
  root: string;
  /** Absolute path of the skill directory on disk. */
  abs: string;
  /** `quarantined` = disabled under `.aih/quarantine/` (approval kept, not graded). */
  status: "approved" | "unapproved" | "stale-pin" | "quarantined";
  /** Approval verdict from the lock entry, when the lock carries one for this name. */
  verdict?: SkillLockEntry["verdict"];
  /** Source string from the lock entry, when the lock carries one for this name. */
  source?: string;
  /** Approved commit from the lock entry, when the lock carries one for this name. */
  commit?: string;
  /** Skill pack from the lock entry, when the lock carries one for this name. */
  pack?: string;
  /** True when the approval marks this a first-party (repo-relative local) skill. */
  firstParty?: boolean;
  /** Committed card path from the lock entry, when the lock carries one for this name. */
  card?: string;
  /** Whether the card the lock entry references is present on disk. */
  cardPresent?: boolean;
  /** Why a stale-pin skill is stale (commit mismatch), when stale. */
  driftReason?: string;
}

/** One scanned skill root and whether it exists on disk. */
export interface SkillInventoryRoot {
  label: string;
  abs: string;
  present: boolean;
}

export interface SkillInventory {
  roots: SkillInventoryRoot[];
  skills: SkillInventoryRow[];
  counts: {
    installed: number;
    approved: number;
    unapproved: number;
    stalePin: number;
    quarantined: number;
  };
}

/** A discovered skill dir before its approval join. */
interface DiscoveredSkill {
  name: string;
  root: string;
  abs: string;
}

/**
 * The roots we scan for skills, in report order: the PROMOTED root (external skills
 * acquired via `workspace add`, under `<ctx>/skills`), the repo-committed per-CLI
 * skill dirs (`.claude`/`.kiro`), the MACHINE `~/.claude/skills` install, and the
 * QUARANTINE archive (`.aih/quarantine/`, where `skill quarantine` parks a disabled
 * skill under its original repo-relative layout). Only
 * those that exist on disk are scanned (a missing root is `present: false`, never an
 * error). `homeDir` reads the injected env first, so tests stay hermetic.
 */
function inventoryRoots(ctx: PlanContext): SkillInventoryRoot[] {
  const specs: Array<{ label: string; abs: string }> = [
    { label: "promoted", abs: join(ctx.root, ctx.contextDir, "skills") },
    { label: "repo", abs: join(ctx.root, ".claude", "skills") },
    { label: "repo", abs: join(ctx.root, ".kiro", "skills") },
    { label: "machine", abs: join(homeDir(ctx), ".claude", "skills") },
    { label: "quarantined", abs: join(ctx.root, ".aih", "quarantine") },
  ];
  return specs.map((spec) => ({ ...spec, present: existsSync(spec.abs) }));
}

/**
 * The logical skill name for a discovered directory. The promoted layout nests each
 * skill under its source id (`<ctx>/skills/<id>/<skillRel>`), which `promotedSkillRel`
 * would keep as `<id>/<skillRel>` — but the lockfile records only `<skillRel>` (the
 * name `skill approve` derived from the fetched tree, which has no id layer). So for
 * the promoted root we drop the leading id segment; every other root is flat and
 * `promotedSkillRel` already yields the right name.
 */
function skillNameFor(rootLabel: string, rootAbs: string, skillDir: string): string {
  const rel = promotedSkillRel(rootAbs, skillDir);
  if (rootLabel !== "promoted") return rel;
  const slash = rel.indexOf("/");
  return slash >= 0 ? rel.slice(slash + 1) : rel;
}

/**
 * The logical name for a QUARANTINED skill dir. `skill quarantine` moves a skill to
 * `.aih/quarantine/<original repo-relative dir>`, so a quarantined PROMOTED skill
 * reappears under `<quarantine>/<ctx>/skills/<id>/<skillRel>` — the same id-nested
 * layout as the live promoted root, so the same leading-id strip applies. Every other
 * quarantined layout (`.claude`/`.kiro` repo skills) is flat past its `skills`
 * segment, which `promotedSkillRel` already strips.
 */
function quarantinedSkillName(contextDir: string, rootAbs: string, skillDir: string): string {
  const rel = relative(rootAbs, skillDir).replace(/\\/g, "/");
  const logical = promotedSkillRel(rootAbs, skillDir);
  if (!rel.startsWith(`${contextDir}/skills/`)) return logical;
  const slash = logical.indexOf("/");
  return slash >= 0 ? logical.slice(slash + 1) : logical;
}

/**
 * Discover every skill under the present roots — one row per PHYSICAL directory,
 * never collapsed by name. Two installs can share a logical name (two promoted
 * sources shipping `foo`, or `.claude/skills/foo` + `.kiro/skills/foo`); hiding one
 * behind a name-keyed dedupe would make a DESTRUCTIVE consumer (`skill remove`)
 * treat an ambiguous name as unique and remove an arbitrary copy while dropping the
 * shared approval. The roots are disjoint directories and `collectSkillDirs` yields
 * unique dirs per root, so no dedupe is needed.
 */
function discoverSkills(roots: SkillInventoryRoot[], contextDir: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  for (const root of roots) {
    if (!root.present) continue;
    for (const dir of collectSkillDirs(root.abs)) {
      const name =
        root.label === "quarantined"
          ? quarantinedSkillName(contextDir, root.abs, dir)
          : skillNameFor(root.label, root.abs, dir);
      out.push({ name, root: root.label, abs: dir });
    }
  }
  return out;
}

/**
 * Whether an approved skill's owning trust-lock source has drifted from the pin the
 * approval was granted against. Pure fs (read-only): we compare the trust-lock
 * source's recorded `pinnedSha` to the lock entry's `commit`, matching the promoted
 * skill to its source via `promotedSkills`. `undefined` when there is no owning
 * source (local approvals) or the commits agree.
 */
function stalePinReason(
  name: string,
  entry: SkillLockEntry,
  sources: readonly TrustLockSource[],
): string | undefined {
  const owner = sources.find((source) => source.promotedSkills.includes(name));
  if (owner?.pinnedSha === undefined) return undefined;
  if (owner.pinnedSha === entry.commit) return undefined;
  return `approved commit ${entry.commit.slice(0, 7)} ≠ acquired ${owner.pinnedSha.slice(0, 7)}`;
}

/**
 * The pure join: discover on-disk skills, match each against the committed approvals,
 * and grade approved skills for pin drift. No spawns, no git, no writes — reused by
 * both the `inventory` command and the report's "Skill governance" digest.
 */
export function skillInventory(ctx: PlanContext): SkillInventory {
  const roots = inventoryRoots(ctx);
  const lock = readSkillsLock(ctx.root);
  const byName = new Map(lock.skills.map((entry) => [entry.name, entry]));
  const trustSources = readTrustLock(ctx.root).sources;

  const skills: SkillInventoryRow[] = discoverSkills(roots, ctx.contextDir).map((hit) => {
    // A quarantined skill is DISABLED, not graded: its approval is intentionally kept
    // (that is quarantine's contract), so classifying it approved/unapproved/stale
    // would misread a parked copy as live governance state. But the lock entry's
    // IDENTITY (verdict/source/commit/pack/card) is still real — quarantine keeps the
    // approval, and dropping this join made a parked pack member vanish from every
    // pack rollup keyed on `row.pack` (the PR #111 review gap). Join for provenance
    // only, never for grading: no cardPresent probe, no stale-pin drift check.
    if (hit.root === "quarantined") {
      const entry = byName.get(hit.name);
      return {
        name: hit.name,
        root: hit.root,
        abs: hit.abs,
        status: "quarantined",
        ...(entry === undefined
          ? {}
          : {
              verdict: entry.verdict,
              source: entry.source,
              commit: entry.commit,
              pack: entry.pack,
              card: entry.card,
            }),
      };
    }
    const entry = byName.get(hit.name);
    if (entry === undefined) {
      return { name: hit.name, root: hit.root, abs: hit.abs, status: "unapproved" };
    }
    const cardPresent = readSkillCard(ctx.root, ctx.contextDir, hit.name) !== undefined;
    const driftReason = stalePinReason(hit.name, entry, trustSources);
    return {
      name: hit.name,
      root: hit.root,
      abs: hit.abs,
      status: driftReason !== undefined ? "stale-pin" : "approved",
      verdict: entry.verdict,
      source: entry.source,
      commit: entry.commit,
      pack: entry.pack,
      firstParty: entry.firstParty,
      card: entry.card,
      cardPresent,
      ...(driftReason !== undefined ? { driftReason } : {}),
    };
  });

  const counts = {
    installed: skills.length,
    approved: skills.filter((s) => s.status === "approved").length,
    unapproved: skills.filter((s) => s.status === "unapproved").length,
    stalePin: skills.filter((s) => s.status === "stale-pin").length,
    quarantined: skills.filter((s) => s.status === "quarantined").length,
  };
  return { roots, skills, counts };
}

/** The bracket note for a row's status (mirrors trustList's inline verdict style). */
function statusNote(row: SkillInventoryRow): string {
  if (row.status === "approved") return "approved";
  if (row.status === "stale-pin") return `stale-pin: ${row.driftReason ?? "commit drift"}`;
  return "unapproved";
}

/** The trailing provenance note for an approved/stale row (source@commit · pack · root). */
function provenanceNote(row: SkillInventoryRow): string {
  if (row.source === undefined) return `(${row.root})`;
  const commit = row.commit ? `@${row.commit.slice(0, 12)}` : "";
  const pack = row.pack ? ` · ${row.pack}` : "";
  const firstParty = row.firstParty ? " · first-party" : "";
  return `(${row.source}${commit}${pack}${firstParty} · ${row.root})`;
}

/** One inventory row, grouped by root — `<name>  [status]  (provenance)`. */
function rowLine(row: SkillInventoryRow): string {
  return `  - ${row.name}  [${statusNote(row)}]  ${provenanceNote(row)}`;
}

/** The digest text — a counts header, then rows grouped by root (or an empty note). */
function inventoryText(inv: SkillInventory): string {
  const { installed, approved, unapproved, stalePin, quarantined } = inv.counts;
  if (installed === 0) {
    return lines(
      "0 installed · 0 approved · 0 unapproved · 0 stale",
      "",
      "No skills installed — nothing to inventory. Acquire one with `aih workspace add <source>`.",
    );
  }
  const header =
    `${installed} installed · ${approved} approved · ${unapproved} unapproved · ${stalePin} stale` +
    (quarantined > 0 ? ` · ${quarantined} quarantined` : "");
  const rootLabels = ["promoted", "repo", "machine"];
  const sections: string[] = [];
  for (const label of rootLabels) {
    const rows = inv.skills.filter((s) => s.root === label);
    if (rows.length === 0) continue;
    sections.push("", `${label}:`, ...rows.map(rowLine));
  }
  // Quarantined skills get their own trailing section — they are disabled, not
  // graded, and the restore path is a plain move-back (no aih command needed).
  const qRows = inv.skills.filter((s) => s.root === "quarantined");
  if (qRows.length > 0) {
    sections.push(
      "",
      "quarantined:",
      ...qRows.map((row) => `  - ${row.name}  [quarantined]  (move back to restore)`),
    );
  }
  return lines(header, ...sections);
}

function skillInventoryPlan(ctx: PlanContext): Plan {
  const inv = skillInventory(ctx);
  return plan("skill inventory", digest("skill inventory", inventoryText(inv), inv));
}

export const skillInventoryCommand: CommandSpec = {
  name: "inventory",
  summary: "Inventory installed external skills and their approval + pin-drift state (read-only)",
  readOnly: true,
  options: [],
  plan: skillInventoryPlan,
};
