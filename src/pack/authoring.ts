import { AihError } from "../errors.js";
import {
  type CommandOption,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  writeJson,
} from "../internals/plan.js";
import {
  AIH_SKILLS_LOCK_FILE,
  readSkillsLock,
  type SkillLockEntry,
  type SkillsLock,
  skillNameSchema,
} from "../skill/lockfile.js";
import {
  AIH_PACKS_FILE,
  type Pack,
  type PackSkillRef,
  type PacksFile,
  readPacksFileStrictForWrite,
} from "./manifest.js";

/**
 * `aih pack add` / `pack remove-entry` / `pack init` — slice 2 of packs: the
 * WRITE commands (dry-run previews, `--apply` executes) that author the
 * committed `aih-packs.json` CURATION. The `aih-skills.lock.json` stays the PIN
 * AUTHORITY: authoring DERIVES every skill ref from its lock entry — the
 * operator names a skill, aih copies `{name, source, commit}` from the lock —
 * so authoring never invents a pin and never touches the lock, cards, or skill
 * dirs. All manifest reads go through the fail-CLOSED
 * `readPacksFileStrictForWrite` (a rewrite over the fail-soft read would
 * silently delete malformed sibling packs). Plans are pure fs (#35); the single
 * `writeJson` rides the standard plan/apply gate (containment + dirty-worktree
 * inherited).
 */

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** The required `--pack` / `--skill` flag for `command`, or a fail-closed refusal. */
function requireOption(
  ctx: PlanContext,
  key: "pack" | "skill",
  command: string,
  what: string,
): string {
  const value = optionString(ctx, key);
  if (value === undefined) {
    const placeholder = key === "pack" ? "<pack>" : "<name>";
    throw refuse(`pack ${command} requires --${key} ${placeholder} — ${what}`);
  }
  const parsed = skillNameSchema.safeParse(value);
  if (!parsed.success) {
    throw refuse(
      `pack ${command} requires a safe --${key} value (path segments only; no .., absolute paths, backslashes, or control chars)`,
    );
  }
  return parsed.data;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

/** The manifest ref DERIVED from a lock entry — authoring copies the pin, never invents one. */
export function deriveRef(entry: SkillLockEntry): PackSkillRef {
  return { name: entry.name, source: entry.source, commit: entry.commit };
}

/**
 * Append `ref` to `packName`, creating the pack when absent — immutable. Skills
 * are name-sorted inside the pack and packs name-sorted across the file, for
 * stable committed diffs (the `upsertSkillLockEntry` rationale). `description`
 * is applied only at creation (an existing pack's curation prose stays its own).
 */
export function upsertPack(
  file: PacksFile,
  packName: string,
  ref: PackSkillRef,
  description?: string,
): PacksFile {
  const existing = file.packs.find((pack) => pack.name === packName);
  const next: Pack =
    existing === undefined
      ? {
          name: packName,
          ...(description !== undefined ? { description } : {}),
          skills: [ref],
        }
      : { ...existing, skills: [...existing.skills, ref].sort(byName) };
  return {
    schemaVersion: 1,
    packs: [...file.packs.filter((pack) => pack.name !== packName), next].sort(byName),
  };
}

/**
 * Drop `skillName`'s ref from `packName` — immutable. A pack emptied by the
 * removal is dropped WHOLE (the schema requires at least one skill ref, so an
 * empty pack could never be read back).
 */
export function removeEntry(file: PacksFile, packName: string, skillName: string): PacksFile {
  return {
    schemaVersion: 1,
    packs: file.packs.flatMap((pack) => {
      if (pack.name !== packName) return [pack];
      const skills = pack.skills.filter((ref) => ref.name !== skillName);
      return skills.length === 0 ? [] : [{ ...pack, skills }];
    }),
  };
}

/**
 * The ready/blocked hint for one pack, judged against the lock we already read —
 * the digest's cheap preview of `pack status`'s approval axis (no inventory walk).
 */
function packRollup(pack: Pack, lock: SkillsLock): "ready" | "blocked" {
  const lockByName = new Map(lock.skills.map((entry) => [entry.name, entry]));
  const approved = pack.skills.every((ref) => {
    const entry = lockByName.get(ref.name);
    return entry !== undefined && entry.source === ref.source && entry.commit === ref.commit;
  });
  return approved ? "ready" : "blocked";
}

/** One digest row per ref — mirrors status.ts's rowLine source@commit12 shape. */
function refLine(ref: PackSkillRef): string {
  return `  - ${ref.name}  (${ref.source}@${ref.commit.slice(0, 12)})`;
}

function packAddPlan(ctx: PlanContext): Plan {
  const packName = requireOption(ctx, "pack", "add", "the pack to curate into");
  const skillName = requireOption(ctx, "skill", "add", "the approved skill to add");
  // The lock is the pin authority — the ref is DERIVED from the entry, so a name
  // with no entry has nothing to derive from (authoring only curates approvals).
  const lock = readSkillsLock(ctx.root);
  const entry = lock.skills.find((skill) => skill.name === skillName);
  if (entry === undefined) {
    throw refuse(
      `skill ${skillName} is not approved — run \`aih skill vet\` + \`aih skill approve\` first ` +
        `(pack authoring only curates skills ${AIH_SKILLS_LOCK_FILE} already pins)`,
    );
  }
  const manifest = readPacksFileStrictForWrite(ctx.root);
  const target = manifest.packs.find((pack) => pack.name === packName);
  if (target?.skills.some((ref) => ref.name === skillName)) {
    throw refuse(`skill ${skillName} is already in pack ${packName} — nothing to add`);
  }
  const other = manifest.packs.find(
    (pack) => pack.name !== packName && pack.skills.some((ref) => ref.name === skillName),
  );
  if (other !== undefined) {
    throw refuse(
      `skill ${skillName} is already in pack ${other.name} — one name, one owning pack ` +
        `(a second listing would fail \`aih pack validate\` with pack.duplicate-name); run ` +
        `\`aih pack remove-entry --pack ${other.name} --skill ${skillName}\` first`,
    );
  }
  const ref = deriveRef(entry);
  const next = upsertPack(manifest, packName, ref, optionString(ctx, "description"));
  const written = next.packs.find((pack) => pack.name === packName);
  const size = written?.skills.length ?? 1;
  const created = target === undefined;
  const rollup = written === undefined ? "ready" : packRollup(written, lock);
  const text = [
    `Pack: ${packName} (${created ? "created" : "updated"} — ${size} skill${size === 1 ? "" : "s"})`,
    `Skill: ${skillName}  (${ref.source}@${ref.commit.slice(0, 12)}) — derived from ${AIH_SKILLS_LOCK_FILE}`,
    `Manifest: ${AIH_PACKS_FILE}`,
    `Rollup: ${rollup} — run \`aih pack status\` for the install axis`,
  ].join("\n");
  return plan(
    "pack add",
    writeJson(
      AIH_PACKS_FILE,
      next,
      `add ${skillName} to pack ${packName} in the committed pack manifest`,
    ),
    digest("pack add", text, {
      pack: packName,
      skill: skillName,
      source: ref.source,
      commit: ref.commit,
      created,
      packSize: size,
      rollup,
    }),
  );
}

function packRemoveEntryPlan(ctx: PlanContext): Plan {
  const packName = requireOption(ctx, "pack", "remove-entry", "the pack to remove the skill from");
  const skillName = requireOption(ctx, "skill", "remove-entry", "the skill ref to remove");
  const manifest = readPacksFileStrictForWrite(ctx.root);
  const target = manifest.packs.find((pack) => pack.name === packName);
  if (target === undefined) {
    throw refuse(`no pack named ${packName} in ${AIH_PACKS_FILE} — nothing to remove from`);
  }
  if (!target.skills.some((ref) => ref.name === skillName)) {
    throw refuse(`skill ${skillName} is not in pack ${packName} — nothing to remove`);
  }
  const next = removeEntry(manifest, packName, skillName);
  const survivor = next.packs.find((pack) => pack.name === packName);
  const dropped = survivor === undefined;
  const text = [
    dropped
      ? `Pack: ${packName} (dropped — its last skill was removed; a pack needs at least one skill ref)`
      : `Pack: ${packName} (now ${survivor.skills.length} skill${survivor.skills.length === 1 ? "" : "s"})`,
    `Skill: ${skillName} removed from the curation`,
    `Approval: untouched — ${skillName} stays approved in ${AIH_SKILLS_LOCK_FILE}`,
    `Manifest: ${AIH_PACKS_FILE}`,
  ].join("\n");
  return plan(
    "pack remove-entry",
    writeJson(
      AIH_PACKS_FILE,
      next,
      dropped
        ? `remove ${skillName} from pack ${packName} (dropping the emptied pack)`
        : `remove ${skillName} from pack ${packName} in the committed pack manifest`,
    ),
    digest("pack remove-entry", text, {
      pack: packName,
      skill: skillName,
      packDropped: dropped,
      packSize: survivor?.skills.length ?? 0,
    }),
  );
}

function packInitPlan(ctx: PlanContext): Plan {
  const packName = requireOption(ctx, "pack", "init", "the pack to seed");
  const manifest = readPacksFileStrictForWrite(ctx.root);
  if (manifest.packs.some((pack) => pack.name === packName)) {
    throw refuse(
      `pack ${packName} already exists in ${AIH_PACKS_FILE} — extend it with \`aih pack add\``,
    );
  }
  const lock = readSkillsLock(ctx.root);
  const tagged = lock.skills.filter((entry) => entry.pack === packName);
  if (tagged.length === 0) {
    throw refuse(
      `no approved skills tagged pack=${packName} in ${AIH_SKILLS_LOCK_FILE}; approve with ` +
        `\`aih skill approve --pack ${packName}\` or curate one-by-one with \`aih pack add\``,
    );
  }
  // Fail-closed: a tagged skill already curated in ANOTHER pack would make init
  // write a manifest its own sibling gate (`pack validate`) immediately fails
  // with pack.duplicate-name — refuse instead of authoring a broken curation.
  const owned = new Map<string, string>();
  for (const pack of manifest.packs) {
    for (const ref of pack.skills) owned.set(ref.name, pack.name);
  }
  const conflicts = tagged.filter((entry) => owned.has(entry.name));
  if (conflicts.length > 0) {
    const listing = conflicts
      .map((entry) => `  - ${entry.name} (in pack ${owned.get(entry.name)})`)
      .join("\n");
    throw refuse(
      `cannot seed pack ${packName} — tagged skill(s) already curated in another pack ` +
        `(a second listing would fail \`aih pack validate\` with pack.duplicate-name):\n${listing}\n` +
        "remove them from their current pack with `aih pack remove-entry` first",
    );
  }
  const refs = tagged.map(deriveRef).sort(byName);
  const description = optionString(ctx, "description");
  const seeded: Pack = {
    name: packName,
    ...(description !== undefined ? { description } : {}),
    skills: refs,
  };
  const next: PacksFile = {
    schemaVersion: 1,
    packs: [...manifest.packs, seeded].sort(byName),
  };
  const text = [
    `Pack: ${packName} (created — ${refs.length} skill${refs.length === 1 ? "" : "s"} tagged pack=${packName})`,
    ...refs.map(refLine),
    `Manifest: ${AIH_PACKS_FILE}`,
    `Rollup: ${packRollup(seeded, lock)} — run \`aih pack status\` for the install axis`,
  ].join("\n");
  return plan(
    "pack init",
    writeJson(
      AIH_PACKS_FILE,
      next,
      `seed pack ${packName} from the ${refs.length} lock entr${refs.length === 1 ? "y" : "ies"} tagged pack=${packName}`,
    ),
    digest("pack init", text, {
      pack: packName,
      skills: refs,
      packSize: refs.length,
      rollup: packRollup(seeded, lock),
    }),
  );
}

const PACK_OPTION: CommandOption = { flags: "--pack <pack>", description: "the target pack name" };
const SKILL_OPTION: CommandOption = {
  flags: "--skill <name>",
  description: "the approved skill (its aih-skills.lock.json entry) to reference",
};
const DESCRIPTION_OPTION: CommandOption = {
  flags: "--description <text>",
  description: "pack description recorded when the pack is created",
};

export const packAddCommand: CommandSpec = {
  name: "add",
  summary:
    "Add an approved skill to a pack — the ref is derived from aih-skills.lock.json (--apply writes)",
  options: [PACK_OPTION, SKILL_OPTION, DESCRIPTION_OPTION],
  plan: packAddPlan,
};

export const packRemoveEntryCommand: CommandSpec = {
  name: "remove-entry",
  summary:
    "Remove a skill ref from a pack (an emptied pack is dropped; the skill's approval is untouched)",
  options: [PACK_OPTION, SKILL_OPTION],
  plan: packRemoveEntryPlan,
};

export const packInitCommand: CommandSpec = {
  name: "init",
  summary: "Seed a new pack from every lock entry tagged pack=<pack> by `aih skill approve --pack`",
  options: [PACK_OPTION, DESCRIPTION_OPTION],
  plan: packInitPlan,
};
