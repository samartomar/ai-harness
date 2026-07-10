import { type Dirent, readdirSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { BASELINE_REPORTS_DIR } from "../baseline-evidence/schema.js";
import { sha256Hex, signAction } from "../bundle/index.js";
import { readRegularFile } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  probe,
  probeMany,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { ensureTrailingNewline, jsonFile, lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { RUNS_DIR } from "../logging/run-log.js";
import { AIH_PACKS_FILE } from "../pack/manifest.js";
import { REPORTS_DIR } from "../report/index.js";
import { EVIDENCE_DIR } from "../skill/approve.js";
import { skillCardsDir } from "../skill/card.js";
import { AIH_SKILLS_LOCK_FILE } from "../skill/lockfile.js";
import { TRUST_LOCK_FILE } from "../trust/lock.js";
import { truthPackEvidenceSource } from "../truth/index.js";
import { PACKAGE_NAME, REPO, VERSION } from "../version.js";
import {
  DEFAULT_EVIDENCE_OUT,
  EVIDENCE_FILE,
  EVIDENCE_KINDS,
  type EvidenceBundle,
  type EvidenceHarness,
  type EvidenceKind,
} from "./manifest.js";

/**
 * `aih evidence build` — package the AUDIT TRAIL aih already emits into one
 * deterministic, verifiable directory: the approval lock, packs manifest,
 * trust lock, committed skill cards, vet evidence, run logs, and report/SARIF
 * outputs, each discovered from the constant its OWNING module exports (never
 * a restrung path). The output is the EXACT fleet-bundle layout —
 * `files/<rel>` copies, `manifest.json`, `SHA256SUMS` — so `aih verify-bundle
 * --bundle <out>` re-checks it unchanged, PLUS `evidence.json`, the typed
 * kind index (`src/evidence/manifest.ts`).
 *
 * DETERMINISTIC by construction: plan() is pure fs reads (#35), discovery is
 * name-sorted, no wall-clock stamps exist anywhere, and every recorded hash is
 * computed over the SAME in-memory content the write action lands (normalized
 * through {@link ensureTrailingNewline}, the write engine's own
 * normalization) — never a hash-then-reread pair, which would open a swap
 * window where unhashed bytes ship under a hashed name. Two builds over
 * identical inputs are byte-identical. An artifact kind with nothing on disk
 * is skipped silently — the index only lists what exists. Optional
 * `--sign cosign|gh` rides the fleet bundle's best-effort {@link signAction}
 * (the marketplace's fail-loud publish signing is publish-specific).
 */

const CHECKSUMS_FILE = "SHA256SUMS";
const MANIFEST_FILE = "manifest.json";

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Forward-slashed path, for bundle-relative keys independent of OS separators. */
function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function bundlePath(out: string, ...parts: string[]): string {
  return posix.join(toPosix(out), ...parts.map(toPosix));
}

/**
 * One-level listing of regular files under `relDir`, as repo-relative POSIX
 * paths, name-sorted. Fail-closed on hostile names (a separator or `..` inside
 * a directory ENTRY can only mean a hostile filesystem — refuse, don't
 * compose) and on symlinks (`isFile()` is false for them — the bundle ships
 * only plain files, mirroring the marketplace's symlink refusal).
 */
function listFiles(root: string, relDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true });
  } catch {
    return []; // absent dir → the kind simply has no artifacts
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes(".."),
    )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => posix.join(toPosix(relDir), name));
}

interface Candidate {
  kind: EvidenceKind;
  rel: string;
  contents?: string;
}

/**
 * Every path that COULD hold an indexed artifact, tagged with its kind. Fixed
 * files come straight from their owning modules' exported constants; directory
 * kinds are one-level scans filtered to the extension their writer emits.
 * Report/SARIF discovery covers the default output locations
 * (`REPORTS_DIR` for `aih report --format md|html`; `--sarif <file>` is
 * operator-named, conventionally at the root or under `.aih/`).
 */
function candidates(
  ctx: PlanContext,
  truthPack?: { contents: string; rel: ".aih/truth-pack.json" },
): Candidate[] {
  const out: Candidate[] = [
    { kind: "skills-lock", rel: AIH_SKILLS_LOCK_FILE },
    { kind: "packs", rel: AIH_PACKS_FILE },
    { kind: "trust-lock", rel: TRUST_LOCK_FILE },
  ];
  for (const rel of listFiles(ctx.root, skillCardsDir(ctx.contextDir))) {
    if (rel.endsWith(".json")) out.push({ kind: "skill-card", rel });
  }
  for (const rel of listFiles(ctx.root, EVIDENCE_DIR)) {
    if (rel.endsWith(".json")) out.push({ kind: "skill-evidence", rel });
  }
  for (const rel of listFiles(ctx.root, BASELINE_REPORTS_DIR)) {
    if (rel.endsWith(".json")) out.push({ kind: "baseline-evidence", rel });
  }
  for (const rel of listFiles(ctx.root, RUNS_DIR)) {
    if (rel.endsWith(".jsonl")) out.push({ kind: "run-log", rel });
  }
  for (const rel of listFiles(ctx.root, REPORTS_DIR)) {
    if (rel.endsWith(".md") || rel.endsWith(".html")) out.push({ kind: "report", rel });
    if (rel.endsWith(".sarif")) out.push({ kind: "sarif", rel });
  }
  for (const rel of [...listFiles(ctx.root, "."), ...listFiles(ctx.root, ".aih")]) {
    if (rel.endsWith(".sarif")) out.push({ kind: "sarif", rel });
  }
  if (truthPack !== undefined) {
    out.push({ kind: "truth-pack", rel: truthPack.rel, contents: truthPack.contents });
  }
  return out;
}

interface DiscoveredArtifact {
  kind: EvidenceKind;
  /** Repo-relative POSIX source path (= manifest `files[].path`; copy at `files/<rel>`). */
  rel: string;
  /** Normalized contents — the exact bytes the copy write lands. */
  contents: string;
  sha256: string;
  bytes: number;
  schemaVersion: number;
}

/**
 * The artifact's own declared schemaVersion when its JSON carries one; else 1.
 * A run-log (`.jsonl`), a markdown/HTML report, or a SARIF file (which
 * declares `version`, not `schemaVersion`) all fall through to 1.
 */
function artifactSchemaVersion(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { schemaVersion?: unknown } | null;
    const version = parsed?.schemaVersion;
    if (typeof version === "number" && Number.isInteger(version) && version >= 1) return version;
  } catch {
    // not a single JSON document — fall through
  }
  return 1;
}

/**
 * Read every candidate that exists, normalize ONCE, hash the normalized
 * content — the identical string the write action emits — and sort by path so
 * the manifest, sums, and index are name-sorted regardless of discovery order.
 * Every read is fd-guarded ({@link readRegularFile}): most candidates were
 * DISCOVERED by a directory scan, and an exists-then-read pair on a scanned
 * path is the swap window where a symlink planted after enumeration gets its
 * target's bytes laundered into the audit trail.
 */
function discoverArtifacts(
  ctx: PlanContext,
  truthPack?: { contents: string; rel: ".aih/truth-pack.json" },
): DiscoveredArtifact[] {
  const found: DiscoveredArtifact[] = [];
  for (const candidate of candidates(ctx, truthPack)) {
    const buf =
      candidate.contents === undefined ? readRegularFile(join(ctx.root, candidate.rel)) : undefined;
    if (buf === undefined && candidate.contents === undefined) continue; // absent kind → silently not indexed
    const raw = candidate.contents ?? buf?.toString("utf8") ?? "";
    const contents = ensureTrailingNewline(raw);
    found.push({
      kind: candidate.kind,
      rel: toPosix(candidate.rel),
      contents,
      sha256: sha256Hex(contents),
      bytes: Buffer.byteLength(contents, "utf8"),
      schemaVersion: artifactSchemaVersion(raw),
    });
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Digest body: per-kind counts in the closed kind order, then the verify hint. */
function buildText(out: string, artifacts: readonly DiscoveredArtifact[]): string {
  const byKind = new Map<EvidenceKind, number>();
  for (const artifact of artifacts) {
    byKind.set(artifact.kind, (byKind.get(artifact.kind) ?? 0) + 1);
  }
  const bytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  return lines(
    `evidence bundle: ${artifacts.length} artifact(s) · ${bytes} bytes → ${out}`,
    ...EVIDENCE_KINDS.filter((kind) => byKind.has(kind)).map(
      (kind) => `- ${kind}  ${byKind.get(kind)} file(s)`,
    ),
    "",
    `re-check any copy with \`aih verify-bundle --bundle ${out}\` — the layout is bundle-standard`,
  );
}

function requireSignature(ctx: PlanContext): boolean {
  return ctx.posture === "enterprise" || ctx.options.requireSignature === true;
}

function missingSignatureCheck(out: string): Check {
  return {
    name: "evidence bundle signature",
    verdict: "fail",
    code: "bundle.signature",
    detail:
      `enterprise evidence requires --sign cosign|gh (or --require-signature was set); ` +
      `no signer was configured for ${out}`,
  };
}

function checksumLine(path: string, contents: string): string {
  return `${sha256Hex(contents)}  ${path}`;
}

function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}`;
}

function harnessBlock(ctx: PlanContext): EvidenceHarness {
  const version = VERSION;
  const tag = `v${version}`;
  const base = releaseUrl(version);
  const releaseCommit =
    typeof ctx.env.GITHUB_SHA === "string" && ctx.env.GITHUB_SHA.trim().length > 0
      ? ctx.env.GITHUB_SHA.trim()
      : `resolved by release tag ${tag}`;
  return {
    aihVersion: version,
    releaseTag: tag,
    releaseCommit,
    packageName: PACKAGE_NAME,
    tarballSha256: `${base}/SHA256SUMS.txt entry for aihq-harness-${version}.tgz`,
    checksumFile: `${base}/SHA256SUMS.txt`,
    cosignBundle: `${base}/SHA256SUMS.txt.sigstore.json`,
    npmProvenance: "not-checked",
    verificationCommand: `aih verify-release ${version}`,
  };
}

async function evidenceBuildPlan(ctx: PlanContext): Promise<Plan> {
  const out = optionString(ctx, "out") ?? DEFAULT_EVIDENCE_OUT;
  const external = isAbsolute(out);
  const truthPack = await truthPackEvidenceSource(ctx);
  const truthPackProbe =
    truthPack.checks.length > 0 ? probeMany("truth verify", () => truthPack.checks) : undefined;
  if (truthPack.checks.some((check) => check.verdict === "fail")) {
    return plan("evidence build", ...(truthPackProbe === undefined ? [] : [truthPackProbe]));
  }
  const artifacts = discoverArtifacts(ctx, truthPack.source);
  const strictSignature = requireSignature(ctx);

  const index: EvidenceBundle = {
    schemaVersion: 1,
    harness: harnessBlock(ctx),
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.rel,
      sha256: artifact.sha256,
      schemaVersion: artifact.schemaVersion,
    })),
  };
  const manifest = {
    schemaVersion: 1,
    files: artifacts.map((artifact) => ({
      path: artifact.rel,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
  };
  const manifestContents = jsonFile(manifest);
  const indexContents = jsonFile(index);
  const sums = `${[
    ...artifacts.map((a) => `${a.sha256}  files/${a.rel}`),
    checksumLine(MANIFEST_FILE, manifestContents),
    checksumLine(EVIDENCE_FILE, indexContents),
  ].join("\n")}\n`;

  const actions: Action[] = artifacts.map((artifact) =>
    writeText(
      bundlePath(out, "files", artifact.rel),
      artifact.contents,
      `evidence artifact: ${artifact.rel}`,
      { external },
    ),
  );
  actions.push(
    writeJson(bundlePath(out, MANIFEST_FILE), manifest, "evidence bundle manifest", { external }),
    writeText(bundlePath(out, CHECKSUMS_FILE), sums, "evidence bundle SHA256SUMS", { external }),
    writeJson(bundlePath(out, EVIDENCE_FILE), index, "evidence kind index", { external }),
  );
  const sign = signAction(out, ctx.options.sign, "evidence bundle", {
    allowFailure: !strictSignature,
    sumsSha256: sha256Hex(sums),
  });
  if (sign) actions.push(sign);
  if (strictSignature && sign === undefined) {
    actions.push(probe("evidence bundle signature", () => missingSignatureCheck(out)));
  }
  if (truthPackProbe !== undefined) actions.push(truthPackProbe);
  actions.push(
    digest("evidence build", buildText(out, artifacts), {
      out,
      counts: { artifacts: artifacts.length },
      artifacts: index.artifacts,
      harness: index.harness,
    }),
  );
  return plan("evidence build", ...actions);
}

export const evidenceBuildCommand: CommandSpec = {
  name: "build",
  summary:
    "Package the governance artifacts aih already emits (locks, cards, vet evidence, run logs, reports) into a verifiable evidence bundle",
  options: [
    {
      flags: "--out <dir>",
      description: "output directory for the evidence bundle",
      default: DEFAULT_EVIDENCE_OUT,
    },
    {
      flags: "--sign <signer>",
      description: "optional SHA256SUMS signer: cosign | gh",
    },
    {
      flags: "--require-signature",
      description: "fail when the evidence bundle cannot be signed (implied at enterprise posture)",
    },
  ],
  alwaysVerify: true,
  plan: evidenceBuildPlan,
};
