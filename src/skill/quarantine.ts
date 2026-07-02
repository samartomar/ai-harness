import { relative } from "node:path";
import { AihError } from "../errors.js";
import {
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  remove,
} from "../internals/plan.js";
import { normalizeRel } from "../internals/worktree-gate.js";
import { type SkillInventoryRow, skillInventory } from "./inventory.js";
import { readSkillsLock } from "./lockfile.js";
import { advisoryTail, loaderAdvisories, nestedChildSkills } from "./remove.js";

/**
 * `aih skill quarantine <--name>` — slice 4b of the skill lifecycle: DISABLE an
 * installed skill without removing it. One `remove` action moves the skill's
 * directory to the deterministic `.aih/quarantine/<relDir>` (never timestamped, so a
 * dry-run stays byte-stable — design C6) through the SAME engine `skill remove` and
 * `prune` use, inheriting the containment guard, the symlink refusal, the
 * never-overwrite fallback, and the dirty-worktree preflight. Unlike `remove`, the
 * committed `aih-skills.lock.json` approval and skill card are INTENTIONALLY KEPT —
 * quarantine disables without retracting, so restoring is a plain move-back (the
 * digest prints the exact path) with the governance state still intact. The inventory
 * surfaces the parked copy as status `"quarantined"`.
 *
 * Resolution mirrors `remove`'s fail-closed AIH_TRUST refusals: no `--name`; a name
 * with no ACTIVE on-disk install (already-quarantined names point at the restore
 * path; orphaned approvals point at `skill remove`); an ambiguous name with multiple
 * physical installs; a `machine`-root skill; and a dir containing another discovered
 * skill (collateral). There is no `--delete` variant — quarantine is by definition
 * reversible.
 */

/** The quarantine archive root — the engine's closed-union alternative to `.aih/legacy`. */
const QUARANTINE_ROOT = ".aih/quarantine";

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * The single ACTIVE on-disk skill row for `<name>`, or a fail-closed AIH_TRUST
 * refusal. Guards, in order: a name whose only install is ALREADY quarantined (the
 * restore is a move-back, not a second quarantine); a name in the lockfile but not on
 * disk (an orphaned approval is `skill remove`'s job — there is nothing to disable);
 * nothing anywhere; MORE THAN ONE physical install (quarantining an arbitrary copy
 * would leave the survivor active while the digest claims the name is disabled); a
 * `machine`-root skill (not this repo's to touch); a nested child skill inside the
 * target dir (it would be parked as collateral while its own approval stays live).
 */
function resolveTarget(ctx: PlanContext, name: string): SkillInventoryRow {
  const inventory = skillInventory(ctx);
  const matches = inventory.skills.filter((row) => row.name === name);
  const active = matches.filter((row) => row.root !== "quarantined");
  if (active.length === 0) {
    const quarantined = matches.find((row) => row.root === "quarantined");
    if (quarantined !== undefined) {
      throw refuse(
        `skill ${name} is already quarantined at ` +
          `${normalizeRel(relative(ctx.root, quarantined.abs))} — move it back to restore`,
      );
    }
    if (readSkillsLock(ctx.root).skills.some((entry) => entry.name === name)) {
      throw refuse(
        `skill ${name} is already gone from disk — use \`aih skill remove --name ${name}\` ` +
          "to drop the orphaned approval",
      );
    }
    throw refuse(`nothing to quarantine — no installed skill named ${name}`);
  }
  if (active.length > 1) {
    const where = active
      .map((row) => `  - ${normalizeRel(relative(ctx.root, row.abs))} (${row.root})`)
      .join("\n");
    throw refuse(
      `skill ${name} matches ${active.length} physical installs — ambiguous, refusing to ` +
        `quarantine an arbitrary copy (the others would stay active):\n${where}\n` +
        "quarantine the copy you mean by hand, or uninstall the duplicate first",
    );
  }
  const row = active[0];
  if (row === undefined || row.root === "machine") {
    throw refuse(
      `skill ${name} is installed only in the machine root (~/.claude/skills) — ` +
        "that global install is not this repo's to quarantine; disable it by hand if unwanted",
    );
  }
  // NESTED-CHILD guard, same as remove's: the engine moves the whole subtree, so a
  // discovered skill INSIDE this one would be disabled as collateral.
  const nested = nestedChildSkills(inventory.skills, row);
  if (nested.length > 0) {
    const children = nested
      .map((child) => `  - ${child.name} (${normalizeRel(relative(ctx.root, child.abs))})`)
      .join("\n");
    throw refuse(
      `skill ${name}'s directory contains ${nested.length} other installed skill(s) — ` +
        `quarantining it would take them as collateral:\n${children}\n` +
        "quarantine the nested skill(s) first, then retry",
    );
  }
  return row;
}

function quarantineDigestText(
  name: string,
  row: SkillInventoryRow,
  relDir: string,
  to: string,
  advisories: string[],
): string {
  return [
    `Skill: ${name} (${row.status})`,
    `Root: ${row.root}`,
    `Quarantine: ${relDir} → ${to} (reversible — the move IS the disable)`,
    "Approval: kept (quarantine disables without retracting)",
    `Restore: move ${to} back to ${relDir}`,
    ...advisoryTail(advisories),
  ].join("\n");
}

function skillQuarantinePlan(ctx: PlanContext): Plan {
  const name = optionString(ctx, "name");
  if (name === undefined) {
    throw refuse("skill quarantine requires --name <skill> — the installed skill to disable");
  }
  const row = resolveTarget(ctx, name);
  // The engine wants a repo-relative POSIX path; `row.abs` is the skill DIR, so one
  // remove action moves the whole subtree atomically — into the quarantine root.
  const relDir = normalizeRel(relative(ctx.root, row.abs));
  const to = `${QUARANTINE_ROOT}/${relDir}`;
  const advisories = loaderAdvisories(ctx, name);
  return plan(
    "skill quarantine",
    remove(relDir, `quarantine skill ${name} (${row.status})`, {
      archiveRoot: ".aih/quarantine",
    }),
    digest("skill quarantine", quarantineDigestText(name, row, relDir, to, advisories), {
      name,
      status: row.status,
      from: relDir,
      to,
      approvalKept: true,
      advisories,
    }),
  );
}

export const skillQuarantineCommand: CommandSpec = {
  name: "quarantine",
  summary: "Quarantine an installed skill — disable it reversibly, keeping its approval",
  options: [
    { flags: "--name <skill>", description: "the installed skill to quarantine (required)" },
  ],
  plan: skillQuarantinePlan,
};
