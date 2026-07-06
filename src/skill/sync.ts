import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { AihError } from "../errors.js";
import { homeDir } from "../internals/cli-detect.js";
import { type Cli, resolveClis } from "../internals/clis.js";
import { readRegularFile } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  writeText,
} from "../internals/plan.js";
import { normalizeRel } from "../internals/worktree-gate.js";
import { type SkillInventoryRow, skillInventory } from "./inventory.js";
import { skillNameSchema } from "./lockfile.js";
import {
  type MachineSkillRoot,
  machineSkillRootForCli,
  supportedMachineSkillCliList,
} from "./machine-roots.js";
import { nestedChildSkills } from "./remove.js";

interface SyncFile {
  rel: string;
  contents: string;
}

interface SyncTarget extends MachineSkillRoot {
  skillDir: string;
}

const TEXT_SKILL_EXTENSIONS = new Set(["", ".md", ".txt", ".json", ".yaml", ".yml", ".toml"]);
const SKIP_DIRS = new Set([".git", ".hg", ".svn", ".aih", "coverage", "dist", "node_modules"]);

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function requiredSkillName(ctx: PlanContext): string {
  const name = optionString(ctx, "name");
  if (name === undefined) throw refuse("skill sync requires --name <skill>");
  const parsed = skillNameSchema.safeParse(name);
  if (!parsed.success) {
    throw refuse(`unsafe skill name: ${parsed.error.issues[0]?.message ?? name}`);
  }
  return parsed.data;
}

function selectedClis(ctx: PlanContext): Cli[] {
  if (optionString(ctx, "cli") === undefined) {
    throw refuse("skill sync requires --cli <claude|codex>");
  }
  return resolveClis(ctx.options, { strict: true });
}

function syncTargets(ctx: PlanContext): SyncTarget[] {
  const home = homeDir(ctx);
  return selectedClis(ctx).map((cli) => {
    const root = machineSkillRootForCli(home, cli);
    if (root === undefined) {
      throw refuse(
        `${cli} does not have a machine skill-discovery path; supported: ${supportedMachineSkillCliList()}`,
      );
    }
    return { ...root, skillDir: "" };
  });
}

function relWithin(root: string, abs: string): string {
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.length === 0 || rel === ".." || rel.startsWith("../")) {
    throw refuse(`refusing skill file outside source root: ${abs}`);
  }
  return rel;
}

function isTextSkillFile(path: string): boolean {
  return TEXT_SKILL_EXTENSIONS.has(extname(path).toLowerCase());
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      if (statSync(abs).isFile()) out.push(abs);
      return;
    }
    if (st.isDirectory()) {
      if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile()) out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => relWithin(root, a).localeCompare(relWithin(root, b)));
}

function readSyncFile(sourceRoot: string, file: string): string {
  const st = lstatSync(file);
  const readPath = st.isSymbolicLink() ? realpathSync(file) : file;
  if (st.isSymbolicLink()) relWithin(realpathSync(sourceRoot), readPath);
  const bytes = readRegularFile(readPath);
  if (bytes === undefined) {
    throw refuse(`refusing unreadable or non-regular skill file: ${file}`);
  }
  return bytes.toString("utf8");
}

function syncFiles(row: SkillInventoryRow): SyncFile[] {
  const files = collectFiles(row.abs)
    .filter(isTextSkillFile)
    .map((file) => ({ rel: relWithin(row.abs, file), contents: readSyncFile(row.abs, file) }));
  if (files.length === 0) {
    throw refuse(`approved promoted skill ${row.name} has no syncable text files`);
  }
  return files;
}

function resolveApprovedPromotedSkill(ctx: PlanContext, name: string): SkillInventoryRow {
  const inventory = skillInventory(ctx);
  const promoted = inventory.skills.filter((row) => row.name === name && row.root === "promoted");
  const approved = promoted.filter((row) => row.status === "approved");
  if (approved.length === 0) {
    throw refuse(`no approved promoted skill named ${name} found to sync`);
  }
  if (approved.length > 1) {
    const where = approved
      .map((row) => `  - ${normalizeRel(relative(ctx.root, row.abs))}`)
      .join("\n");
    throw refuse(`approved promoted skill ${name} is ambiguous across installs:\n${where}`);
  }
  const row = approved[0];
  if (row === undefined) throw refuse(`no approved promoted skill named ${name} found to sync`);
  const nested = nestedChildSkills(inventory.skills, row);
  if (nested.length > 0) {
    const children = nested
      .map((child) => `  - ${child.name} (${normalizeRel(relative(ctx.root, child.abs))})`)
      .join("\n");
    throw refuse(
      `approved promoted skill ${name} contains nested skill(s); syncing it would copy them too:\n${children}`,
    );
  }
  return row;
}

function plannedWrites(
  name: string,
  files: readonly SyncFile[],
  targets: readonly SyncTarget[],
): Action[] {
  return targets.flatMap((target) => {
    const skillDir = join(target.abs, name);
    return files.map((file) =>
      writeText(
        join(skillDir, file.rel),
        file.contents,
        `sync approved skill ${name} to ${target.cli} machine root: ${file.rel}`,
        { external: true },
      ),
    );
  });
}

function syncText(input: {
  name: string;
  source: string;
  files: readonly SyncFile[];
  targets: readonly SyncTarget[];
}): string {
  const targetLines = input.targets.map((target) => `  - ${target.cli}: ${target.abs}`);
  return [
    `Skill sync plan for ${input.name}`,
    "",
    `Source: ${input.source}`,
    `Files: ${input.files.length}`,
    "Machine roots:",
    ...targetLines,
    "",
    "Dry-run by default; rerun with --apply to write these files.",
  ].join("\n");
}

function skillSyncPlan(ctx: PlanContext): Plan {
  const name = requiredSkillName(ctx);
  const row = resolveApprovedPromotedSkill(ctx, name);
  const files = syncFiles(row);
  const targets = syncTargets(ctx).map((target) => ({
    ...target,
    skillDir: join(target.abs, name),
  }));
  const source = normalizeRel(relative(ctx.root, row.abs));
  return plan(
    "skill sync",
    ...plannedWrites(name, files, targets),
    digest("skill sync", syncText({ name, source, files, targets }), {
      name,
      source,
      fileCount: files.length,
      targets: targets.map((target) => ({ cli: target.cli, path: target.skillDir })),
    }),
  );
}

export const skillSyncCommand: CommandSpec = {
  name: "sync",
  summary: "Sync an approved promoted skill into a CLI machine skill-discovery path",
  options: [{ flags: "--name <skill>", description: "approved promoted skill name to sync" }],
  plan: skillSyncPlan,
};
