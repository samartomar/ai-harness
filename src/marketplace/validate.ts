import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Hex } from "../bundle/index.js";
import { readRegularFile } from "../internals/fsxn.js";
import { type CommandSpec, type Plan, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  AIH_MARKETPLACE_FILE,
  DEFAULT_MARKETPLACE_OUT,
  type MarketplaceManifest,
  MarketplaceManifestSchema,
  marketplaceRelPathSchema,
} from "./manifest.js";

/**
 * `aih marketplace validate` — the READ-ONLY integrity gate over a marketplace
 * artifact (locally built, or a fetched copy of a hosted one). It is the
 * marketplace's analog of `pack validate`: pure fs at plan time (#35), one
 * coded fail Check per finding, pass checks on the green path, and the exit
 * code rides the standard VerificationReport. Order of defenses matters —
 * every path read out of the manifest or SHA256SUMS is containment-checked
 * BEFORE any filesystem access uses it, so a hostile artifact cannot steer the
 * validator's reads outside its own directory.
 *
 * Slice 2 adds the PROVENANCE probe: `marketplace publish` signs `SHA256SUMS`
 * (cosign detached sig, or a GitHub attestation), and the signature probe here
 * verifies it under the verify phase via ctx.run — mirroring the fleet bundle's
 * `verifyBundleSignature`. Without `--require-signature` an unverifiable
 * signature (no sig file, tool absent, no `--repo` for gh, no identity material
 * for cosign) is a tolerated `skip` for local use; with it, every one of those
 * skips becomes a coded `marketplace.signature` FAIL — the CI gate mode. A
 * signature that EXISTS but fails verification is tampering evidence and fails
 * in BOTH modes.
 */

const CHECKSUMS_FILE = "SHA256SUMS";
const SIGNATURE_FILE = "SHA256SUMS.sig";

interface MarketplaceReport {
  findings: Check[];
  passes: Check[];
}

function marketplaceDir(ctx: PlanContext): string {
  const raw = ctx.options.dir;
  const dir =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_MARKETPLACE_OUT;
  // resolve() mirrors publish's marketplaceDir: a normalized absolute root means
  // the sums/sig paths composed from it can never start with `-` or carry `..`.
  return resolve(isAbsolute(dir) ? dir : join(ctx.root, dir));
}

/** The artifact-relative label used in check details/locations. */
function relLabel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/**
 * Path safety for a string read out of the artifact: the schema's segment rules
 * (no `..`, no absolute/drive, no backslash, no control chars) PLUS a resolved
 * containment check against the artifact root — mirrors `safeBundleFile`.
 * Returns the resolved absolute path only when safe; `undefined` is a
 * `marketplace.path-traversal` finding for the caller.
 */
function safeArtifactFile(dir: string, rel: string): string | undefined {
  if (!marketplaceRelPathSchema.safeParse(rel).success) return undefined;
  const root = resolve(dir);
  const target = resolve(root, rel);
  const contained = relative(root, target);
  if (contained.length === 0 || contained.startsWith("..") || isAbsolute(contained)) {
    return undefined;
  }
  return target;
}

function traversalFinding(rel: string, where: string): Check {
  return {
    name: "marketplace path traversal",
    verdict: "fail",
    code: "marketplace.path-traversal",
    detail: `${where} references an unsafe path: ${rel} (traversal/absolute/backslash — refusing to touch the filesystem with it)`,
    location: { uri: where },
    fingerprint: `marketplace-path-traversal:${rel}`,
  };
}

function missingFinding(rel: string, where: string): Check {
  return {
    name: "marketplace missing file",
    verdict: "fail",
    code: "marketplace.missing-file",
    detail: `${where} references ${rel}, which does not exist in the artifact`,
    location: { uri: relLabel(rel) },
    fingerprint: `marketplace-missing-file:${rel}`,
  };
}

function unsafeArtifactFinding(rel: string, where: string, reason: string): Check {
  return {
    name: "marketplace path traversal",
    verdict: "fail",
    code: "marketplace.path-traversal",
    detail: `${where} references ${rel}, but ${reason} — refusing to read it as marketplace artifact content`,
    location: { uri: relLabel(rel) },
    fingerprint: `marketplace-unsafe-file:${rel}:${reason}`,
  };
}

function mismatchFinding(rel: string, expected: string, actual: string, where: string): Check {
  return {
    name: "marketplace checksum mismatch",
    verdict: "fail",
    code: "marketplace.checksum-mismatch",
    detail: `${rel} hashes to ${actual.slice(0, 12)}…, but ${where} records ${expected.slice(0, 12)}…`,
    location: { uri: relLabel(rel) },
    fingerprint: `marketplace-checksum-mismatch:${rel}:${actual.slice(0, 8)}`,
  };
}

/**
 * Collect every path-like string from the RAW manifest JSON (lenient parse) —
 * independent of schema validation, so a manifest that fails the schema still
 * gets its embedded paths traversal-checked, and a `..` smuggled into an
 * otherwise-valid manifest surfaces as the precise `path-traversal` code
 * rather than only a generic parse failure.
 */
function rawManifestPaths(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: string[] = [];
  const skills = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return out;
  for (const skill of skills) {
    if (typeof skill !== "object" || skill === null) continue;
    const s = skill as { card?: unknown; evidence?: unknown; files?: unknown };
    if (typeof s.card === "string") out.push(s.card);
    if (typeof s.evidence === "string") out.push(s.evidence);
    if (!Array.isArray(s.files)) continue;
    for (const file of s.files) {
      const path = (file as { path?: unknown } | null)?.path;
      if (typeof path === "string") out.push(path);
    }
  }
  return out;
}

/** Raw-JSON probe for a verdict outside GREEN|YELLOW (schema-independent). */
function rawVerdictFindings(raw: string): Check[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const skills = (parsed as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  const findings: Check[] = [];
  skills.forEach((skill, index) => {
    const s = skill as { name?: unknown; verdict?: unknown } | null;
    const verdict = s?.verdict;
    if (verdict === "GREEN" || verdict === "YELLOW") return;
    const label = typeof s?.name === "string" ? s.name : `skills[${index}]`;
    findings.push({
      name: "marketplace unapproved verdict",
      verdict: "fail",
      code: "marketplace.unapproved-verdict",
      detail: `${label} carries verdict ${JSON.stringify(verdict ?? null)} — only GREEN/YELLOW skills are distributable`,
      location: { uri: AIH_MARKETPLACE_FILE },
      fingerprint: `marketplace-unapproved-verdict:${label}`,
    });
  });
  return findings;
}

/** Parse one `SHA256SUMS` line — bundle's exact format (`<hex64>  <path>`). */
function parseChecksum(line: string): { hash: string; path: string } | undefined {
  const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { hash: match[1].toLowerCase(), path: match[2].replace(/\\/g, "/") };
}

type ArtifactTextRead = { ok: true; contents: string } | { ok: false; finding: Check };

function readArtifactText(dir: string, rel: string, where: string): ArtifactTextRead {
  const target = safeArtifactFile(dir, rel);
  if (target === undefined) return { ok: false, finding: traversalFinding(rel, where) };
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) {
      return { ok: false, finding: unsafeArtifactFinding(rel, where, "it is a symlink") };
    }
    if (!stats.isFile()) {
      return { ok: false, finding: unsafeArtifactFinding(rel, where, "it is not a regular file") };
    }
    const rootReal = realpathSync(dir);
    const targetReal = realpathSync(target);
    const contained = relative(rootReal, targetReal);
    if (contained.length === 0 || contained.startsWith("..") || isAbsolute(contained)) {
      return {
        ok: false,
        finding: unsafeArtifactFinding(rel, where, "its real path escapes the artifact root"),
      };
    }
    const contents = readRegularFile(target);
    if (contents === undefined) {
      return {
        ok: false,
        finding: unsafeArtifactFinding(rel, where, "it is not readable as a regular file"),
      };
    }
    return { ok: true, contents: contents.toString("utf8") };
  } catch {
    return { ok: false, finding: missingFinding(rel, where) };
  }
}

type MarketplaceManifestRead =
  | { ok: true; manifest: MarketplaceManifest; raw: string }
  | { ok: false; reason: string; raw?: string; finding?: Check };

function readManifest(dir: string): MarketplaceManifestRead {
  const read = readArtifactText(dir, AIH_MARKETPLACE_FILE, AIH_MARKETPLACE_FILE);
  if (!read.ok) {
    if (read.finding.code === "marketplace.missing-file") {
      return { ok: false, reason: `${AIH_MARKETPLACE_FILE} is missing`, finding: read.finding };
    }
    return {
      ok: false,
      reason: read.finding.detail ?? `${AIH_MARKETPLACE_FILE} is not readable`,
      finding: read.finding,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.contents);
  } catch {
    return { ok: false, reason: `${AIH_MARKETPLACE_FILE} is not valid JSON`, raw: read.contents };
  }
  const result = MarketplaceManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : `: ${issue.path.join(".") || "(root)"} — ${issue.message}`;
    return {
      ok: false,
      reason: `${AIH_MARKETPLACE_FILE} failed schema validation${where}`,
      raw: read.contents,
    };
  }
  return { ok: true, manifest: result.data, raw: read.contents };
}

interface ArtifactTree {
  files: string[];
  findings: Check[];
}

/** Every regular file under `dir` (artifact-relative, POSIX, sorted); symlinks fail closed. */
function collectArtifactTree(dir: string): ArtifactTree {
  const files: string[] = [];
  const findings: Check[] = [];
  const root = resolve(dir);
  const visit = (abs: string): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    const rel = relative(root, abs).replace(/\\/g, "/") || ".";
    if (st.isSymbolicLink()) {
      findings.push(unsafeArtifactFinding(rel, CHECKSUMS_FILE, "it is a symlink"));
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile()) {
      files.push(rel);
      return;
    }
    findings.push(unsafeArtifactFinding(rel, CHECKSUMS_FILE, "it is not a regular file"));
  };
  visit(root);
  return { files: files.sort((a, b) => a.localeCompare(b)), findings };
}

/**
 * Grade the manifest's own references: card + evidence must exist; every
 * `files[]` entry must exist AND hash to its recorded sha256. Paths are safety-
 * checked before any read (unsafe → traversal finding, no fs access).
 */
function manifestFindings(dir: string): Check[] {
  const read = readManifest(dir);
  if (!read.ok) {
    const parseFinding: Check = {
      name: "marketplace manifest",
      verdict: "fail",
      code: "marketplace.manifest-parse",
      detail: read.reason,
      location: { uri: AIH_MARKETPLACE_FILE },
      fingerprint: "marketplace-manifest-parse",
    };
    return read.finding === undefined
      ? [parseFinding]
      : [
          read.finding,
          {
            ...parseFinding,
            fingerprint: `${parseFinding.fingerprint}:${read.finding.fingerprint ?? "read"}`,
          },
        ];
  }
  const findings: Check[] = [];
  for (const skill of read.manifest.skills) {
    for (const rel of [skill.card, skill.evidence]) {
      const readRef = readArtifactText(dir, rel, AIH_MARKETPLACE_FILE);
      if (!readRef.ok) findings.push(readRef.finding);
    }
    for (const file of skill.files) {
      const readFile = readArtifactText(dir, file.path, AIH_MARKETPLACE_FILE);
      if (!readFile.ok) {
        findings.push(readFile.finding);
        continue;
      }
      const actual = sha256Hex(readFile.contents);
      if (actual !== file.sha256) {
        findings.push(mismatchFinding(file.path, file.sha256, actual, AIH_MARKETPLACE_FILE));
      }
    }
  }
  return findings;
}

/**
 * Grade `SHA256SUMS`: every line must parse, stay contained, exist, and hash
 * true — and the sums must cover the WHOLE tree (a file on disk that no line
 * attests is exactly the smuggled-payload case `sums-coverage` exists for; the
 * inverse direction — a line whose file is gone — is a `missing-file`). Beyond
 * coverage, the sums must attest ONLY what the manifest DECLARES: appending a
 * payload plus its correct hash line keeps coverage green, so every on-disk
 * artifact file must also appear in the manifest's declared set (the manifest
 * itself, each skill's card/evidence, and every `files[]` path).
 */
function sumsFindings(dir: string): Check[] {
  const raw = readArtifactText(dir, CHECKSUMS_FILE, CHECKSUMS_FILE);
  if (!raw.ok) {
    return raw.finding.code === "marketplace.missing-file"
      ? [
          {
            name: "marketplace sums coverage",
            verdict: "fail",
            code: "marketplace.sums-coverage",
            detail: `${CHECKSUMS_FILE} is missing — nothing attests the artifact tree`,
            location: { uri: CHECKSUMS_FILE },
            fingerprint: "marketplace-sums-missing",
          },
        ]
      : [raw.finding];
  }
  const findings: Check[] = [];
  const covered = new Set<string>();
  for (const line of raw.contents.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseChecksum(line);
    if (parsed === undefined) {
      findings.push({
        name: "marketplace checksum mismatch",
        verdict: "fail",
        code: "marketplace.checksum-mismatch",
        detail: `${CHECKSUMS_FILE} contains a malformed line: ${line.trim()}`,
        location: { uri: CHECKSUMS_FILE },
        fingerprint: `marketplace-sums-malformed:${line.trim().slice(0, 40)}`,
      });
      continue;
    }
    covered.add(parsed.path);
    const readFile = readArtifactText(dir, parsed.path, CHECKSUMS_FILE);
    if (!readFile.ok) {
      findings.push(readFile.finding);
      continue;
    }
    const actual = sha256Hex(readFile.contents);
    if (actual !== parsed.hash) {
      findings.push(mismatchFinding(parsed.path, parsed.hash, actual, CHECKSUMS_FILE));
    }
  }
  // The DECLARED set: everything the manifest says ships — the manifest file
  // itself plus each skill's card, evidence, and files[] paths. Computable only
  // when the manifest parses; when it does not, `manifest-parse` already fails
  // the report, so the declared check is skipped rather than double-reported.
  const manifest = readManifest(dir);
  const declared = manifest.ok
    ? new Set<string>([
        AIH_MARKETPLACE_FILE,
        ...manifest.manifest.skills.flatMap((skill) => [
          skill.card,
          skill.evidence,
          ...skill.files.map((file) => file.path),
        ]),
      ])
    : undefined;
  const tree = collectArtifactTree(dir);
  findings.push(...tree.findings);
  for (const rel of tree.files) {
    // The detached signature is signed OVER the sums, so the sums cannot attest
    // it — like SHA256SUMS itself, it is exempt from coverage; the signature
    // probe (not the coverage sweep) is what holds it to account.
    if (rel === CHECKSUMS_FILE || rel === SIGNATURE_FILE) continue;
    if (!covered.has(rel)) {
      findings.push({
        name: "marketplace sums coverage",
        verdict: "fail",
        code: "marketplace.sums-coverage",
        detail: `${rel} exists in the artifact but ${CHECKSUMS_FILE} does not cover it`,
        location: { uri: relLabel(rel) },
        fingerprint: `marketplace-sums-coverage:${rel}`,
      });
    }
    // Sums may attest ONLY what the manifest declares: a correctly-hashed line
    // over an undeclared file keeps the coverage sweep green, which is exactly
    // how a payload would ride an attested artifact — the manifest is the
    // declaration authority, so undeclared-on-disk is its own finding.
    if (declared !== undefined && !declared.has(rel)) {
      findings.push({
        name: "marketplace sums coverage",
        verdict: "fail",
        code: "marketplace.sums-coverage",
        detail: `${rel} exists in the artifact but ${AIH_MARKETPLACE_FILE} does not declare it — an undeclared payload cannot ride an attested artifact`,
        location: { uri: relLabel(rel) },
        fingerprint: `marketplace-undeclared:${rel}`,
      });
    }
  }
  return findings;
}

/** The pure join over one artifact directory: coded findings, or green passes. */
export function marketplaceReport(dir: string): MarketplaceReport {
  const manifestRead = readManifest(dir);
  const rawManifest = manifestRead.raw;
  const findings: Check[] = [];

  // Raw-string defenses FIRST (schema-independent): traversal + verdict probes
  // run even over a manifest the schema rejects, so the precise code surfaces.
  if (rawManifest !== undefined) {
    for (const rel of rawManifestPaths(rawManifest)) {
      if (safeArtifactFile(dir, rel) === undefined) {
        findings.push(traversalFinding(rel, AIH_MARKETPLACE_FILE));
      }
    }
    findings.push(...rawVerdictFindings(rawManifest));
  }

  // Schema-validated manifest grading (parse failure is itself a finding), then
  // the SHA256SUMS integrity + coverage sweep. Traversal findings from the raw
  // pass above are deduped by fingerprint (the schema pass re-detects them).
  findings.push(...manifestFindings(dir));
  if (existsSync(dir)) {
    findings.push(...sumsFindings(dir));
  } else {
    findings.push({
      name: "marketplace sums coverage",
      verdict: "fail",
      code: "marketplace.sums-coverage",
      detail: `artifact directory does not exist: ${dir}`,
      location: { uri: CHECKSUMS_FILE },
      fingerprint: "marketplace-sums-missing",
    });
  }

  const deduped = [
    ...new Map(findings.map((f) => [f.fingerprint ?? f.detail ?? f.name, f])).values(),
  ];
  if (deduped.length > 0) return { findings: deduped, passes: [] };

  const skills = manifestRead.ok ? manifestRead.manifest.skills.length : 0;
  // Attested payload count: everything except the sums and their detached
  // signature (neither can be covered by the sums themselves).
  const attested = collectArtifactTree(dir).files.filter(
    (rel) => rel !== CHECKSUMS_FILE && rel !== SIGNATURE_FILE,
  ).length;
  return {
    findings: [],
    passes: [
      {
        name: "marketplace manifest valid",
        verdict: "pass",
        detail: `${AIH_MARKETPLACE_FILE} parses · ${skills} skill(s) · verdicts all GREEN/YELLOW`,
      },
      {
        name: "marketplace checksums verified",
        verdict: "pass",
        detail: `${attested} file(s) match ${CHECKSUMS_FILE} and the manifest hashes`,
      },
      {
        name: "marketplace coverage complete",
        verdict: "pass",
        detail: `every artifact file is covered by ${CHECKSUMS_FILE}`,
      },
    ],
  };
}

/**
 * Grade the publisher signature over `SHA256SUMS`, mirroring the fleet bundle's
 * `verifyBundleSignature`: cosign verifies the detached `SHA256SUMS.sig`
 * against an explicit verifier IDENTITY, gh verifies the GitHub attestation
 * (which needs `--repo`, optionally narrowed by `--signer-workflow`). Runs via
 * ctx.run under the VERIFY phase only — never at plan time (#35). Signer
 * resolution precedence: a valid explicit `--signer` wins; else an explicit
 * `--repo` means gh (it must beat a stale leftover `.sig` from an earlier
 * cosign publish); else a detached sig on disk means cosign; else there is
 * nothing to verify.
 *
 * Verdict ladder: exit 0 → pass. An UNVERIFIABLE signature (no sig file, tool
 * absent via spawnError, gh without --repo, cosign without identity material)
 * is a `skip` for local use — unless `--require-signature`, which turns every
 * such skip into a coded FAIL (the CI gate mode). Operator ERRORS fail in BOTH
 * modes: a `--signer` outside the closed cosign|gh union, exactly one half of
 * the keyless pair, or any option value that parses as a flag. A verification
 * that RAN and failed is tampering evidence and fails in both modes. cosign is
 * spawned ONLY with identity material (`--key`, or `--certificate-identity` +
 * `--certificate-oidc-issuer`): a bare verify-blob proves nothing about WHO
 * signed, and its nonzero exit must stay reserved for genuine tampering
 * evidence.
 */
async function signatureCheck(ctx: PlanContext, dir: string): Promise<Check> {
  const required = ctx.options.requireSignature === true;
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const repo = str(ctx.options.repo);
  const key = str(ctx.options.key);
  const identity = str(ctx.options.certificateIdentity);
  const issuer = str(ctx.options.certificateOidcIssuer);
  const workflow = str(ctx.options.signerWorkflow);
  const hint = ctx.options.signer;
  const sums = join(dir, CHECKSUMS_FILE);
  const sig = join(dir, SIGNATURE_FILE);
  const sigRead = readArtifactText(dir, SIGNATURE_FILE, SIGNATURE_FILE);
  const sigExists = sigRead.ok;

  // Unverifiable (as opposed to failed): tolerated skip, or a fail under the gate.
  const unverifiable = (detail: string): Check => ({
    name: "marketplace signature",
    verdict: required ? "fail" : "skip",
    code: "marketplace.signature",
    detail: required ? `${detail} — --require-signature makes this a failure` : detail,
    location: { uri: CHECKSUMS_FILE },
    fingerprint: "marketplace-signature",
  });
  const failed = (detail: string): Check => ({
    name: "marketplace signature",
    verdict: "fail",
    code: "marketplace.signature",
    detail,
    location: { uri: CHECKSUMS_FILE },
    fingerprint: "marketplace-signature",
  });

  // --signer is a CLOSED union: an explicit wrong value is an operator error,
  // not an unverifiable state — it fails in both modes rather than silently
  // falling through to inference.
  if (typeof hint === "string" && hint.trim().length > 0 && hint !== "cosign" && hint !== "gh") {
    return failed(`--signer must be cosign or gh — got ${JSON.stringify(hint)}`);
  }

  // Defense-in-depth mirroring publish's dash guard: never hand either verifier
  // a composed value that parses as a flag instead of a path/identity.
  const dashLeading = [sums, sig, repo, key, identity, issuer, workflow].filter((value) =>
    value.startsWith("-"),
  );
  if (dashLeading.length > 0) {
    return failed(`refusing to pass a value that parses as a flag: ${dashLeading.join(", ")}`);
  }
  if (!sigRead.ok && sigRead.finding.code !== "marketplace.missing-file") {
    return failed(sigRead.finding.detail ?? `${SIGNATURE_FILE} is not a regular artifact file`);
  }

  // Inference precedence: valid explicit --signer → explicit --repo (gh) →
  // on-disk detached sig (cosign) → nothing to verify. --repo outranks the sig
  // file so a stale leftover .sig from an earlier cosign publish cannot shadow
  // an explicitly-named gh identity.
  const signer =
    hint === "cosign" || hint === "gh"
      ? hint
      : repo.length > 0
        ? "gh"
        : sigExists
          ? "cosign"
          : undefined;
  if (signer === undefined) {
    return unverifiable(
      `no signature to verify — ${SIGNATURE_FILE} is absent and no --repo was given`,
    );
  }

  if (signer === "gh") {
    if (repo.length === 0) {
      return unverifiable("gh attestation verification requires --repo <owner/repo>");
    }
    const argv = ["gh", "attestation", "verify", sums, "--repo", repo];
    if (workflow.length > 0) argv.push("--signer-workflow", workflow);
    const res = await ctx.run(argv);
    if (res.spawnError) return unverifiable("gh not found");
    if (res.code === 0) {
      return {
        name: "marketplace signature",
        verdict: "pass",
        detail: `GitHub attestation verified ${CHECKSUMS_FILE} for ${repo}`,
      };
    }
    return failed(res.stderr.trim() || `gh attestation verify exited ${res.code}`);
  }

  if (!sigExists) return unverifiable(`${SIGNATURE_FILE} missing`);
  // cosign is spawned ONLY with identity material — a bare verify-blob proves
  // nothing about WHO signed, and its nonzero exit must remain reserved for
  // genuine tampering evidence rather than doubling as a usage error.
  const hasIdentity = identity.length > 0;
  const hasIssuer = issuer.length > 0;
  const argv =
    key.length > 0
      ? ["cosign", "verify-blob", "--signature", sig, "--key", key, sums]
      : hasIdentity && hasIssuer
        ? [
            "cosign",
            "verify-blob",
            "--signature",
            sig,
            "--certificate-identity",
            identity,
            "--certificate-oidc-issuer",
            issuer,
            sums,
          ]
        : undefined;
  if (argv === undefined) {
    // Exactly one half of the keyless pair is an operator error (both modes);
    // no identity material at all is merely unverifiable.
    if (hasIdentity !== hasIssuer) {
      return failed(
        hasIdentity
          ? "--certificate-identity requires --certificate-oidc-issuer (the keyless pair verifies together)"
          : "--certificate-oidc-issuer requires --certificate-identity (the keyless pair verifies together)",
      );
    }
    return unverifiable(
      "cosign verification proves an identity only with --key, or --certificate-identity + --certificate-oidc-issuer",
    );
  }
  const res = await ctx.run(argv);
  if (res.spawnError) return unverifiable("cosign not found");
  if (res.code === 0) {
    return {
      name: "marketplace signature",
      verdict: "pass",
      detail: `cosign verified ${CHECKSUMS_FILE} against ${SIGNATURE_FILE}`,
    };
  }
  return failed(res.stderr.trim() || `cosign verify-blob exited ${res.code}`);
}

function marketplaceValidatePlan(ctx: PlanContext): Plan {
  const dir = marketplaceDir(ctx);
  const report = marketplaceReport(dir);
  // One coded probe per finding (the CI gate shape, like `pack validate`), or
  // the green-path pass checks — never both. The signature probe rides along in
  // BOTH cases: provenance is independent of integrity, and its skip/fail
  // semantics are self-contained.
  const checks = report.findings.length > 0 ? report.findings : report.passes;
  return plan(
    "marketplace validate",
    ...checks.map((check) => probe(check.detail ?? check.name, () => check)),
    probe("marketplace signature", (c) => signatureCheck(c, dir)),
  );
}

export const marketplaceValidateCommand: CommandSpec = {
  name: "validate",
  summary:
    "Validate a marketplace artifact — manifest, checksums, coverage, path safety, and publisher signature (read-only CI gate)",
  readOnly: true,
  alwaysVerify: true,
  options: [
    {
      flags: "--dir <dir>",
      description: "marketplace artifact directory to validate",
      default: DEFAULT_MARKETPLACE_OUT,
    },
    {
      flags: "--require-signature",
      description:
        "fail (rather than skip) when the SHA256SUMS signature cannot be verified — the CI gate mode",
    },
    {
      flags: "--signer <signer>",
      description:
        "signature verifier: cosign | gh (closed union; default: infer — gh when --repo is given, else cosign when SHA256SUMS.sig exists)",
    },
    {
      flags: "--repo <owner/repo>",
      description: "GitHub repository identity for gh attestation verification",
    },
    {
      flags: "--key <path>",
      description:
        "cosign public key — the identity cosign verify-blob proves the signature against",
    },
    {
      flags: "--certificate-identity <identity>",
      description:
        "cosign keyless certificate identity (must be paired with --certificate-oidc-issuer)",
    },
    {
      flags: "--certificate-oidc-issuer <issuer>",
      description: "cosign keyless OIDC issuer (must be paired with --certificate-identity)",
    },
    {
      flags: "--signer-workflow <workflow>",
      description: "narrow gh attestation verification to a specific signing workflow",
    },
  ],
  plan: marketplaceValidatePlan,
};
