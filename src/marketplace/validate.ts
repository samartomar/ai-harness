import { existsSync, lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Hex } from "../bundle/index.js";
import { readIfExists } from "../internals/fsxn.js";
import { type CommandSpec, type Plan, type PlanContext, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  AIH_MARKETPLACE_FILE,
  DEFAULT_MARKETPLACE_OUT,
  marketplaceRelPathSchema,
  readMarketplaceManifest,
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
 * signature (no sig file, tool absent, no `--repo` for gh) is a tolerated
 * `skip` for local use; with it, every one of those skips becomes a coded
 * `marketplace.signature` FAIL — the CI gate mode. A signature that EXISTS but
 * fails verification is tampering evidence and fails in BOTH modes.
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
  return isAbsolute(dir) ? dir : join(ctx.root, dir);
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

/** Every regular file under `dir` (artifact-relative, POSIX, sorted); symlinks skipped. */
function collectArtifactFiles(dir: string): string[] {
  const out: string[] = [];
  const root = resolve(dir);
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile()) out.push(relative(root, abs).replace(/\\/g, "/"));
  };
  visit(root);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Grade the manifest's own references: card + evidence must exist; every
 * `files[]` entry must exist AND hash to its recorded sha256. Paths are safety-
 * checked before any read (unsafe → traversal finding, no fs access).
 */
function manifestFindings(dir: string): Check[] {
  const read = readMarketplaceManifest(dir);
  if (!read.ok) {
    return [
      {
        name: "marketplace manifest",
        verdict: "fail",
        code: "marketplace.manifest-parse",
        detail: read.reason,
        location: { uri: AIH_MARKETPLACE_FILE },
        fingerprint: "marketplace-manifest-parse",
      },
    ];
  }
  const findings: Check[] = [];
  for (const skill of read.manifest.skills) {
    for (const rel of [skill.card, skill.evidence]) {
      const target = safeArtifactFile(dir, rel);
      if (target === undefined) {
        findings.push(traversalFinding(rel, AIH_MARKETPLACE_FILE));
      } else if (!existsSync(target)) {
        findings.push(missingFinding(rel, AIH_MARKETPLACE_FILE));
      }
    }
    for (const file of skill.files) {
      const target = safeArtifactFile(dir, file.path);
      if (target === undefined) {
        findings.push(traversalFinding(file.path, AIH_MARKETPLACE_FILE));
        continue;
      }
      const contents = readIfExists(target);
      if (contents === undefined) {
        findings.push(missingFinding(file.path, AIH_MARKETPLACE_FILE));
        continue;
      }
      const actual = sha256Hex(contents);
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
 * inverse direction — a line whose file is gone — is a `missing-file`).
 */
function sumsFindings(dir: string): Check[] {
  const raw = readIfExists(join(dir, CHECKSUMS_FILE));
  if (raw === undefined) {
    return [
      {
        name: "marketplace sums coverage",
        verdict: "fail",
        code: "marketplace.sums-coverage",
        detail: `${CHECKSUMS_FILE} is missing — nothing attests the artifact tree`,
        location: { uri: CHECKSUMS_FILE },
        fingerprint: "marketplace-sums-missing",
      },
    ];
  }
  const findings: Check[] = [];
  const covered = new Set<string>();
  for (const line of raw.split("\n")) {
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
    const target = safeArtifactFile(dir, parsed.path);
    if (target === undefined) {
      findings.push(traversalFinding(parsed.path, CHECKSUMS_FILE));
      continue;
    }
    const contents = readIfExists(target);
    if (contents === undefined) {
      findings.push(missingFinding(parsed.path, CHECKSUMS_FILE));
      continue;
    }
    const actual = sha256Hex(contents);
    if (actual !== parsed.hash) {
      findings.push(mismatchFinding(parsed.path, parsed.hash, actual, CHECKSUMS_FILE));
    }
  }
  for (const rel of collectArtifactFiles(dir)) {
    // The detached signature is signed OVER the sums, so the sums cannot attest
    // it — like SHA256SUMS itself, it is exempt from coverage; the signature
    // probe (not the coverage sweep) is what holds it to account.
    if (rel === CHECKSUMS_FILE || rel === SIGNATURE_FILE || covered.has(rel)) continue;
    findings.push({
      name: "marketplace sums coverage",
      verdict: "fail",
      code: "marketplace.sums-coverage",
      detail: `${rel} exists in the artifact but ${CHECKSUMS_FILE} does not cover it`,
      location: { uri: relLabel(rel) },
      fingerprint: `marketplace-sums-coverage:${rel}`,
    });
  }
  return findings;
}

/** The pure join over one artifact directory: coded findings, or green passes. */
export function marketplaceReport(dir: string): MarketplaceReport {
  const rawManifest = readIfExists(join(dir, AIH_MARKETPLACE_FILE));
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

  const read = readMarketplaceManifest(dir);
  const skills = read.ok ? read.manifest.skills.length : 0;
  // Attested payload count: everything except the sums and their detached
  // signature (neither can be covered by the sums themselves).
  const attested = collectArtifactFiles(dir).filter(
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
 * `verifyBundleSignature`: cosign verifies the detached `SHA256SUMS.sig`, gh
 * verifies the GitHub attestation (which needs `--repo`). Runs via ctx.run
 * under the VERIFY phase only — never at plan time (#35). Signer resolution:
 * an explicit `--signer` wins; otherwise infer — a detached sig means cosign,
 * a `--repo` means gh, neither means there is nothing to verify.
 *
 * Verdict ladder: exit 0 → pass. An UNVERIFIABLE signature (no sig file, tool
 * absent via spawnError, gh without --repo) is a `skip` for local use — unless
 * `--require-signature`, which turns every such skip into a coded FAIL (the CI
 * gate mode). A verification that RAN and failed is tampering evidence and
 * fails in both modes.
 */
async function signatureCheck(ctx: PlanContext, dir: string): Promise<Check> {
  const required = ctx.options.requireSignature === true;
  const repo = typeof ctx.options.repo === "string" ? ctx.options.repo.trim() : "";
  const hint = ctx.options.signer;
  const sums = join(dir, CHECKSUMS_FILE);
  const sig = join(dir, SIGNATURE_FILE);
  const sigExists = readIfExists(sig) !== undefined;

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

  const signer =
    hint === "cosign" || hint === "gh"
      ? hint
      : sigExists
        ? "cosign"
        : repo.length > 0
          ? "gh"
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
    const res = await ctx.run(["gh", "attestation", "verify", sums, "--repo", repo]);
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
  const res = await ctx.run(["cosign", "verify-blob", "--signature", sig, sums]);
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
        "signature verifier: cosign | gh (default: infer — cosign when SHA256SUMS.sig exists, gh when --repo is given)",
    },
    {
      flags: "--repo <owner/repo>",
      description: "GitHub repository identity for gh attestation verification",
    },
  ],
  plan: marketplaceValidatePlan,
};
