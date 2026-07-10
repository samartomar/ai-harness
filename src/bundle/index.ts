import { createHash } from "node:crypto";
import { type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { redactSecrets } from "../guardrails/redact.js";
import { readIfExists, readRegularFile } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  type ExecAction,
  exec,
  type PlanContext,
  plan,
  probe,
  writeJson,
  writeText,
} from "../internals/plan.js";
import type { Runner } from "../internals/proc.js";
import { jsonFile } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import { AIH_PACKS_FILE } from "../pack/manifest.js";
import { skillCardsDir } from "../skill/card.js";
import { AIH_SKILLS_LOCK_FILE } from "../skill/lockfile.js";

const DEFAULT_OUT = ".aih/fleet-bundle";
const CHECKSUMS_FILE = "SHA256SUMS";
const SIGNATURE_FILE = "SHA256SUMS.sig";
const MANIFEST_FILE = "manifest.json";
const EVIDENCE_FILE = "evidence.json";

interface BundleFile {
  path: string;
  contents: string;
  bytes: number;
  sha256: string;
}

interface BundleManifest {
  schemaVersion: 1;
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
}

interface BundleMetadataFile {
  path: string;
  contents: string;
  bytes: number;
  sha256: string;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function bundleOut(ctx: PlanContext): string {
  const raw =
    typeof ctx.options.out === "string" && ctx.options.out.length > 0
      ? ctx.options.out
      : DEFAULT_OUT;
  return raw;
}

function verifyBundleRoot(ctx: PlanContext): string {
  const raw =
    typeof ctx.options.bundle === "string" && ctx.options.bundle.length > 0
      ? ctx.options.bundle
      : DEFAULT_OUT;
  return isAbsolute(raw) ? raw : join(ctx.root, raw);
}

function bundlePath(out: string, ...parts: string[]): string {
  return posix.join(posixPath(out), ...parts.map(posixPath));
}

function writeExternal(out: string): boolean {
  return isAbsolute(out);
}

function defaultBundlePaths(ctx: PlanContext): string[] {
  return [
    posix.join(ctx.contextDir, "project.json"),
    "aih-org-policy.json",
    AIH_SKILLS_LOCK_FILE,
    AIH_PACKS_FILE,
    // A directory candidate: readBundleFiles expands it one level (see expandDir).
    skillCardsDir(ctx.contextDir),
    ".claude/managed-settings.json",
    "managed-settings.json.example",
    "managed-mcp.json.example",
    ".mcp.json",
    ".gitleaks.toml",
    ".pre-commit-config.yaml",
    ".github/workflows/sca.yml",
  ];
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => posixPath(item.trim()))
    .filter((item) => item.length > 0);
}

function candidatePaths(ctx: PlanContext): string[] {
  return [...new Set([...defaultBundlePaths(ctx), ...splitCsv(ctx.options.include)])].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * Expand a candidate that names an existing DIRECTORY (the skill-cards dir)
 * into its regular files, one level deep, name-sorted — the per-file read
 * below only reads files, so an unexpanded directory candidate would silently
 * vanish.
 * Fail-closed on hostile entry names: a separator or `..` inside a directory
 * ENTRY can only mean a hostile filesystem, so the entry is refused rather
 * than composed into a path. Symlinked entries are skipped (`isFile()` is
 * false for a Dirent symlink); anything that is not an existing directory
 * passes through unchanged for the plain-file read below.
 */
function expandDir(root: string, rel: string): string[] {
  let entries: Dirent[];
  try {
    if (!statSync(join(root, rel)).isDirectory()) return [rel];
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return [rel]; // absent → the per-file read below skips it, exactly as before
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes(".."),
    )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => posix.join(rel, name));
}

function readBundleFiles(ctx: PlanContext): BundleFile[] {
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  for (const rel of candidatePaths(ctx)) {
    if (isAbsolute(rel) || rel.split("/").includes("..")) continue;
    for (const fileRel of expandDir(ctx.root, rel)) {
      if (seen.has(fileRel)) continue; // an --include may repeat an expanded entry
      seen.add(fileRel);
      // fd-guarded: expanded entries were discovered by a directory scan, so a
      // plain exists-then-read here would be a symlink-swap window (the bundle
      // packages what it reads).
      const buf = readRegularFile(join(ctx.root, fileRel));
      if (buf === undefined) continue;
      const contents = buf.toString("utf8");
      files.push({
        path: fileRel,
        contents,
        bytes: Buffer.byteLength(contents, "utf8"),
        sha256: sha256Hex(contents),
      });
    }
  }
  return files;
}

function manifest(files: BundleFile[]): BundleManifest {
  return {
    schemaVersion: 1,
    files: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
}

function metadataFile(path: string, contents: string): BundleMetadataFile {
  return {
    path,
    contents,
    bytes: Buffer.byteLength(contents, "utf8"),
    sha256: sha256Hex(contents),
  };
}

function sha256Sums(files: BundleFile[], metadata: BundleMetadataFile[] = []): string {
  return `${[
    ...files.map((file) => `${file.sha256}  files/${file.path}`),
    ...metadata.map((file) => `${file.sha256}  ${file.path}`),
  ].join("\n")}\n`;
}

function ghAttestationSignUnavailable(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("unknown command") &&
    lower.includes("attestation") &&
    (lower.includes("sign") || lower.includes('unknown command "attestation"'))
  );
}

function sanitizeSignerOutput(text: string): string {
  return redactSecrets(
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: signer output is external text; strip terminal/control bytes before report serialization.
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 800);
}

export function signatureFailureCheck(
  what: string,
  tool: string,
): NonNullable<ExecAction["failureCheck"]> {
  return (result) => {
    const raw =
      sanitizeSignerOutput(result.stderr || result.stdout || `${tool} exited ${result.code}`) ||
      `${tool} did not produce a verifiable signature`;
    const detail =
      tool === "gh attestation sign" && ghAttestationSignUnavailable(raw)
        ? `local GitHub CLI does not expose \`gh attestation sign\`; use release CI/GitHub Actions OIDC for GitHub attestation signing, or use cosign for local signing. Raw error: ${raw}`
        : raw;
    return {
      name: `${what} signature`,
      verdict: "fail",
      code: "bundle.signature",
      detail,
    };
  };
}

/**
 * SHA256SUMS signing. Best-effort by default (`allowFailure: true` — the
 * fleet-bundle idiom), with a strict mode for enterprise evidence gates. Shared
 * with `aih evidence build`, which emits the same bundle-standard layout.
 */
export function signAction(
  out: string,
  signer: unknown,
  what = "fleet bundle",
  opts: { allowFailure?: boolean; sumsSha256?: string } = {},
): Action | undefined {
  const sums = bundlePath(out, CHECKSUMS_FILE);
  const sig = bundlePath(out, SIGNATURE_FILE);
  const allowFailure = opts.allowFailure ?? true;
  const expect =
    opts.sumsSha256 === undefined ? undefined : { path: sums, sha256: opts.sumsSha256 };
  if (signer === "cosign") {
    return exec(
      `sign ${what} checksums with cosign`,
      ["cosign", "sign-blob", "--yes", "--output-signature", sig, sums],
      {
        allowFailure,
        failureCheck: signatureFailureCheck(what, "cosign"),
        expect,
      },
    );
  }
  if (signer === "gh") {
    return exec(
      `sign ${what} checksums with GitHub attestations`,
      ["gh", "attestation", "sign", sums],
      {
        allowFailure,
        failureCheck: signatureFailureCheck(what, "gh attestation sign"),
        expect,
      },
    );
  }
  return undefined;
}

function bundlePlan(ctx: PlanContext) {
  const out = bundleOut(ctx);
  const external = writeExternal(out);
  const files = readBundleFiles(ctx);
  const bundleManifest = manifest(files);
  const manifestContents = jsonFile(bundleManifest);
  const sums = sha256Sums(files, [metadataFile(MANIFEST_FILE, manifestContents)]);
  const actions: Action[] = files.map((file) =>
    writeText(bundlePath(out, "files", file.path), file.contents, `bundle artifact: ${file.path}`, {
      external,
    }),
  );
  actions.push(
    writeJson(bundlePath(out, MANIFEST_FILE), bundleManifest, "fleet bundle manifest", {
      external,
    }),
    writeText(bundlePath(out, CHECKSUMS_FILE), sums, "fleet bundle SHA256SUMS", {
      external,
    }),
  );
  const sign = signAction(out, ctx.options.sign, "fleet bundle", { sumsSha256: sha256Hex(sums) });
  if (sign) actions.push(sign);
  return plan("bundle", ...actions);
}

function parseChecksum(line: string): { hash: string; path: string } | undefined {
  const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { hash: match[1].toLowerCase(), path: posixPath(match[2]) };
}

function safeBundleFile(bundleRoot: string, rel: string): string | undefined {
  if (isAbsolute(rel) || rel.split("/").includes("..")) return undefined;
  const root = resolve(bundleRoot);
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return undefined;
  }
  try {
    const parentReal = realpathSync(dirname(target));
    const relToParent = relative(rootReal, parentReal);
    if (relToParent !== "" && (relToParent.startsWith("..") || isAbsolute(relToParent))) {
      return undefined;
    }
  } catch {
    // Missing parents are reported by the later regular-file read as missing.
  }
  return target;
}

function readBundleText(bundleRoot: string, rel: string): { text?: string; escaped: boolean } {
  const target = safeBundleFile(bundleRoot, rel);
  if (target === undefined) return { escaped: true };
  const contents = readRegularFile(target);
  return contents === undefined
    ? { escaped: false }
    : { text: contents.toString("utf8"), escaped: false };
}

function safeManifestPath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (path !== posixPath(path) || isAbsolute(path) || path.split("/").includes("..")) {
    return undefined;
  }
  return path;
}

function parseBundleManifest(raw: string): { manifest?: BundleManifest; failures: string[] } {
  const failures: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { failures: [`${MANIFEST_FILE} is not valid JSON`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { failures: [`${MANIFEST_FILE} is not an object`] };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) failures.push(`${MANIFEST_FILE} schemaVersion must be 1`);
  if (!Array.isArray(record.files)) failures.push(`${MANIFEST_FILE} files must be an array`);
  const files: BundleManifest["files"] = [];
  const seen = new Set<string>();
  for (const [index, item] of Array.isArray(record.files) ? record.files.entries() : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      failures.push(`${MANIFEST_FILE} files[${index}] is not an object`);
      continue;
    }
    const file = item as Record<string, unknown>;
    const path = safeManifestPath(file.path);
    if (path === undefined) {
      failures.push(`${MANIFEST_FILE} files[${index}].path is invalid`);
      continue;
    }
    if (seen.has(path)) failures.push(`${MANIFEST_FILE} duplicates ${path}`);
    seen.add(path);
    const bytes = file.bytes;
    const sha256 = file.sha256;
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      failures.push(`${MANIFEST_FILE} ${path} has invalid byte count`);
      continue;
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      failures.push(`${MANIFEST_FILE} ${path} has invalid sha256`);
      continue;
    }
    files.push({ path, bytes, sha256 });
  }
  return failures.length > 0 ? { failures } : { manifest: { schemaVersion: 1, files }, failures };
}

function evidenceIndexFailures(raw: string, manifest: BundleManifest): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [`${EVIDENCE_FILE} is not valid JSON`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [`${EVIDENCE_FILE} is not an object`];
  }
  const artifacts = (parsed as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return [`${EVIDENCE_FILE} artifacts must be an array`];
  const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const [index, item] of artifacts.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      failures.push(`${EVIDENCE_FILE} artifacts[${index}] is not an object`);
      continue;
    }
    const artifact = item as Record<string, unknown>;
    const path = safeManifestPath(artifact.path);
    const sha256 = artifact.sha256;
    if (path === undefined || typeof sha256 !== "string") {
      failures.push(`${EVIDENCE_FILE} artifacts[${index}] has invalid path or sha256`);
      continue;
    }
    seen.add(path);
    if (expected.get(path) !== sha256)
      failures.push(`${EVIDENCE_FILE} ${path} mismatches manifest`);
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) failures.push(`${EVIDENCE_FILE} missing ${path}`);
  }
  for (const path of seen) {
    if (!expected.has(path)) failures.push(`${EVIDENCE_FILE} has unexpected ${path}`);
  }
  return failures;
}

export function verifyBundleChecksums(bundleRoot: string): Check {
  const raw = readBundleText(bundleRoot, CHECKSUMS_FILE);
  if (raw.text === undefined) {
    return {
      name: "fleet bundle checksums",
      verdict: "fail",
      detail: `${CHECKSUMS_FILE} is missing`,
    };
  }
  const failures: string[] = [];
  const entries = new Map<string, string>();
  for (const line of raw.text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseChecksum(line);
    if (parsed === undefined) {
      failures.push(`malformed line: ${line}`);
      continue;
    }
    if (entries.has(parsed.path)) failures.push(`${parsed.path} has duplicate checksum entries`);
    entries.set(parsed.path, parsed.hash);
  }
  if (entries.size === 0) failures.push(`${CHECKSUMS_FILE} has no entries`);

  const manifestRead = readBundleText(bundleRoot, MANIFEST_FILE);
  if (manifestRead.escaped) failures.push(`${MANIFEST_FILE} escapes bundle root`);
  if (manifestRead.text === undefined) failures.push(`${MANIFEST_FILE} is missing`);
  const parsedManifest =
    manifestRead.text === undefined ? { failures: [] } : parseBundleManifest(manifestRead.text);
  failures.push(...parsedManifest.failures);
  const expected = new Map<string, { sha256: string; bytes?: number }>();
  if (parsedManifest.manifest !== undefined) {
    for (const file of parsedManifest.manifest.files) {
      expected.set(`files/${file.path}`, { sha256: file.sha256, bytes: file.bytes });
    }
    expected.set(MANIFEST_FILE, { sha256: sha256Hex(manifestRead.text ?? "") });
  }
  const evidenceRead = readBundleText(bundleRoot, EVIDENCE_FILE);
  if (evidenceRead.escaped) failures.push(`${EVIDENCE_FILE} escapes bundle root`);
  if (evidenceRead.text !== undefined) {
    expected.set(EVIDENCE_FILE, { sha256: sha256Hex(evidenceRead.text) });
    if (parsedManifest.manifest !== undefined) {
      failures.push(...evidenceIndexFailures(evidenceRead.text, parsedManifest.manifest));
    }
  }
  for (const path of entries.keys()) {
    if (!expected.has(path)) failures.push(`${path} is not listed in ${MANIFEST_FILE}`);
  }
  for (const path of expected.keys()) {
    if (!entries.has(path)) failures.push(`${path} missing from ${CHECKSUMS_FILE}`);
  }

  for (const [path, expectedFile] of expected.entries()) {
    const listedHash = entries.get(path);
    if (listedHash === undefined) continue;
    if (listedHash !== expectedFile.sha256) {
      failures.push(`${path} checksum entry does not match ${MANIFEST_FILE}`);
    }
    const target = readBundleText(bundleRoot, path);
    if (target.escaped) {
      failures.push(`${path} escapes bundle root`);
      continue;
    }
    if (target.text === undefined) {
      failures.push(`${path} missing or not a regular file`);
      continue;
    }
    const actual = sha256Hex(target.text);
    if (actual !== listedHash) failures.push(`${path} expected ${listedHash}, got ${actual}`);
    if (
      expectedFile.bytes !== undefined &&
      Buffer.byteLength(target.text, "utf8") !== expectedFile.bytes
    ) {
      failures.push(`${path} byte count does not match ${MANIFEST_FILE}`);
    }
  }
  if (failures.length > 0) {
    return { name: "fleet bundle checksums", verdict: "fail", detail: failures.join("; ") };
  }
  return { name: "fleet bundle checksums", verdict: "pass", detail: "all checksums match" };
}

function requireSignature(ctx: PlanContext): boolean {
  return ctx.options.requireSignature === true;
}

function signatureCheck(verdict: Check["verdict"], detail: string, require: boolean): Check {
  return {
    name: "fleet bundle signature",
    verdict,
    detail,
    ...(verdict !== "pass" && require ? { code: "bundle.signature" as const } : {}),
  };
}

export async function verifyGithubBundleAttestation(
  bundleRoot: string,
  repo: string,
  run: Runner,
): Promise<Check> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return signatureCheck(
      "fail",
      "gh attestation verification requires an exact owner/repo identity",
      true,
    );
  }
  const sums = join(bundleRoot, CHECKSUMS_FILE);
  const res = await run(["gh", "attestation", "verify", sums, "--repo", repo]);
  if (res.spawnError) return signatureCheck("fail", "gh not found", true);
  if (res.code === 0) {
    return signatureCheck("pass", `GitHub attestation verified SHA256SUMS for ${repo}`, true);
  }
  const detail =
    sanitizeSignerOutput(res.stderr || res.stdout || `gh attestation verify exited ${res.code}`) ||
    `gh attestation verify exited ${res.code}`;
  return signatureCheck("fail", detail, true);
}

async function verifyBundleSignature(ctx: PlanContext, bundleRoot: string): Promise<Check> {
  const sums = join(bundleRoot, CHECKSUMS_FILE);
  const strict = requireSignature(ctx);
  if (ctx.options.signer === "gh") {
    const repo = typeof ctx.options.repo === "string" ? ctx.options.repo.trim() : "";
    if (repo.length === 0) {
      return signatureCheck(
        strict ? "fail" : "skip",
        "gh attestation verification requires --repo <owner/repo>",
        strict,
      );
    }
    return verifyGithubBundleAttestation(bundleRoot, repo, ctx.run);
  }

  const sig = join(bundleRoot, SIGNATURE_FILE);
  if (readIfExists(sig) === undefined) {
    return signatureCheck(strict ? "fail" : "skip", `${SIGNATURE_FILE} missing`, strict);
  }
  const res = await ctx.run(["cosign", "verify-blob", "--signature", sig, sums]);
  if (res.spawnError) {
    return signatureCheck(strict ? "fail" : "skip", "cosign not found", strict);
  }
  if (res.code === 0) {
    return signatureCheck("pass", "cosign verified SHA256SUMS", strict);
  }
  return signatureCheck("fail", res.stderr.trim() || `cosign exited ${res.code}`, strict);
}

function verifyPlan(ctx: PlanContext) {
  const root = verifyBundleRoot(ctx);
  return plan(
    "verify-bundle",
    probe("fleet bundle checksums", () => verifyBundleChecksums(root)),
    probe("fleet bundle signature", (c) => verifyBundleSignature(c, root)),
  );
}

export const command: CommandSpec = {
  name: "bundle",
  summary: "Build a deterministic fleet bundle (contract, org policy, managed config, checksums)",
  options: [
    {
      flags: "--out <dir>",
      description: "output directory for the fleet bundle",
      default: DEFAULT_OUT,
    },
    {
      flags: "--include <paths>",
      description: "comma-separated additional repo-relative files to include",
    },
    {
      flags: "--sign <signer>",
      description: "optional signer: cosign | gh",
    },
  ],
  plan: bundlePlan,
};

export const verifyCommand: CommandSpec = {
  name: "verify-bundle",
  summary: "Verify a fleet bundle's SHA256SUMS and optional cosign signature",
  readOnly: true,
  options: [
    {
      flags: "--bundle <dir>",
      description: "bundle directory to verify",
      default: DEFAULT_OUT,
    },
    {
      flags: "--signer <signer>",
      description: "signature verifier: cosign | gh (default: cosign when SHA256SUMS.sig exists)",
    },
    {
      flags: "--repo <owner/repo>",
      description: "GitHub repository identity for --signer gh attestation verification",
    },
    {
      flags: "--require-signature",
      description:
        "fail instead of skip when bundle signature/provenance is missing or unverifiable",
    },
  ],
  plan: verifyPlan,
};
