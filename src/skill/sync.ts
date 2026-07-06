import { createHash } from "node:crypto";
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
import { readTrustLock, type TrustLockSource } from "../trust/lock.js";
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
  sha256: string;
}

interface SyncTarget extends MachineSkillRoot {
  home: string;
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
    return { ...root, home, skillDir: "" };
  });
}

export function assertSkillSyncRelativePathForTest(rel: string): string {
  if (
    rel.length === 0 ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("/") ||
    /^[A-Za-z]:\//.test(rel)
  ) {
    throw refuse(`refusing skill file outside source root: ${rel}`);
  }
  return rel;
}

function relWithin(root: string, abs: string): string {
  return assertSkillSyncRelativePathForTest(relative(root, abs).replace(/\\/g, "/"));
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

function readSyncFile(sourceRoot: string, file: string): Omit<SyncFile, "rel"> {
  const st = lstatSync(file);
  const readPath = st.isSymbolicLink() ? realpathSync(file) : file;
  if (st.isSymbolicLink()) relWithin(realpathSync(sourceRoot), readPath);
  const bytes = readRegularFile(readPath);
  if (bytes === undefined) {
    throw refuse(`refusing unreadable or non-regular skill file: ${file}`);
  }
  return {
    contents: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function syncFiles(row: SkillInventoryRow): SyncFile[] {
  const files = collectFiles(row.abs)
    .filter(isTextSkillFile)
    .map((file) => ({ rel: relWithin(row.abs, file), ...readSyncFile(row.abs, file) }));
  if (files.length === 0) {
    throw refuse(`approved promoted skill ${row.name} has no syncable text files`);
  }
  return files;
}

function promotedSourceId(ctx: PlanContext, row: SkillInventoryRow): string {
  const promotedRoot = join(ctx.root, ctx.contextDir, "skills");
  const rel = relWithin(promotedRoot, row.abs);
  const sourceId = rel.split("/")[0];
  if (sourceId === undefined || sourceId.length === 0) {
    throw refuse(`approved promoted skill ${row.name} is not under a promoted source id`);
  }
  return sourceId;
}

interface ExpectedArtifacts {
  hashes: Map<string, string>;
  origins: Map<string, string>;
}

interface SourceArtifactRel {
  name: string;
  prefix: string;
  rel: string;
}

function sortedPromotedSkills(promotedSkills: readonly string[]): string[] {
  return [...promotedSkills].sort((left, right) => {
    const lengthDelta = right.split("/").length - left.split("/").length;
    return lengthDelta === 0 ? right.length - left.length : lengthDelta;
  });
}

function promotedSkillAt(
  parts: readonly string[],
  index: number,
  promotedSkills: readonly string[],
): string | undefined {
  for (const skill of promotedSkills) {
    const skillParts = skill.split("/");
    if (index + skillParts.length >= parts.length) continue;
    if (skillParts.every((part, offset) => parts[index + offset] === part)) return skill;
  }
  return undefined;
}

function artifactRelForPromotedSkill(
  promotedSkills: readonly string[],
  sourcePath: string,
): SourceArtifactRel | undefined {
  const sortedSkills = sortedPromotedSkills(promotedSkills);
  for (const skill of sortedSkills) {
    const directPrefix = `${skill}/`;
    if (sourcePath.startsWith(directPrefix)) {
      return {
        name: skill,
        prefix: directPrefix,
        rel: sourcePath.slice(directPrefix.length),
      };
    }
  }
  const parts = sourcePath.split("/");
  for (let index = 1; index <= parts.length - 2; index += 1) {
    if (parts[index - 1] !== "skills") continue;
    const skill = promotedSkillAt(parts, index, sortedSkills);
    if (skill === undefined) continue;
    const skillParts = skill.split("/");
    return {
      name: skill,
      prefix: `${parts.slice(0, index + skillParts.length).join("/")}/`,
      rel: parts.slice(index + skillParts.length).join("/"),
    };
  }
  return undefined;
}

function addExpectedArtifact(
  name: string,
  expected: ExpectedArtifacts,
  rel: string,
  artifact: TrustLockSource["artifactHashes"][number],
): void {
  if (rel.length === 0) {
    throw refuse(`approved promoted skill ${name} has an empty trust-lock artifact receipt`);
  }
  const origin = expected.origins.get(rel);
  if (origin !== undefined) {
    throw refuse(
      `approved promoted skill ${name} has ambiguous trust-lock artifact receipts for ${rel}`,
    );
  }
  expected.hashes.set(rel, artifact.sha256);
  expected.origins.set(rel, artifact.path);
}

function expectedArtifactHashes(name: string, source: TrustLockSource): Map<string, string> {
  const expected: ExpectedArtifacts = { hashes: new Map(), origins: new Map() };
  let sourcePrefix: string | undefined;
  for (const artifact of source.artifactHashes) {
    const resolved = artifactRelForPromotedSkill(source.promotedSkills, artifact.path);
    if (resolved === undefined || resolved.name !== name) continue;
    if (sourcePrefix !== undefined && sourcePrefix !== resolved.prefix) {
      throw refuse(`approved promoted skill ${name} has multiple trust-lock source prefixes`);
    }
    sourcePrefix = resolved.prefix;
    addExpectedArtifact(name, expected, resolved.rel, artifact);
  }
  if (expected.hashes.size > 0) return expected.hashes;

  if (source.promotedSkills.length === 1 && source.promotedSkills[0] === name) {
    for (const artifact of source.artifactHashes) {
      addExpectedArtifact(name, expected, artifact.path, artifact);
    }
  }
  return expected.hashes;
}

function verifyApprovedArtifacts(
  ctx: PlanContext,
  row: SkillInventoryRow,
  files: readonly SyncFile[],
): void {
  const sourceId = promotedSourceId(ctx, row);
  const sources = readTrustLock(ctx.root).sources.filter(
    (item) => item.id === sourceId && item.promotedSkills.includes(row.name),
  );
  if (sources.length === 0) {
    throw refuse(
      `approved promoted skill ${row.name} has no trust-lock artifact receipt for source ${sourceId}`,
    );
  }
  if (sources.length > 1) {
    throw refuse(
      `approved promoted skill ${row.name} has ambiguous trust-lock source receipts for source ${sourceId}`,
    );
  }
  const source = sources[0];
  if (source === undefined) {
    throw refuse(
      `approved promoted skill ${row.name} has no trust-lock artifact receipt for source ${sourceId}`,
    );
  }
  const expected = expectedArtifactHashes(row.name, source);
  if (expected.size === 0) {
    throw refuse(
      `approved promoted skill ${row.name} has no trust-lock artifact receipt for source ${sourceId}`,
    );
  }
  const current = new Map(files.map((file) => [file.rel, file]));
  for (const [rel, hash] of expected) {
    const file = current.get(rel);
    if (file === undefined) {
      throw refuse(`approved promoted skill file is missing after approval: ${rel}`);
    }
    if (file.sha256 !== hash) {
      throw refuse(`promoted skill bytes changed after approval: ${rel}`);
    }
  }
  for (const file of files) {
    if (!expected.has(file.rel)) {
      throw refuse(
        `approved promoted skill ${row.name} has no trust-lock artifact receipt for ${file.rel}`,
      );
    }
  }
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
    return files.map((file) =>
      writeText(
        safeTargetPath(target, name, file.rel),
        file.contents,
        `sync approved skill ${name} to ${target.cli} machine root: ${file.rel}`,
        { external: true },
      ),
    );
  });
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function safeTargetPath(target: SyncTarget, name: string, fileRel: string): string {
  const targetPath = join(target.abs, name, fileRel);
  relWithin(target.abs, targetPath);
  const homeRel = relWithin(target.home, targetPath);
  let current = target.home;
  for (const segment of homeRel.split("/")) {
    current = join(current, segment);
    const st = lstatIfExists(current);
    if (st === undefined) break;
    if (st.isSymbolicLink()) {
      throw refuse(`refusing symlinked machine skill path: ${current}`);
    }
    if (current !== targetPath && !st.isDirectory()) {
      throw refuse(`refusing non-directory machine skill path ancestor: ${current}`);
    }
  }
  return targetPath;
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
  verifyApprovedArtifacts(ctx, row, files);
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
