import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { verifyBundleChecksums, verifyGithubBundleAttestation } from "../bundle/index.js";
import type { Posture } from "../config/posture.js";
import { EvidenceBundleSchema } from "../evidence/manifest.js";
import { readRegularFile } from "../internals/fsxn.js";
import type { Runner } from "../internals/proc.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import type { BaselineCatalog } from "./catalog.js";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";
import { classifyBaselineLockSkew } from "./skew.js";

export interface OrgBaselineEvidence {
  tier: "org";
  issuer: string;
  evidenceSha256: string;
  lock: BaselineEvidenceLock;
}

export interface ResolveOrgBaselineEvidenceInput {
  root: string;
  catalog: BaselineCatalog;
  policy: OrgPolicy | undefined;
  run: Runner;
  posture: Posture;
}

export interface ResolveOrgBaselineEvidenceResult {
  checks: Check[];
  evidence?: OrgBaselineEvidence;
}

type BaselineOverride = NonNullable<NonNullable<OrgPolicy["trust"]>["baselineOverrides"]>[number];

function failure(
  name: string,
  detail: string,
  code: CheckCode = "baseline.evidence-mismatch",
): ResolveOrgBaselineEvidenceResult {
  return {
    checks: [{ name, verdict: "fail", code, detail }],
  };
}

function readContainedFile(bundleRoot: string, rel: string): Buffer | undefined {
  if (isAbsolute(rel) || rel.split("/").some((part) => part === "..")) return undefined;
  const target = resolve(bundleRoot, ...rel.split("/"));
  let rootReal: string;
  let parentReal: string;
  try {
    if (lstatSync(bundleRoot).isSymbolicLink()) return undefined;
    rootReal = realpathSync(bundleRoot);
    parentReal = realpathSync(dirname(target));
  } catch {
    return undefined;
  }
  const fromRoot = relative(rootReal, parentReal);
  if (fromRoot !== "" && (fromRoot.startsWith("..") || isAbsolute(fromRoot))) return undefined;
  return readRegularFile(target);
}

function matchingSource(lock: BaselineEvidenceLock, catalog: BaselineCatalog): boolean {
  return lock.sources.some(
    (source) =>
      source.id === catalog.id &&
      source.owner === catalog.owner &&
      source.repo === catalog.repo &&
      source.pinnedSha === catalog.pinnedSha,
  );
}

function matchingOverrideSource(candidate: BaselineOverride, catalog: BaselineCatalog): boolean {
  return (
    candidate.catalog === catalog.id &&
    candidate.owner === catalog.owner &&
    candidate.repo === catalog.repo
  );
}

function requiredEvidenceDetail(catalog: BaselineCatalog, declaredPinnedSha?: string): string {
  const lines = [
    `catalog: ${catalog.id}`,
    `owner: ${catalog.owner}`,
    `repo: ${catalog.repo}`,
    `pinnedSha: ${catalog.pinnedSha}`,
  ];
  if (declaredPinnedSha !== undefined) {
    lines.push(
      `declaredPinnedSha: ${declaredPinnedSha}`,
      "re-vet the declared source and update the override to the live pinnedSha.",
    );
  } else {
    lines.push("bundle:", "signingRepository:", "reason:", "reviewer:", "approvedAt:");
  }
  return lines.join("\n");
}

export async function resolveOrgBaselineEvidence(
  input: ResolveOrgBaselineEvidenceInput,
): Promise<ResolveOrgBaselineEvidenceResult> {
  const overrides = input.policy?.trust?.baselineOverrides;
  const override = overrides?.find(
    (candidate) =>
      matchingOverrideSource(candidate, input.catalog) &&
      candidate.pinnedSha === input.catalog.pinnedSha,
  );
  if (override === undefined) {
    if (input.posture === "vibe") return { checks: [] };
    const stale = overrides?.find((candidate) => matchingOverrideSource(candidate, input.catalog));
    return failure(
      "org baseline evidence required",
      requiredEvidenceDetail(input.catalog, stale?.pinnedSha),
      "baseline.org-evidence-required",
    );
  }

  const bundleRoot = resolve(input.root, ...override.bundle.split("/"));
  const root = resolve(input.root);
  const rel = relative(root, bundleRoot);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return failure(
      "org baseline evidence bundle",
      "org baseline evidence bundle escapes the repository root",
    );
  }
  const checksums = verifyBundleChecksums(bundleRoot);
  if (checksums.verdict !== "pass") {
    return failure(
      "org baseline evidence checksums",
      checksums.detail ?? "org baseline evidence checksums failed",
    );
  }
  const signature = await verifyGithubBundleAttestation(
    bundleRoot,
    override.signingRepository,
    input.run,
  );
  if (signature.verdict !== "pass") return { checks: [checksums, signature] };

  const indexBytes = readContainedFile(bundleRoot, "evidence.json");
  if (indexBytes === undefined) {
    return failure("org baseline evidence index", "evidence.json is missing or unsafe");
  }
  let index: ReturnType<typeof EvidenceBundleSchema.parse>;
  try {
    index = EvidenceBundleSchema.parse(JSON.parse(indexBytes.toString("utf8")));
  } catch (err) {
    return failure(
      "org baseline evidence index",
      `evidence.json is invalid: ${(err as Error).message}`,
    );
  }
  const artifacts = index.artifacts.filter((artifact) => artifact.kind === "baseline-evidence");
  for (const artifact of artifacts) {
    const bytes = readContainedFile(bundleRoot, `files/${artifact.path}`);
    if (bytes === undefined) continue;
    // The floor runs on every attested baseline artifact, not just the one that
    // turns out to match this catalog: a lock this build cannot read is a fact
    // about the build, and skipping it would let the run silently settle for an
    // older artifact in the same signed bundle.
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      return failure(
        "org baseline evidence schema",
        `${artifact.path} is not valid JSON: ${(err as Error).message}`,
        "baseline.evidence-schema-unsupported",
      );
    }
    const skew = classifyBaselineLockSkew(raw);
    if (skew.status !== "supported") {
      return failure(
        "org baseline evidence schema",
        `${artifact.path}: ${skew.detail}`,
        "baseline.evidence-schema-unsupported",
      );
    }
    let lock: BaselineEvidenceLock;
    try {
      lock = parseBaselineEvidenceLock(raw);
    } catch (err) {
      return failure(
        "org baseline evidence schema",
        `${artifact.path} declares schema version ${skew.declared} but does not match it: ${(err as Error).message}`,
        "baseline.evidence-schema-unsupported",
      );
    }
    if (!matchingSource(lock, input.catalog)) continue;
    return {
      checks: [checksums, signature],
      evidence: {
        tier: "org",
        issuer: `github:${override.signingRepository}`,
        evidenceSha256: artifact.sha256,
        lock,
      },
    };
  }
  return failure(
    "org baseline evidence artifact",
    `${override.bundle} contains no baseline evidence for ${input.catalog.owner}/${input.catalog.repo}@${input.catalog.pinnedSha}`,
  );
}
