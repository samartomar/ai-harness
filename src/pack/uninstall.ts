import { existsSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../errors.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { skillInventory } from "../skill/inventory.js";
import { AIH_SKILLS_LOCK_FILE, readSkillsLockStrictForWrite } from "../skill/lockfile.js";
import { advisoryTail, type SkillRemovalSummary, skillRemovalActions } from "../skill/remove.js";
import { AIH_PACKS_FILE, readPacksFile } from "./manifest.js";
import { packStatus } from "./status.js";

/**
 * `aih pack uninstall` — slice 4 of packs (pack CLOSURE): the destructive inverse
 * of `pack install`. It removes every INSTALLED member of the named pack through
 * the EXACT `skill remove` engine ({@link skillRemovalActions} — the same guards,
 * the same actions), composed into ONE plan with ONE final digest:
 *
 * - Per member: the reversible archive to `.aih/legacy/` (or `--delete` →
 *   `*.aih.bak`), the `aih-skills.lock.json` approval drop, the committed-card
 *   removal, and the loader-ref advisories — identical to `aih skill remove`.
 * - A member that is NOT installed and NOT orphaned-approved is reported
 *   "not installed (nothing to do)" and skipped; the rest proceed.
 * - A member whose per-member guard REFUSES (ambiguous duplicate, nested child,
 *   machine root, quarantined-only) fails the WHOLE plan fail-closed at plan time
 *   (AIH_TRUST, naming the member + reason) — never a partial uninstall the
 *   operator didn't see coming. Resolve that member first, or remove it
 *   individually with `aih skill remove`.
 * - The pack's MANIFEST entry is NOT touched: uninstall retracts installed
 *   artifacts + approvals; the curation stays (`aih pack remove-entry` uncurates).
 *
 * Each member's lockfile write is threaded through the WORKING lock (the previous
 * member's result), so the composed plan's sequential writes accumulate — a naive
 * per-member read of the on-disk lock would resurrect an earlier member's dropped
 * entry. Resolution is the read-only inventory join (pure fs), so plan() stays
 * pure (#35); dry-run previews, `--apply` executes through the standard gate
 * (containment, symlink refusal, dirty-worktree preflight — `--force` to bypass).
 */

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function requirePackName(ctx: PlanContext): string {
  const raw = ctx.options.pack;
  const name = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
  if (name === undefined) {
    throw refuse("pack uninstall requires --pack <name> — the pack whose members to remove");
  }
  return name;
}

/** One member's outcome row — a removal summary, or the friendly not-installed skip. */
type PackMemberRow =
  | { name: string; outcome: "removed" | "orphaned-approval"; summary: SkillRemovalSummary }
  | { name: string; outcome: "not-installed" };

/** One digest line per member, mirroring `pack install`'s `- <name>  [outcome]` rows. */
function memberLine(row: PackMemberRow): string {
  if (row.outcome === "not-installed") {
    return `  - ${row.name}  [not installed]  nothing to do`;
  }
  const s = row.summary;
  if (s.kind === "orphaned-approval") {
    return (
      `  - ${row.name}  [orphaned approval]  no on-disk install — approval dropped` +
      `${s.cardRemoved ? " · card removed" : ""}`
    );
  }
  const rollback = s.hardDelete ? `${s.from}.aih.bak` : `.aih/legacy/${s.from}`;
  return (
    `  - ${row.name}  [removed]  ${s.from} → ${rollback}` +
    `${s.hardDelete ? " (hard-delete backup)" : " (reversible)"}` +
    ` · approval ${s.droppedApproval ? "dropped" : "was not in the lock"}` +
    ` · ${s.cardRemoved ? "card removed" : "no card"}`
  );
}

/** The structured per-member payload echoed into `--json`. */
function memberData(row: PackMemberRow): Record<string, unknown> {
  if (row.outcome === "not-installed") {
    return { name: row.name, outcome: "not-installed" };
  }
  const s = row.summary;
  if (s.kind === "orphaned-approval") {
    return {
      name: row.name,
      outcome: "orphaned-approval",
      droppedApproval: true,
      cardRemoved: s.cardRemoved,
      advisories: s.advisories,
    };
  }
  return {
    name: row.name,
    outcome: "removed",
    status: s.status,
    from: s.from,
    hardDelete: s.hardDelete,
    droppedApproval: s.droppedApproval,
    cardRemoved: s.cardRemoved,
    advisories: s.advisories,
  };
}

function uninstallText(packName: string, members: PackMemberRow[], advisories: string[]): string {
  const count = (outcome: PackMemberRow["outcome"]): number =>
    members.filter((row) => row.outcome === outcome).length;
  return lines(
    `pack ${packName} — uninstall: ${members.length} member(s) · ${count("removed")} removed · ` +
      `${count("orphaned-approval")} orphaned approval(s) dropped · ${count("not-installed")} not installed`,
    ...members.map(memberLine),
    "",
    `manifest unchanged — ${AIH_PACKS_FILE} still curates pack ${packName}; uncurate with ` +
      `\`aih pack remove-entry --pack ${packName} --skill <name>\``,
    ...(advisories.length > 0 ? advisoryTail(advisories) : []),
  );
}

function packUninstallPlan(ctx: PlanContext): Plan {
  const packName = requirePackName(ctx);
  if (!existsSync(join(ctx.root, AIH_PACKS_FILE))) {
    throw refuse(`no ${AIH_PACKS_FILE} at the repo root — nothing to uninstall`);
  }
  const pack = readPacksFile(ctx.root).packs.find((p) => p.name === packName);
  if (pack === undefined) {
    throw refuse(`no pack named "${packName}" in ${AIH_PACKS_FILE}`);
  }

  const hardDelete = ctx.options.delete === true;

  // OWNERSHIP PREFLIGHT — the same approval axis install gates on. Uninstall is
  // name-keyed and DESTRUCTIVE, so the manifest ref must actually OWN the lock
  // entry it is about to retract:
  //  - pin-mismatch (the pack claims a different source/commit than the lock) →
  //    refuse: a hostile or stale manifest must not remove the REAL skill and
  //    drop an approval it never granted.
  //  - duplicate-name (this name curated in >1 pack, or twice here) → refuse: the
  //    name-keyed approval is shared; a one-pack uninstall would strand the other.
  //  - missing-approval → the pack has nothing authoritative to retract: skip the
  //    member ("nothing to do"; use skill remove for an on-disk unapproved copy).
  const statusReport = packStatus(ctx, packName);
  const statusPack = statusReport.packs.find((entry) => entry.name === packName);
  const blocking = statusReport.findings.filter(
    (finding) =>
      finding.check.code === "pack.pin-mismatch" || finding.check.code === "pack.duplicate-name",
  );
  if (blocking.length > 0) {
    const details = blocking
      .map((finding) => `  - ${finding.check.detail ?? finding.check.name}`)
      .join("\n");
    throw refuse(
      `pack ${packName} is not a clean owner of its members — refusing to uninstall:\n` +
        `${details}\n` +
        "fix the manifest (aih pack validate) or remove members individually with `aih skill remove`",
    );
  }
  const approvalByName = new Map((statusPack?.skills ?? []).map((ref) => [ref.name, ref.approval]));

  // The read-only joins, computed ONCE: the inventory decides "anything on disk?"
  // (any root — a machine-only or quarantined-only member must still reach the
  // per-member guard, not be skipped) and the lock decides "orphaned approval?".
  const inventory = skillInventory(ctx);
  let lock = readSkillsLockStrictForWrite(ctx.root);

  const actions: Action[] = [];
  const members: PackMemberRow[] = [];
  for (const name of [...new Set(pack.skills.map((ref) => ref.name))]) {
    if (approvalByName.get(name) === "missing-approval") {
      members.push({ name, outcome: "not-installed" });
      continue;
    }
    const onDisk = inventory.skills.some((row) => row.name === name);
    const approved = lock.skills.some((entry) => entry.name === name);
    if (!onDisk && !approved) {
      members.push({ name, outcome: "not-installed" });
      continue;
    }
    try {
      const removal = skillRemovalActions(ctx, name, hardDelete, lock);
      lock = removal.lock;
      actions.push(...removal.actions);
      members.push({
        name,
        outcome: removal.summary.kind === "orphaned-approval" ? "orphaned-approval" : "removed",
        summary: removal.summary,
      });
    } catch (err) {
      // FAIL-CLOSED, whole-plan: one refusing member (ambiguous duplicate, nested
      // child, machine root, quarantined-only) refuses the ENTIRE uninstall at plan
      // time — nothing has been removed, and nothing will be until it's resolved.
      if (err instanceof AihError) {
        throw refuse(
          `pack ${packName}: member ${name} blocks the uninstall — ${err.message}\n` +
            "no member was removed (a pack uninstall is all-or-nothing); resolve that member " +
            `first or remove it individually with \`aih skill remove --name ${name}\``,
        );
      }
      throw err;
    }
  }

  const advisories = members.flatMap((row) =>
    row.outcome === "not-installed" ? [] : row.summary.advisories,
  );
  actions.push(
    digest("pack uninstall", uninstallText(packName, members, advisories), {
      pack: packName,
      hardDelete,
      counts: {
        members: members.length,
        removed: members.filter((row) => row.outcome === "removed").length,
        orphanedApprovals: members.filter((row) => row.outcome === "orphaned-approval").length,
        notInstalled: members.filter((row) => row.outcome === "not-installed").length,
      },
      members: members.map(memberData),
      manifest: "unchanged",
      lockfile: AIH_SKILLS_LOCK_FILE,
    }),
  );
  return plan("pack uninstall", ...actions);
}

export const packUninstallCommand: CommandSpec = {
  name: "uninstall",
  summary:
    "Uninstall a pack's installed members — archive each (reversible) and drop its approval; the manifest curation stays",
  options: [
    {
      flags: "--pack <name>",
      description: "the pack whose installed members to remove (required)",
    },
    {
      flags: "--delete",
      description:
        "hard-delete each member to a gitignored *.aih.bak sibling instead of the reversible .aih/legacy/ archive",
    },
  ],
  plan: packUninstallPlan,
};
