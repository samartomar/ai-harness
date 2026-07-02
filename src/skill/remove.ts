import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
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
import { AIH_SKILLS_LOCK_FILE, readSkillsLock, removeSkillLockEntry } from "./lockfile.js";

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
 * `--apply`. Fail-closed AIH_TRUST refusals: no `--name`; a name matching no on-disk
 * skill; a name matching MORE THAN ONE physical install (two sources or CLI dirs can
 * ship the same logical name — removing an arbitrary copy while dropping the shared
 * name-keyed approval would leave the survivor active-but-unapproved); a skill dir
 * that CONTAINS another discovered skill (a nested child would be moved as collateral
 * while its own approval survives, dangling); and a `machine`-root skill
 * (`~/.claude/skills` is not this repo's to touch). Loader references (settings/MCP
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
 * The single on-disk skill row for `<name>` plus the full inventory it came from,
 * or a fail-closed AIH_TRUST refusal. Guards, in order: no matching on-disk skill;
 * a name matching MORE THAN ONE physical install (each listed — the inventory keeps
 * one row per physical directory precisely so duplicates cannot hide behind a
 * name-keyed dedupe); a `machine`-root skill (not this repo's to remove).
 */
function resolveTarget(
  ctx: PlanContext,
  name: string,
): { row: SkillInventoryRow; all: SkillInventoryRow[] } {
  const inventory = skillInventory(ctx);
  const matches = inventory.skills.filter((row) => row.name === name);
  if (matches.length === 0) {
    throw refuse(`nothing to remove — no installed skill named ${name}`);
  }
  if (matches.length > 1) {
    const where = matches
      .map((row) => `  - ${normalizeRel(relative(ctx.root, row.abs))} (${row.root})`)
      .join("\n");
    throw refuse(
      `skill ${name} matches ${matches.length} physical installs — ambiguous, refusing to ` +
        `remove an arbitrary copy (the name-keyed approval is shared):\n${where}\n` +
        "remove the copy you mean by hand, or uninstall the duplicate first",
    );
  }
  // A machine-root skill lives under `~/.claude/skills`, outside this repo — aih
  // will not reach into the user's global install.
  const row = matches[0];
  if (row === undefined || row.root === "machine") {
    throw refuse(
      `skill ${name} is installed only in the machine root (~/.claude/skills) — ` +
        "that global install is not this repo's to remove; delete it by hand if unwanted",
    );
  }
  // NESTED-CHILD guard: the engine moves the whole directory subtree, so any OTHER
  // discovered skill living INSIDE this one would be removed as collateral while its
  // own approval/card survive, dangling. Fail closed until the nesting is resolved.
  const parentPrefix = `${posixAbs(row.abs)}/`;
  const nested = inventory.skills.filter(
    (other) => other !== row && posixAbs(other.abs).startsWith(parentPrefix),
  );
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
  return { row, all: inventory.skills };
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
 */
function loaderAdvisories(ctx: PlanContext, name: string): string[] {
  const out: string[] = [];
  for (const rel of LOADER_REF_FILES) {
    const text = readIfExists(join(ctx.root, rel));
    if (text?.includes(name)) {
      out.push(`  [manual] ${rel} mentions "${name}" — remove the reference by hand if unused`);
    }
  }
  return out;
}

function removeDigestText(
  name: string,
  row: SkillInventoryRow,
  relDir: string,
  hardDelete: boolean,
  droppedApproval: boolean,
  cardRemoved: boolean,
  advisories: string[],
): string {
  const rollback = hardDelete
    ? `${normalizeRel(relDir)}.aih.bak`
    : `.aih/legacy/${normalizeRel(relDir)}`;
  const disposal = hardDelete
    ? `hard-delete (single-slot ${rollback} backup)`
    : `move to ${rollback} (reversible — move it back)`;
  const lines = [
    `Skill: ${name} (${row.status})`,
    `Root: ${row.root}`,
    `Remove: ${relDir} → ${disposal}`,
    `Approval: ${droppedApproval ? `dropped from ${AIH_SKILLS_LOCK_FILE}` : "was not approved (no lockfile entry)"}`,
    `Card: ${cardRemoved ? "committed card removed" : "no committed card"}`,
  ];
  if (advisories.length > 0) {
    lines.push(
      "",
      "Manual review — aih can't safely edit these (its entries carry no on-disk marker,",
      "and names may collide with yours), so it will NOT touch them:",
      ...advisories,
    );
  } else {
    lines.push("", "No loader files reference this skill by name.");
  }
  return lines.join("\n");
}

function skillRemovePlan(ctx: PlanContext): Plan {
  const name = optionString(ctx, "name");
  if (name === undefined) {
    throw refuse("skill remove requires --name <skill> — the installed skill to remove");
  }
  const { row } = resolveTarget(ctx, name);
  const hardDelete = ctx.options.delete === true;
  // The remove engine wants a repo-relative POSIX path; `row.abs` is the skill DIR,
  // so one remove action moves the whole subtree atomically (renameSync on a dir).
  const relDir = normalizeRel(relative(ctx.root, row.abs));

  const actions: Action[] = [
    remove(relDir, `remove skill ${name} (${row.status})`, { hardDelete }),
  ];

  // Drop the committed approval — only when there IS one (an unapproved on-disk skill
  // has no lockfile entry, so skip the write rather than rewrite an unchanged file).
  const lock = readSkillsLock(ctx.root);
  const droppedApproval = lock.skills.some((entry) => entry.name === name);
  if (droppedApproval) {
    actions.push(
      writeJson(
        AIH_SKILLS_LOCK_FILE,
        removeSkillLockEntry(lock, name),
        `drop ${name} from the skill approval lockfile`,
      ),
    );
  }

  // Drop the committed card too, reversibly, through the same engine. Keyed on the
  // CANONICAL card path's existence — never the lockfile entry's `card` field (a
  // hostile lockfile could point that at any in-repo file), and never on schema
  // validity (a malformed card would be orphaned as stale review material otherwise).
  const cardRel = skillCardRelPath(ctx.contextDir, name);
  const cardRemoved = existsSync(join(ctx.root, cardRel));
  if (cardRemoved) {
    actions.push(remove(cardRel, `remove committed skill card for ${name}`));
  }

  const advisories = loaderAdvisories(ctx, name);
  actions.push(
    digest(
      "skill remove",
      removeDigestText(name, row, relDir, hardDelete, droppedApproval, cardRemoved, advisories),
      {
        name,
        status: row.status,
        from: relDir,
        hardDelete,
        droppedApproval,
        cardRemoved,
        advisories,
      },
    ),
  );
  return plan("skill remove", ...actions);
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
