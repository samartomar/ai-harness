import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  type DigestAction,
  digest,
  type Plan,
  type PlanContext,
  plan,
  remove,
  writeJson,
} from "../internals/plan.js";
import { normalizeRel } from "../internals/worktree-gate.js";
import { skillCardRelPath } from "./card.js";
import { type SkillInventoryRow, skillInventory } from "./inventory.js";
import {
  AIH_SKILLS_LOCK_FILE,
  readSkillsLock,
  removeSkillLockEntry,
  type SkillsLock,
} from "./lockfile.js";

/**
 * `aih skill remove <name>` — slice 4 of the skill lifecycle: the DESTRUCTIVE
 * inverse of `workspace add` + `skill approve`. It moves an installed skill's
 * promoted directory to the reversible `.aih/legacy/` archive (or hard-deletes it
 * with `--delete`) AND drops its approval from the committed
 * `aih-skills.lock.json` + its committed card. It REUSES the remove engine exactly
 * as `aih prune` does (one `remove` action per skill DIRECTORY — `renameSync` moves
 * the whole subtree atomically), so it inherits the containment guard, the symlink
 * refusal, the never-overwrite fallback, and — for free — the dirty-worktree
 * preflight (a dirty/untracked skill dir refuses without `--force`).
 *
 * Resolution is the READ-ONLY {@link skillInventory} join (pure fs, no spawn), so
 * plan() stays pure (#35): the move + lockfile/card writes happen in execute under
 * `--apply`. The engine + guards are exposed as {@link skillRemovalActions} (one
 * member's actions + summary, digest-free) so `aih pack uninstall` composes N
 * members' removals — identical semantics — under one plan and one final digest.
 * Fail-closed AIH_TRUST refusals: no `--name`; a name matching no on-disk
 * skill AND no approval; a name matching MORE THAN ONE physical install (two sources
 * or CLI dirs can ship the same logical name — removing an arbitrary copy while
 * dropping the shared name-keyed approval would leave the survivor
 * active-but-unapproved); a skill dir that CONTAINS another discovered skill (a
 * nested child would be moved as collateral while its own approval survives,
 * dangling); and a `machine`-root skill (`~/.claude/skills` is not this repo's to
 * touch). A name with NO on-disk install but a surviving lockfile entry is an
 * ORPHANED approval (the dir was deleted by hand) — that is still this command's job,
 * so it drops the entry + card without a file move. Loader references (settings/MCP
 * JSON, root bootloaders) are NEVER auto-edited — like prune's advisory dispositions,
 * they carry no on-disk marker separating aih's entries from the user's, so they are
 * only surfaced for manual review.
 */

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Forward-slashed absolute path, for descendant tests independent of OS separators. */
function posixAbs(abs: string): string {
  return abs.replace(/\\/g, "/");
}

/**
 * The OTHER discovered skills whose directories live INSIDE `row`'s directory — the
 * collateral set a whole-subtree move would take along. Shared by `skill remove` and
 * `skill quarantine`, whose engines both move the directory atomically.
 */
export function nestedChildSkills(
  skills: readonly SkillInventoryRow[],
  row: SkillInventoryRow,
): SkillInventoryRow[] {
  const parentPrefix = `${posixAbs(row.abs)}/`;
  return skills.filter((other) => other !== row && posixAbs(other.abs).startsWith(parentPrefix));
}

/**
 * The single on-disk skill row for `<name>`, `undefined` for an ORPHANED approval
 * (no physical install, but the lockfile still carries the name — the dir was
 * deleted by hand and the governance record survived), or a fail-closed AIH_TRUST
 * refusal. Guards, in order: a name whose only install is QUARANTINED (restore it
 * first — the `.aih/quarantine/` copy is the one restorable backup, not a removal
 * target); nothing on disk AND nothing in the lock; a name
 * matching MORE THAN ONE physical install (each listed — the inventory keeps one
 * row per physical directory precisely so duplicates cannot hide behind a
 * name-keyed dedupe); a nested child skill inside the target dir; a `machine`-root
 * skill (not this repo's to remove).
 */
function resolveTarget(ctx: PlanContext, name: string): SkillInventoryRow | undefined {
  const inventory = skillInventory(ctx);
  const matches = inventory.skills.filter((row) => row.name === name);
  // A QUARANTINED row is not removable in place — its directory lives under
  // `.aih/quarantine/`, and removing it there would silently vaporize the one
  // restorable copy. Additive guard: only active (non-quarantined) rows resolve.
  const active = matches.filter((row) => row.root !== "quarantined");
  if (active.length === 0) {
    const quarantined = matches.find((row) => row.root === "quarantined");
    if (quarantined !== undefined) {
      throw refuse(
        `skill ${name} is quarantined at ${normalizeRel(relative(ctx.root, quarantined.abs))} — ` +
          "restore it first (move the directory back) or delete the quarantined copy by hand",
      );
    }
    if (readSkillsLock(ctx.root).skills.some((entry) => entry.name === name)) {
      return undefined; // orphaned approval — no files, but the lock entry is ours to drop
    }
    throw refuse(`nothing to remove — no installed skill named ${name}`);
  }
  if (active.length > 1) {
    const where = active
      .map((row) => `  - ${normalizeRel(relative(ctx.root, row.abs))} (${row.root})`)
      .join("\n");
    throw refuse(
      `skill ${name} matches ${active.length} physical installs — ambiguous, refusing to ` +
        `remove an arbitrary copy (the name-keyed approval is shared):\n${where}\n` +
        "remove the copy you mean by hand, or uninstall the duplicate first",
    );
  }
  // A same-named QUARANTINED sibling shares the name-keyed approval too: removing the
  // live copy would drop the lock entry + card the parked copy still relies on for its
  // restore path — the exact hazard the ambiguity guard exists for. Fail closed.
  const parkedSibling = matches.find((row) => row.root === "quarantined");
  if (parkedSibling !== undefined) {
    throw refuse(
      `skill ${name} also has a quarantined copy at ${normalizeRel(
        relative(ctx.root, parkedSibling.abs),
      )} — removing the live install would drop the shared approval that parked copy ` +
        "still relies on; restore or delete the quarantined copy first",
    );
  }
  // A machine-root skill lives under `~/.claude/skills`, outside this repo — aih
  // will not reach into the user's global install.
  const row = active[0];
  if (row === undefined || row.root === "machine") {
    throw refuse(
      `skill ${name} is installed only in the machine root (~/.claude/skills) — ` +
        "that global install is not this repo's to remove; delete it by hand if unwanted",
    );
  }
  // NESTED-CHILD guard: the engine moves the whole directory subtree, so any OTHER
  // discovered skill living INSIDE this one would be removed as collateral while its
  // own approval/card survive, dangling. Fail closed until the nesting is resolved.
  const nested = nestedChildSkills(inventory.skills, row);
  if (nested.length > 0) {
    const children = nested
      .map((child) => `  - ${child.name} (${normalizeRel(relative(ctx.root, child.abs))})`)
      .join("\n");
    throw refuse(
      `skill ${name}'s directory contains ${nested.length} other installed skill(s) — ` +
        `removing it would take them as collateral:\n${children}\n` +
        "remove the nested skill(s) first, then retry",
    );
  }
  return row;
}

/** Loader files whose text may reference a skill by name — surfaced, never auto-edited. */
const LOADER_REF_FILES = [
  ".claude/settings.json",
  ".mcp.json",
  ".cursor/mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
] as const;

/**
 * Manual-review advisory lines for loader files that EXIST and mention the skill
 * `name` — mirrors prune's `advisoryLines` disposition (aih can't tell its own entry
 * from the user's, so it refuses to edit and only reports). Pure fs (read-only).
 * Shared with `skill quarantine` (a disabled skill's loader refs deserve the same
 * manual-review surfacing).
 */
export function loaderAdvisories(ctx: PlanContext, name: string): string[] {
  const out: string[] = [];
  for (const rel of LOADER_REF_FILES) {
    const text = readIfExists(join(ctx.root, rel));
    if (text?.includes(name)) {
      out.push(`  [manual] ${rel} mentions "${name}" — remove the reference by hand if unused`);
    }
  }
  return out;
}

/** The shared advisory tail for the remove/orphan/quarantine digest variants. */
export function advisoryTail(advisories: string[]): string[] {
  if (advisories.length > 0) {
    return [
      "",
      "Manual review — aih can't safely edit these (its entries carry no on-disk marker,",
      "and names may collide with yours), so it will NOT touch them:",
      ...advisories,
    ];
  }
  return ["", "No loader files reference this skill by name."];
}

/**
 * The summary one member's removal produces — every digest input, minus the digest
 * itself, so `skill remove` renders its per-command digest and `pack uninstall`
 * renders one per-member row from the same facts.
 */
export type SkillRemovalSummary =
  | {
      kind: "installed";
      name: string;
      status: SkillInventoryRow["status"];
      root: string;
      /** Repo-relative POSIX dir the remove action targets. */
      from: string;
      hardDelete: boolean;
      droppedApproval: boolean;
      cardRemoved: boolean;
      advisories: string[];
    }
  | {
      kind: "orphaned-approval";
      name: string;
      cardRemoved: boolean;
      advisories: string[];
    };

export interface SkillRemoval {
  /** The engine actions (dir move, lockfile rewrite, card removal) — digest-free. */
  actions: Action[];
  summary: SkillRemovalSummary;
  /** The lock AFTER this removal — thread it into the next member's removal so a
   * composed plan's sequential lockfile writes accumulate instead of resurrecting
   * an earlier member's dropped entry. */
  lock: SkillsLock;
}

/**
 * ONE skill's guarded removal: {@link resolveTarget}'s fail-closed guards, then the
 * engine actions `skillRemovePlan` has always emitted — the atomic dir move (or an
 * orphaned approval's no-move variant), the lockfile drop, the committed-card
 * removal — plus the summary the caller's digest is built from. `lock` is the
 * working lockfile state (defaults to the on-disk read); composed callers thread
 * each member's returned `lock` into the next call.
 */
export function skillRemovalActions(
  ctx: PlanContext,
  name: string,
  hardDelete: boolean,
  lock: SkillsLock = readSkillsLock(ctx.root),
): SkillRemoval {
  const row = resolveTarget(ctx, name);
  // Card removal keys on the CANONICAL card path's existence — never the lockfile
  // entry's `card` field (a hostile lockfile could point that at any in-repo file),
  // and never on schema validity (a malformed card would be orphaned as stale
  // review material otherwise).
  const cardRel = skillCardRelPath(ctx.contextDir, name);
  const cardRemoved = existsSync(join(ctx.root, cardRel));
  const advisories = loaderAdvisories(ctx, name);

  // ORPHANED approval — the skill's directory is already gone (deleted by hand),
  // but the committed lockfile entry (and possibly the card) survived. There is no
  // file move; the remaining job is dropping the stale governance state.
  if (row === undefined) {
    const next = removeSkillLockEntry(lock, name);
    const actions: Action[] = [
      writeJson(
        AIH_SKILLS_LOCK_FILE,
        next,
        `drop the orphaned approval for ${name} (no on-disk install)`,
      ),
    ];
    if (cardRemoved) {
      actions.push(remove(cardRel, `remove committed skill card for ${name}`));
    }
    return {
      actions,
      summary: { kind: "orphaned-approval", name, cardRemoved, advisories },
      lock: next,
    };
  }

  // The remove engine wants a repo-relative POSIX path; `row.abs` is the skill DIR,
  // so one remove action moves the whole subtree atomically (renameSync on a dir).
  const relDir = normalizeRel(relative(ctx.root, row.abs));
  const actions: Action[] = [
    remove(relDir, `remove skill ${name} (${row.status})`, { hardDelete }),
  ];

  // Drop the committed approval — only when there IS one (an unapproved on-disk skill
  // has no lockfile entry, so skip the write rather than rewrite an unchanged file).
  const droppedApproval = lock.skills.some((entry) => entry.name === name);
  const next = droppedApproval ? removeSkillLockEntry(lock, name) : lock;
  if (droppedApproval) {
    actions.push(
      writeJson(AIH_SKILLS_LOCK_FILE, next, `drop ${name} from the skill approval lockfile`),
    );
  }

  if (cardRemoved) {
    actions.push(remove(cardRel, `remove committed skill card for ${name}`));
  }

  return {
    actions,
    summary: {
      kind: "installed",
      name,
      status: row.status,
      root: row.root,
      from: relDir,
      hardDelete,
      droppedApproval,
      cardRemoved,
      advisories,
    },
    lock: next,
  };
}

type InstalledRemoval = Extract<SkillRemovalSummary, { kind: "installed" }>;

function removeDigestText(s: InstalledRemoval): string {
  const rollback = s.hardDelete
    ? `${normalizeRel(s.from)}.aih.bak`
    : `.aih/legacy/${normalizeRel(s.from)}`;
  const disposal = s.hardDelete
    ? `hard-delete (single-slot ${rollback} backup)`
    : `move to ${rollback} (reversible — move it back)`;
  return [
    `Skill: ${s.name} (${s.status})`,
    `Root: ${s.root}`,
    `Remove: ${s.from} → ${disposal}`,
    `Approval: ${s.droppedApproval ? `dropped from ${AIH_SKILLS_LOCK_FILE}` : "was not approved (no lockfile entry)"}`,
    `Card: ${s.cardRemoved ? "committed card removed" : "no committed card"}`,
    ...advisoryTail(s.advisories),
  ].join("\n");
}

function orphanDigestText(name: string, cardRemoved: boolean, advisories: string[]): string {
  return [
    `Skill: ${name} (orphaned approval — no on-disk install)`,
    "Remove: nothing on disk (the skill directory is already gone)",
    `Approval: dropped from ${AIH_SKILLS_LOCK_FILE}`,
    `Card: ${cardRemoved ? "committed card removed" : "no committed card"}`,
    ...advisoryTail(advisories),
  ].join("\n");
}

/** The per-command digest for `skill remove`, built from the extracted summary. */
function skillRemoveDigest(s: SkillRemovalSummary): DigestAction {
  if (s.kind === "orphaned-approval") {
    return digest("skill remove", orphanDigestText(s.name, s.cardRemoved, s.advisories), {
      name: s.name,
      status: "orphaned-approval",
      hardDelete: false,
      droppedApproval: true,
      cardRemoved: s.cardRemoved,
      advisories: s.advisories,
    });
  }
  return digest("skill remove", removeDigestText(s), {
    name: s.name,
    status: s.status,
    from: s.from,
    hardDelete: s.hardDelete,
    droppedApproval: s.droppedApproval,
    cardRemoved: s.cardRemoved,
    advisories: s.advisories,
  });
}

function skillRemovePlan(ctx: PlanContext): Plan {
  const name = optionString(ctx, "name");
  if (name === undefined) {
    throw refuse("skill remove requires --name <skill> — the installed skill to remove");
  }
  const { actions, summary } = skillRemovalActions(ctx, name, ctx.options.delete === true);
  return plan("skill remove", ...actions, skillRemoveDigest(summary));
}

export const skillRemoveCommand: CommandSpec = {
  name: "remove",
  summary: "Remove an installed skill — archive its files (reversible) and drop its approval",
  options: [
    { flags: "--name <skill>", description: "the installed skill to remove (required)" },
    {
      flags: "--delete",
      description:
        "hard-delete to a gitignored *.aih.bak sibling instead of the reversible .aih/legacy/ archive",
    },
  ],
  plan: skillRemovePlan,
};
