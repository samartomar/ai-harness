import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import { sha256Hex } from "../bundle/index.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { ensureTrailingNewline, jsonFile, lines } from "../internals/render.js";
import { readSkillCard, skillCardRelPath } from "../skill/card.js";
import { type SkillInventoryRow, skillInventory } from "../skill/inventory.js";
import { AIH_SKILLS_LOCK_FILE, readSkillsLock, type SkillLockEntry } from "../skill/lockfile.js";
import { readTrustLock, type TrustLockSource } from "../trust/lock.js";
import {
  AIH_MARKETPLACE_FILE,
  DEFAULT_MARKETPLACE_OUT,
  type MarketplaceManifest,
  type MarketplaceSkill,
  marketplaceRelPathSchema,
} from "./manifest.js";

/**
 * `aih marketplace build` — slice 1 of the marketplace: package the APPROVED
 * skill set into a reproducible, verifiable DISTRIBUTION directory a team can
 * host anywhere (a git repo, a static host), never a registry or server. The
 * committed `aih-skills.lock.json` is the approval AUTHORITY: only its entries
 * are packaged, and every one must be cleanly installed — on disk, un-drifted,
 * unambiguous, with its committed card and content-addressed vet evidence
 * present — or the WHOLE build refuses fail-closed (a partial marketplace that
 * silently dropped a skill would read as complete to consumers).
 *
 * REPRODUCIBLE by construction: plan() is pure fs reads (#35 — no writes, no
 * spawns, no wall-clock; `--stamp` is operator-supplied), inputs are enumerated
 * name-sorted, and emitted content is derived only from on-disk bytes — two
 * builds over identical inputs are byte-identical, SHA256SUMS included.
 * Consumers stay on the existing `aih workspace add` channel; the vet gate
 * still runs at consume time, so hosting an artifact grants nothing by itself.
 */

const CHECKSUMS_FILE = "SHA256SUMS";

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Forward-slashed path, for artifact-relative keys independent of OS separators. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Validate an artifact-relative destination path BEFORE it is joined under the
 * out dir — the plan-time containment guard (the executor's `assertContained`
 * still re-checks the resolved write path). Everything here is aih-composed,
 * so a rejection means a hostile fragment (a crafted evidence filename, an
 * unsafe file name inside a skill dir) tried to steer a write.
 */
function assertSafeArtifactPath(rel: string, what: string): string {
  const result = marketplaceRelPathSchema.safeParse(rel);
  if (!result.success) {
    throw refuse(`unsafe ${what} path for the marketplace artifact: ${rel}`);
  }
  return rel;
}

/**
 * Every regular file under a skill dir, as skill-relative POSIX paths,
 * name-sorted for deterministic output. Fail-closed on symlinks (a link could
 * smuggle out-of-tree bytes into the artifact — the marketplace ships only the
 * plain files the vet gate scanned) and on any walked path that escapes the
 * skill dir (defense in depth; the walk composes paths downward so this only
 * fires on a hostile filesystem).
 */
function collectSkillFiles(name: string, skillDir: string): string[] {
  const out: string[] = [];
  const root = resolve(skillDir);
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw refuse(
        `skill ${name} contains a symlink at ${toPosix(relative(skillDir, abs))} — ` +
          "refusing to package it (links can point outside the vetted tree); replace it with a regular file",
      );
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (!st.isFile()) return;
    const rel = toPosix(relative(root, resolve(abs)));
    if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
      throw refuse(`skill ${name}: file escapes its skill directory: ${abs}`);
    }
    out.push(rel);
  };
  visit(skillDir);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * The single live (non-quarantined) install for an approved name, fail-closed.
 * The three ways an approval can be un-packageable each get a precise refusal:
 * not on disk (install it or retract the approval), drifted from its pin
 * (re-vet + re-approve), or ambiguous across physical installs (the artifact
 * cannot know which copy the approval vouches for).
 */
function resolveInstalledSkill(
  rows: readonly SkillInventoryRow[],
  ctx: PlanContext,
  entry: SkillLockEntry,
): SkillInventoryRow {
  const live = rows.filter((row) => row.name === entry.name && row.root !== "quarantined");
  if (live.length === 0) {
    throw refuse(
      `skill ${entry.name} is approved but not installed — install it (\`aih workspace add\`) ` +
        `or remove the approval (\`aih skill remove --name ${entry.name}\`)`,
    );
  }
  if (live.length > 1) {
    const where = live
      .map((row) => `  - ${toPosix(relative(ctx.root, row.abs))} (${row.root})`)
      .join("\n");
    throw refuse(
      `skill ${entry.name} matches ${live.length} physical installs — ambiguous, refusing to ` +
        `package an arbitrary copy:\n${where}\nremove the duplicate first, then rebuild`,
    );
  }
  const row = live[0];
  if (row === undefined) throw refuse(`skill ${entry.name} could not be resolved`); // unreachable
  if (row.status === "stale-pin") {
    throw refuse(
      `skill ${entry.name}'s on-disk copy has drifted from its approval` +
        `${row.driftReason !== undefined ? ` (${row.driftReason})` : ""} — re-vet and re-approve, then rebuild`,
    );
  }
  return row;
}

/**
 * The vetted hash for one installed skill file, from the owning trust-lock
 * source's `artifactHashes`. The lock records SOURCE-relative paths (see
 * `buildPromotion`), so the lookup mirrors `artifactTarget`'s prefix ladder in
 * reverse — `skills/<name>/<fileRel>` and `<name>/<fileRel>` — plus the literal
 * repo-relative path (a local source rooted at the repo records exactly that).
 * `undefined` when the file has no recorded hash (unmatched layouts fail open
 * here by design; the stale-pin guard and `trust verify` cover source drift).
 */
function vettedHashFor(
  source: TrustLockSource | undefined,
  name: string,
  fileRel: string,
  repoRel: string,
): string | undefined {
  if (source === undefined) return undefined;
  const byPath = new Map(source.artifactHashes.map((item) => [toPosix(item.path), item.sha256]));
  for (const candidate of [`skills/${name}/${fileRel}`, `${name}/${fileRel}`, repoRel]) {
    const hash = byPath.get(candidate);
    if (hash !== undefined) return hash;
  }
  return undefined;
}

/** One artifact file staged for emission: destination rel path + exact content. */
interface ArtifactFile {
  rel: string;
  contents: string;
}

interface BuiltSkill {
  manifest: MarketplaceSkill;
  files: ArtifactFile[];
  /** Payload byte count (skill files only), for the digest roll-up. */
  bytes: number;
}

/**
 * Package ONE approved skill: enumerate + hash its installed files, cross-check
 * every vetted hash (the marketplace ships EXACTLY the vetted bytes), and stage
 * the committed card + content-addressed vet evidence copies. Content is
 * normalized through {@link ensureTrailingNewline} — the identical
 * normalization the write engine applies — so the hashes recorded in the
 * manifest are the hashes of the bytes that actually land on disk.
 */
function buildSkill(
  ctx: PlanContext,
  entry: SkillLockEntry,
  row: SkillInventoryRow,
  trustSources: readonly TrustLockSource[],
): BuiltSkill {
  const name = entry.name;
  const owner = trustSources.find((source) => source.promotedSkills.includes(name));

  const files: ArtifactFile[] = [];
  const manifestFiles: MarketplaceSkill["files"] = [];
  let bytes = 0;
  for (const fileRel of collectSkillFiles(name, row.abs)) {
    const abs = join(row.abs, fileRel);
    const repoRel = toPosix(relative(ctx.root, abs));
    // ONE fd-guarded read per file: the bytes the drift check verifies are the
    // bytes that get packaged — a hash-then-reread pair would open a swap
    // window where unvetted bytes ship under a vetted skill's name, and a
    // symlink swapped in after enumeration must be refused, not followed.
    const raw = readRegularFile(abs);
    if (raw === undefined) {
      throw refuse(
        `skill ${name}: ${fileRel} vanished or stopped being a regular file during packaging`,
      );
    }
    const vetted = vettedHashFor(owner, name, fileRel, repoRel);
    if (vetted !== undefined && sha256OfBytes(raw) !== vetted) {
      throw refuse(
        `skill ${name}: ${fileRel} bytes differ from what was vetted (trust-lock hash mismatch) — ` +
          "re-vet and re-approve, or restore the vetted bytes",
      );
    }
    const contents = ensureTrailingNewline(raw.toString("utf8"));
    const dest = assertSafeArtifactPath(`skills/${name}/${fileRel}`, `skill ${name} file`);
    files.push({ rel: dest, contents });
    const size = Buffer.byteLength(contents, "utf8");
    bytes += size;
    manifestFiles.push({ path: dest, sha256: sha256Hex(contents), bytes: size });
  }

  // Committed card — keyed on the CANONICAL card path (never the lockfile's
  // `card` field, which a hostile lockfile could point at any in-repo file).
  const cardRel = skillCardRelPath(ctx.contextDir, name);
  const cardRaw = existsSync(join(ctx.root, cardRel))
    ? readFileSync(join(ctx.root, cardRel), "utf8")
    : undefined;
  if (cardRaw === undefined) {
    throw refuse(
      `skill ${name}'s approval evidence is incomplete — committed card missing at ${cardRel}; ` +
        "re-approve (`aih skill approve`) and rebuild",
    );
  }
  const cardDest = assertSafeArtifactPath(`cards/${name}.json`, `skill ${name} card`);
  files.push({ rel: cardDest, contents: ensureTrailingNewline(cardRaw) });

  // Vet evidence — content-addressed: the lock pins the evidence BYTES the
  // approval was granted against, so the match is by hash, never by filename.
  const evidence = findEvidenceFile(ctx.root, entry.evidenceSha256);
  if (evidence === undefined) {
    throw refuse(
      `skill ${name}'s approval evidence is incomplete — no file under .aih/skill-reports/ ` +
        `hashes to the approved evidence (${entry.evidenceSha256.slice(0, 12)}…); ` +
        "re-vet with --apply and re-approve, then rebuild",
    );
  }
  const evidenceDest = assertSafeArtifactPath(
    `evidence/${evidence.filename}`,
    `skill ${name} evidence`,
  );
  files.push({ rel: evidenceDest, contents: ensureTrailingNewline(evidence.contents) });

  // license / riskClass ride along from the committed card when it parses; a
  // hand-mangled card still packages (its existence is the refusal boundary),
  // it just ships without the derived convenience fields.
  const card = readSkillCard(ctx.root, ctx.contextDir, name);
  return {
    manifest: {
      name,
      source: entry.source,
      commit: entry.commit,
      verdict: entry.verdict,
      ...(card !== undefined ? { license: card.license, riskClass: card.riskClass } : {}),
      card: cardDest,
      evidence: evidenceDest,
      files: manifestFiles,
    },
    files,
    bytes,
  };
}

/** sha256 of exact on-disk bytes — the buffer-level hash approvals and the trust-lock record. */
function sha256OfBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The `.aih/skill-reports/` file whose raw bytes hash to `sha256` (name-sorted
 * scan). Each candidate is read ONCE through {@link readRegularFile} and hashed
 * in memory, and the returned contents are exactly the bytes that matched — a
 * hash-then-reread pair would open a swap window where unverified bytes get
 * packaged as approved evidence.
 */
function findEvidenceFile(
  root: string,
  sha256: string,
): { filename: string; contents: string } | undefined {
  const dir = join(root, ".aih", "skill-reports");
  if (!existsSync(dir)) return undefined;
  for (const entry of [...readdirSync(dir)].sort((a, b) => a.localeCompare(b))) {
    const raw = readRegularFile(join(dir, entry));
    if (raw === undefined) continue;
    if (sha256OfBytes(raw) === sha256) {
      return { filename: entry, contents: raw.toString("utf8") };
    }
  }
  return undefined;
}

/**
 * Fold staged artifact files into one deterministic map. Cards are keyed by
 * unique skill name and evidence is content-addressed, so a destination
 * collision with DIFFERENT bytes can only mean the composition itself is wrong
 * — fail closed rather than let the last write win silently. Collisions are
 * also checked CASE-INSENSITIVELY: two lock names differing only by case (each
 * valid alone, installable under different discovery roots) resolve to ONE
 * on-disk path on the case-insensitive filesystems the artifact will be built
 * or consumed on (Windows/macOS defaults), so the last write would silently
 * clobber the other skill's files.
 */
function foldArtifactFiles(built: readonly BuiltSkill[]): Map<string, string> {
  const byDest = new Map<string, string>();
  const byDestFolded = new Map<string, string>();
  for (const skill of built) {
    for (const file of skill.files) {
      const priorRel = byDestFolded.get(file.rel.toLowerCase());
      if (priorRel !== undefined && priorRel !== file.rel) {
        throw refuse(
          `marketplace artifact path collision on case-insensitive filesystems: ${priorRel} vs ${file.rel}`,
        );
      }
      const existing = byDest.get(file.rel);
      if (existing !== undefined && existing !== file.contents) {
        throw refuse(`marketplace artifact path collision with differing content: ${file.rel}`);
      }
      byDest.set(file.rel, file.contents);
      byDestFolded.set(file.rel.toLowerCase(), file.rel);
    }
  }
  return byDest;
}

/** SHA256SUMS body over every emitted file except itself — bundle's exact line format. */
function sha256Sums(entries: ReadonlyArray<[string, string]>): string {
  return `${entries.map(([rel, contents]) => `${sha256Hex(contents)}  ${rel}`).join("\n")}\n`;
}

/** One digest row per packaged skill: `- <name>  <verdict>  <commit12>  <N> file(s)`. */
function skillLine(skill: BuiltSkill): string {
  const m = skill.manifest;
  return `- ${m.name}  ${m.verdict}  ${m.commit.slice(0, 12)}  ${m.files.length} file(s)`;
}

function buildText(
  out: string,
  built: readonly BuiltSkill[],
  totalFiles: number,
  firstParty: readonly SkillLockEntry[] = [],
): string {
  const bytes = built.reduce((sum, skill) => sum + skill.bytes, 0);
  return lines(
    `marketplace artifact: ${built.length} skill(s) · ${totalFiles} file(s) · ${bytes} bytes → ${out}`,
    ...built.map(skillLine),
    ...(firstParty.length > 0
      ? [
          `excluded ${firstParty.length} first-party skill(s) — ship in-repo, not via the marketplace: ${firstParty
            .map((entry) => entry.name)
            .join(", ")}`,
        ]
      : []),
    "",
    "host this directory (git repo or static host) and consume with `aih workspace add` — " +
      "the vet gate still runs at consume time",
  );
}

function marketplaceBuildPlan(ctx: PlanContext): Plan {
  const out = optionString(ctx, "out") ?? DEFAULT_MARKETPLACE_OUT;
  const external = isAbsolute(out);
  const name = optionString(ctx, "name") ?? basename(resolve(ctx.root));
  const stamp = optionString(ctx, "stamp");

  const lock = readSkillsLock(ctx.root);
  if (lock.skills.length === 0) {
    throw refuse(
      `nothing approved to package — ${AIH_SKILLS_LOCK_FILE} has no valid approved skills; ` +
        "approve one first (`aih skill approve`)",
    );
  }

  // One inventory join for the whole build (pure fs), then per-entry resolution
  // in name order — the lock read is already name-sorted-on-write, but a
  // hand-edited lock must not be able to reorder the artifact.
  const inventory = skillInventory(ctx);
  const trustSources = readTrustLock(ctx.root).sources;
  // First-party skills (commit "local") ship IN the repo, not through the hosted
  // marketplace artifact: a bundled first-party skill is delivered by having the
  // repo, and keeps no committed promoted copy or vet evidence to package. Exclude
  // them here, but REPORT them below — this module's fail-closed contract forbids a
  // SILENT drop; they are simply out of scope for a distributable artifact.
  const sorted = [...lock.skills].sort((a, b) => a.name.localeCompare(b.name));
  const firstParty = sorted.filter((entry) => entry.commit === "local");
  const entries = sorted.filter((entry) => entry.commit !== "local");
  const built = entries.map((entry) =>
    buildSkill(ctx, entry, resolveInstalledSkill(inventory.skills, ctx, entry), trustSources),
  );

  const manifest: MarketplaceManifest = {
    schemaVersion: 1,
    name,
    ...(stamp !== undefined ? { stamp } : {}),
    skills: built.map((skill) => skill.manifest),
  };

  // SHA256SUMS covers EVERY emitted file except itself — including the manifest,
  // whose hashed string is exactly the `jsonFile` rendering the executor writes.
  const artifactFiles = [...foldArtifactFiles(built).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const manifestEntry: [string, string] = [AIH_MARKETPLACE_FILE, jsonFile(manifest)];
  const sumsEntries: Array<[string, string]> = [...artifactFiles, manifestEntry].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const actions: Action[] = artifactFiles.map(([rel, contents]) =>
    writeText(posix.join(toPosix(out), rel), contents, `marketplace artifact: ${rel}`, {
      external,
    }),
  );
  actions.push(
    writeJson(posix.join(toPosix(out), AIH_MARKETPLACE_FILE), manifest, "marketplace manifest", {
      external,
    }),
    writeText(
      posix.join(toPosix(out), CHECKSUMS_FILE),
      sha256Sums(sumsEntries),
      "marketplace SHA256SUMS",
      { external },
    ),
    digest("marketplace build", buildText(out, built, sumsEntries.length + 1, firstParty), {
      out,
      name,
      ...(stamp !== undefined ? { stamp } : {}),
      counts: {
        skills: built.length,
        // Every emitted file: payload + cards + evidence + manifest + SHA256SUMS.
        files: sumsEntries.length + 1,
        bytes: built.reduce((sum, skill) => sum + skill.bytes, 0),
      },
      skills: built.map((skill) => ({
        name: skill.manifest.name,
        verdict: skill.manifest.verdict,
        commit: skill.manifest.commit,
        files: skill.manifest.files.length,
      })),
      ...(firstParty.length > 0
        ? { firstPartyExcluded: firstParty.map((entry) => entry.name) }
        : {}),
    }),
  );
  return plan("marketplace build", ...actions);
}

export const marketplaceBuildCommand: CommandSpec = {
  name: "build",
  summary:
    "Package the approved skill set (lockfile authority) into a reproducible, hostable marketplace artifact",
  options: [
    {
      flags: "--out <dir>",
      description: "output directory for the marketplace artifact",
      default: DEFAULT_MARKETPLACE_OUT,
    },
    {
      flags: "--name <name>",
      description: "marketplace name recorded in the manifest (default: repo root basename)",
    },
    {
      flags: "--stamp <iso>",
      description:
        "optional manifest stamp (operator-supplied; the build itself never reads the clock)",
    },
  ],
  plan: marketplaceBuildPlan,
};
