import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AihError } from "../errors.js";
import { readIfExists, readRegularFile } from "../internals/fsxn.js";
import {
  type CommandOption,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { skillNameSchema } from "../skill/lockfile.js";
import {
  AIH_PACKS_FILE,
  type Pack,
  type PackSkillRef,
  type PacksFile,
  readPacksFile,
  readPacksFileStrictForWrite,
} from "./manifest.js";

const FIRST_PARTY_PACKS_DIR = "packs";

interface SourcePack {
  name: string;
  root: string;
  files: Array<{ rel: string; contents: string }>;
  refs: PackSkillRef[];
  description?: string;
}

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function requirePackName(ctx: PlanContext): string {
  const packName = optionString(ctx, "pack");
  if (packName === undefined) {
    throw refuse("pack scaffold requires --pack <pack> — the first-party pack to seed");
  }
  const result = skillNameSchema.safeParse(packName);
  if (!result.success) {
    throw refuse(`pack ${packName} is not path-safe — use a simple committed pack name`);
  }
  return packName;
}

function harnessPackageRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let current = start;
  for (;;) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "@aihq/harness") return current;
      } catch {
        // Keep walking; a malformed nearer package.json should not redirect the source root.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw refuse("cannot locate the @aihq/harness package root to read first-party packs");
}

function firstPartyPacksRoot(): string {
  const root = join(harnessPackageRoot(), FIRST_PARTY_PACKS_DIR);
  if (!existsSync(root)) {
    throw refuse(
      `first-party pack assets are missing from this install — ${FIRST_PARTY_PACKS_DIR}/ must be included in the package`,
    );
  }
  return root;
}

function toSourceRel(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw refuse(`refusing first-party pack path outside ${root}: ${path}`);
  }
  return rel.replace(/\\/g, "/");
}

function listFiles(root: string): Array<{ rel: string; contents: string }> {
  const out: Array<{ rel: string; contents: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) {
        throw refuse(`refusing to scaffold first-party pack through symlink: ${abs}`);
      }
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = readRegularFile(abs);
      if (contents === undefined) {
        throw refuse(
          `refusing to scaffold unreadable or non-regular first-party pack file: ${abs}`,
        );
      }
      out.push({ rel: toSourceRel(root, abs), contents: contents.toString("utf8") });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function skillRefs(packName: string, packRoot: string): PackSkillRef[] {
  const refs: PackSkillRef[] = [];
  for (const entry of readdirSync(packRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const result = skillNameSchema.safeParse(entry.name);
    if (!result.success) {
      throw refuse(`first-party pack ${packName} has unsafe skill directory ${entry.name}`);
    }
    const skillRoot = join(packRoot, entry.name);
    const info = lstatSync(skillRoot);
    if (info.isSymbolicLink()) {
      throw refuse(`refusing to scaffold first-party pack symlink: ${skillRoot}`);
    }
    if (existsSync(join(skillRoot, "SKILL.md"))) {
      refs.push({
        name: entry.name,
        source: posix.join(FIRST_PARTY_PACKS_DIR, packName, entry.name),
        commit: "local",
      });
    }
  }
  if (refs.length === 0) {
    throw refuse(`first-party pack ${packName} has no skill directories with SKILL.md`);
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name));
}

function sourceMetadata(packName: string): Pack | undefined {
  const root = harnessPackageRoot();
  if (readIfExists(join(root, AIH_PACKS_FILE)) === undefined) return undefined;
  return readPacksFile(root).packs.find((pack) => pack.name === packName);
}

function availablePacks(packsRoot = firstPartyPacksRoot()): string[] {
  return readdirSync(packsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => skillNameSchema.safeParse(name).success)
    .sort();
}

function loadSourcePack(packName: string): SourcePack {
  const packsRoot = firstPartyPacksRoot();
  const packRoot = join(packsRoot, packName);
  if (!existsSync(packRoot)) {
    const available = availablePacks(packsRoot);
    throw refuse(
      `unknown first-party pack ${packName}` +
        (available.length > 0 ? ` — available: ${available.join(", ")}` : ""),
    );
  }
  const info = lstatSync(packRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw refuse(`first-party pack ${packName} is not a plain directory`);
  }
  return {
    name: packName,
    root: packRoot,
    files: listFiles(packRoot),
    refs: skillRefs(packName, packRoot),
    description: sourceMetadata(packName)?.description,
  };
}

function mergeSeededPack(manifest: PacksFile, source: SourcePack): PacksFile {
  const existing = manifest.packs.find((pack) => pack.name === source.name);
  const seededNames = new Set(source.refs.map((ref) => ref.name));
  for (const pack of manifest.packs) {
    if (pack.name === source.name) continue;
    const conflict = pack.skills.find((ref) => seededNames.has(ref.name));
    if (conflict !== undefined) {
      throw refuse(
        `cannot scaffold pack ${source.name} — skill ${conflict.name} is already curated in pack ${pack.name}`,
      );
    }
  }
  if (existing !== undefined) {
    const conflicts = existing.skills.filter((ref) => {
      const seeded = source.refs.find((candidate) => candidate.name === ref.name);
      return seeded !== undefined && (seeded.source !== ref.source || seeded.commit !== ref.commit);
    });
    if (conflicts.length > 0) {
      throw refuse(
        `cannot scaffold pack ${source.name} — existing ref(s) disagree with first-party source: ${conflicts
          .map((ref) => ref.name)
          .join(", ")}`,
      );
    }
  }
  const nextPack: Pack = {
    name: source.name,
    ...(existing?.description !== undefined
      ? { description: existing.description }
      : source.description !== undefined
        ? { description: source.description }
        : {}),
    ...(existing?.requiredChecks !== undefined ? { requiredChecks: existing.requiredChecks } : {}),
    skills: [
      ...(existing?.skills.filter((ref) => !seededNames.has(ref.name)) ?? []),
      ...source.refs,
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
  return {
    schemaVersion: 1,
    packs: [...manifest.packs.filter((pack) => pack.name !== source.name), nextPack].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}

function packScaffoldPlan(ctx: PlanContext): Plan {
  const packName = requirePackName(ctx);
  const source = loadSourcePack(packName);
  const manifest = readPacksFileStrictForWrite(ctx.root);
  const next = mergeSeededPack(manifest, source);
  const fileActions = source.files.map((file) =>
    writeText(
      posix.join(FIRST_PARTY_PACKS_DIR, packName, file.rel),
      file.contents,
      `first-party pack ${packName}: ${file.rel}`,
    ),
  );
  const skillLines = source.refs.map((ref) => `  - ${ref.name}: ${ref.source} (${ref.commit})`);
  const text = [
    `Pack: ${packName}`,
    `Source: ${source.root}`,
    `Files: ${source.files.length} under ${FIRST_PARTY_PACKS_DIR}/${packName}/`,
    "Curated refs:",
    ...skillLines,
    `Manifest: ${AIH_PACKS_FILE}`,
    "Next:",
    ...source.refs.flatMap((ref) => [
      `  aih skill vet ${ref.source} --apply`,
      `  aih skill approve ${ref.source} --owner <team> --pack ${packName} --apply`,
    ]),
    `  aih pack install --pack ${packName} --apply`,
  ].join("\n");
  return plan(
    "pack scaffold",
    ...fileActions,
    writeJson(
      AIH_PACKS_FILE,
      next,
      `seed first-party pack ${packName} into the committed pack manifest`,
    ),
    digest("pack scaffold", text, {
      pack: packName,
      files: source.files.map((file) => posix.join(FIRST_PARTY_PACKS_DIR, packName, file.rel)),
      refs: source.refs,
      manifest: AIH_PACKS_FILE,
    }),
  );
}

const PACK_OPTION: CommandOption = {
  flags: "--pack <pack>",
  description: "the first-party pack to scaffold into this repo",
};

export const packScaffoldCommand: CommandSpec = {
  name: "scaffold",
  summary:
    "Seed a first-party pack into this repo's packs/ tree and aih-packs.json (--apply writes)",
  options: [PACK_OPTION],
  plan: packScaffoldPlan,
};
