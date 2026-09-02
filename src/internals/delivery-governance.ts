import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultRunner, type Runner } from "./proc.js";

export const RELEASE_SURFACES = [
  "cli-flags-exit-codes",
  "library-exports",
  "schemas",
  "machine-readable-output",
  "generated-artifacts",
  "administrator-controls",
  "installation-uninstallation",
  "files-environment-credentials",
  "network-egress-telemetry-data-classes",
  "direct-dependencies",
  "transitive-dependencies",
  "install-scripts",
  "licenses-cves",
  "trust-roots-provenance",
  "guides",
  "known-issues",
  "waivers",
  "support",
  "rollback",
] as const;

const nonempty = z.string().trim().min(1).max(4096);
const identifier = z.string().regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/u);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
const timestamp = z.iso.datetime({ offset: false });
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const githubUrl = z.url().refine((value) => new URL(value).hostname === "github.com", {
  message: "URL must use github.com",
});
const evidenceDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const requiredInstalledMatrixLegs = new Set([
  "ubuntu-latest/node-20",
  "ubuntu-latest/node-22",
  "ubuntu-latest/node-24",
  "macos-latest/node-22",
  "windows-latest/node-22",
]);

function installedMatrixFinding(
  matrix: readonly { os: string; node: string }[],
): string | undefined {
  const actual = new Set(matrix.map((leg) => `${leg.os}/node-${leg.node}`));
  if (actual.size !== matrix.length) return "matrix contains a duplicate leg";
  if (
    actual.size !== requiredInstalledMatrixLegs.size ||
    [...requiredInstalledMatrixLegs].some((leg) => !actual.has(leg))
  ) {
    return "matrix must cover Ubuntu on Node 20/22/24 plus macOS and Windows on Node 22";
  }
  return undefined;
}

function qualificationMatrixFinding(
  matrix: readonly { os: string; node: string; scope: string }[],
): string | undefined {
  const expected = new Set([
    "full-source:ubuntu-latest/node-22",
    "full-source:macos-latest/node-22",
    "full-source:windows-latest/node-22",
    ...[...requiredInstalledMatrixLegs].map((leg) => `installed-artifact:${leg}`),
  ]);
  const actual = new Set(matrix.map((leg) => `${leg.scope}:${leg.os}/node-${leg.node}`));
  if (actual.size !== matrix.length) return "matrix contains a duplicate leg";
  if (actual.size !== expected.size || [...expected].some((leg) => !actual.has(leg))) {
    return "matrix must cover exact full-source and installed-artifact operating-system/Node legs";
  }
  return undefined;
}

function compareStableVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const changedSurfaceSchema = z
  .object({
    status: z.literal("changed"),
    previous: nonempty,
    next: nonempty,
    affectedCohort: nonempty,
    operatorAction: nonempty,
    compatibility: nonempty,
    risk: nonempty,
    documentation: z.array(nonempty).min(1),
    migration: nonempty,
    owner: nonempty,
    evidenceDigests: z.array(evidenceDigest).min(1),
  })
  .strict();

const dispositionSurfaceSchema = z
  .object({
    status: z.enum(["unchanged", "not-applicable"]),
    rationale: nonempty,
    evidenceDigests: z.array(evidenceDigest),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "unchanged" && value.evidenceDigests.length === 0) {
      context.addIssue({ code: "custom", message: "unchanged surface requires evidence" });
    }
    if (value.status === "not-applicable" && value.evidenceDigests.length > 0) {
      context.addIssue({ code: "custom", message: "not-applicable surface cannot cite evidence" });
    }
  });

const surfaceSchema = z.union([changedSurfaceSchema, dispositionSurfaceSchema]);

const candidateSchema = z
  .object({
    schemaVersion: z.literal("aih-enterprise-change-manifest-v1"),
    package: z
      .object({
        name: z.literal("@aihq/core"),
        fromVersion: version,
        version,
      })
      .strict()
      .refine((value) => compareStableVersions(value.version, value.fromVersion) > 0, {
        message: "candidate version must advance the approved baseline",
      }),
    tracker: z.object({ repository, issueNumber: z.number().int().positive().safe() }).strict(),
    decisionUnit: z
      .object({
        id: identifier,
        cohort: nonempty,
        outcome: nonempty,
        includedChanges: z.array(nonempty).min(1),
        adoption: z.enum(["no-action", "optional", "recommended", "required", "security-urgent"]),
        adoptionRationale: nonempty,
        prerequisites: z.array(nonempty),
        rollout: nonempty,
        rollback: nonempty,
        supportImpact: nonempty,
        accountableOwner: nonempty,
      })
      .strict(),
    surfaces: z.record(z.string(), z.unknown()),
    knownIssues: z.array(nonempty),
    waivers: z.array(nonempty),
  })
  .strict()
  .superRefine((value, context) => {
    const actual = Object.keys(value.surfaces).sort();
    const expected = [...RELEASE_SURFACES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      context.addIssue({
        code: "custom",
        path: ["surfaces"],
        message: "every release surface requires exactly one disposition",
      });
      return;
    }
    for (const name of RELEASE_SURFACES) {
      const result = surfaceSchema.safeParse(value.surfaces[name]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          context.addIssue({
            code: "custom",
            path: ["surfaces", name, ...issue.path],
            message: `surface ${name}: ${issue.message}`,
          });
        }
      }
    }
  });

export type CandidateManifest = z.infer<typeof candidateSchema>;

const requiredCheckSchema = z.object({ name: nonempty, conclusion: z.literal("success") }).strict();

const qualificationSchema = z
  .object({
    schemaVersion: z.literal("aih-release-qualification-v1"),
    package: z.object({ name: z.literal("@aihq/core"), version }).strict(),
    source: z
      .object({
        sha,
        tag: z.string().regex(/^v-core-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u),
        tagObject: sha,
      })
      .strict(),
    tracker: z.object({ repository, issueNumber: z.number().int().positive().safe() }).strict(),
    protectedMainCi: z
      .object({
        runId: z.number().int().positive().safe(),
        runUrl: githubUrl,
        requiredChecks: z.array(requiredCheckSchema).min(1),
      })
      .strict(),
    artifact: z
      .object({
        id: z.number().int().positive().safe(),
        digest,
        tarball: z.string().regex(/^aihq-core-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.tgz$/u),
        tarballSha256: sha256,
      })
      .strict(),
    manifests: z.object({ enterpriseChangeSha256: sha256, sbomSha256: sha256 }).strict(),
    workflow: z
      .object({
        path: z.literal(".github/workflows/release.yml"),
        revision: sha,
        runId: z.number().int().positive().safe(),
        runAttempt: z.number().int().positive().safe(),
      })
      .strict(),
    matrix: z
      .array(
        z
          .object({
            os: z.enum(["ubuntu-latest", "macos-latest", "windows-latest"]),
            node: z.enum(["20", "22", "24"]),
            scope: z.enum(["full-source", "installed-artifact"]),
            conclusion: z.literal("success"),
          })
          .strict(),
      )
      .length(8),
    createdAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source.tag !== `v-core-${value.package.version}`) {
      context.addIssue({ code: "custom", message: "qualification tag/version mismatch" });
    }
    if (value.artifact.tarball !== `aihq-core-${value.package.version}.tgz`) {
      context.addIssue({ code: "custom", message: "qualification tarball/version mismatch" });
    }
    const checkNames = new Set(value.protectedMainCi.requiredChecks.map((check) => check.name));
    if (checkNames.size !== value.protectedMainCi.requiredChecks.length) {
      context.addIssue({
        code: "custom",
        message: "qualification contains duplicate required checks",
      });
    }
    const matrixIssue = qualificationMatrixFinding(value.matrix);
    if (matrixIssue) context.addIssue({ code: "custom", message: `qualification ${matrixIssue}` });
  });

export type QualificationReceipt = z.infer<typeof qualificationSchema>;

const acceptanceSchema = z
  .object({
    schemaVersion: z.literal("aih-installed-acceptance-v1"),
    qualificationDigest: digest,
    package: z
      .object({
        name: z.literal("@aihq/core"),
        version,
        integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/u),
      })
      .strict(),
    companions: z.object({ scanner: version, catalog: version }).strict(),
    registryBytesSha256: sha256,
    provenanceVerified: z.literal(true),
    releaseVerification: z.object({ passed: z.literal(true), skippedLegs: z.literal(0) }).strict(),
    matrix: z
      .array(
        z
          .object({
            os: z.enum(["ubuntu-latest", "macos-latest", "windows-latest"]),
            node: z.enum(["20", "22", "24"]),
            conclusion: z.literal("success"),
          })
          .strict(),
      )
      .length(5),
    evidenceUrl: githubUrl,
    createdAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    const matrixIssue = installedMatrixFinding(value.matrix);
    if (matrixIssue)
      context.addIssue({ code: "custom", message: `installed acceptance ${matrixIssue}` });
  });

export type InstalledAcceptanceReceipt = z.infer<typeof acceptanceSchema>;

const authorizationSchema = z
  .object({
    schemaVersion: z.enum(["aih-publication-authorization-v1", "aih-promotion-authorization-v1"]),
    repository,
    issueNumber: z.number().int().positive().safe(),
    commentId: z.number().int().positive().safe(),
    commentUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*#issuecomment-[1-9]\d*$/u,
      ),
    author: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u),
    authorAssociation: z.literal("OWNER"),
    createdAt: timestamp,
    token: nonempty,
  })
  .strict();

export type ReleaseAuthorization = z.infer<typeof authorizationSchema>;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function evidenceSha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function validateCandidateManifest(value: unknown): CandidateManifest {
  return candidateSchema.parse(value);
}

export function validateCandidateManifestForRepository(
  value: unknown,
  expectedRepository: string,
): CandidateManifest {
  const manifest = validateCandidateManifest(value);
  const expected = repository.parse(expectedRepository);
  if (manifest.tracker.repository !== expected) {
    throw new Error("candidate tracker repository does not match the executing repository");
  }
  return manifest;
}

export interface CumulativeEnterpriseDelta {
  schemaVersion: "aih-cumulative-enterprise-delta-v1";
  fromVersion: string;
  toVersion: string;
  releases: string[];
  decisionUnits: string[];
  surfaces: Record<
    (typeof RELEASE_SURFACES)[number],
    { changes: Array<{ release: string; decisionUnit: string; disposition: unknown }> }
  >;
}

export function buildCumulativeEnterpriseDelta(
  manifests: readonly unknown[],
  fromVersion: string,
  toVersion: string,
): CumulativeEnterpriseDelta {
  version.parse(fromVersion);
  version.parse(toVersion);
  if (compareStableVersions(toVersion, fromVersion) <= 0) {
    throw new Error("enterprise manifest destination must advance the approved baseline");
  }
  const parsed = manifests.map(validateCandidateManifest);
  const byBaseline = new Map<string, CandidateManifest>();
  for (const manifest of parsed) {
    if (byBaseline.has(manifest.package.fromVersion)) {
      throw new Error(`enterprise manifest chain branches at ${manifest.package.fromVersion}`);
    }
    byBaseline.set(manifest.package.fromVersion, manifest);
  }

  const ordered: CandidateManifest[] = [];
  const visited = new Set<string>();
  let cursor = fromVersion;
  while (cursor !== toVersion) {
    if (visited.has(cursor)) throw new Error(`enterprise manifest chain cycles at ${cursor}`);
    visited.add(cursor);
    const next = byBaseline.get(cursor);
    if (next === undefined) {
      throw new Error(`enterprise manifest chain is missing ${cursor} -> ${toVersion}`);
    }
    ordered.push(next);
    cursor = next.package.version;
    if (ordered.length > parsed.length) throw new Error("enterprise manifest chain is not bounded");
  }

  const surfaces = Object.fromEntries(
    RELEASE_SURFACES.map((name) => [
      name,
      {
        changes: ordered.map((manifest) => ({
          release: manifest.package.version,
          decisionUnit: manifest.decisionUnit.id,
          disposition: manifest.surfaces[name],
        })),
      },
    ]),
  ) as CumulativeEnterpriseDelta["surfaces"];
  return {
    schemaVersion: "aih-cumulative-enterprise-delta-v1",
    fromVersion,
    toVersion,
    releases: ordered.map((manifest) => manifest.package.version),
    decisionUnits: ordered.map((manifest) => manifest.decisionUnit.id),
    surfaces,
  };
}

export function validateQualificationReceipt(value: unknown): QualificationReceipt {
  return qualificationSchema.parse(value);
}

export function validateQualificationReceiptForRepository(
  value: unknown,
  expectedRepository: string,
): QualificationReceipt {
  const receipt = validateQualificationReceipt(value);
  const expected = repository.parse(expectedRepository);
  if (receipt.tracker.repository !== expected) {
    throw new Error("qualification tracker repository does not match the executing repository");
  }
  return receipt;
}

export function validateInstalledAcceptanceReceipt(value: unknown): InstalledAcceptanceReceipt {
  return acceptanceSchema.parse(value);
}

export function publicationAuthorizationToken(receipt: unknown): string {
  const value = validateQualificationReceipt(receipt);
  return [
    "AIH-PUBLISH-V1",
    `${value.package.name}@${value.package.version}`,
    value.source.sha,
    value.source.tag,
    value.source.tagObject,
    value.artifact.tarballSha256,
    String(value.artifact.id),
    value.artifact.digest,
    value.manifests.enterpriseChangeSha256,
    value.manifests.sbomSha256,
    String(value.workflow.runId),
    `sha256:${evidenceSha256(value)}`,
  ].join(" ");
}

export function promotionAuthorizationToken(receipt: unknown, acceptance: unknown): string {
  const qualified = validateQualificationReceipt(receipt);
  const installed = validateInstalledAcceptanceReceipt(acceptance);
  if (installed.package.version !== qualified.package.version) {
    throw new Error("installed acceptance package does not match qualification");
  }
  const expectedQualificationDigest = `sha256:${evidenceSha256(qualified)}`;
  if (installed.qualificationDigest !== expectedQualificationDigest) {
    throw new Error("installed acceptance does not bind the qualification receipt");
  }
  return [
    "AIH-PROMOTE-V1",
    `${qualified.package.name}@${qualified.package.version}`,
    qualified.source.sha,
    qualified.source.tag,
    qualified.artifact.tarballSha256,
    installed.package.integrity,
    installed.registryBytesSha256,
    installed.companions.scanner,
    installed.companions.catalog,
    expectedQualificationDigest,
    `sha256:${evidenceSha256(installed)}`,
  ].join(" ");
}

export type CandidateTerminalState = "rejected" | "superseded";

export function candidateStateToken(receipt: unknown, state: CandidateTerminalState): string {
  const qualified = validateQualificationReceipt(receipt);
  return `AIH-CANDIDATE-STATE-V1 sha256:${evidenceSha256(qualified)} ${state}`;
}

function validateAuthorizationIdentity(
  authorization: unknown,
  expectedSchema: ReleaseAuthorization["schemaVersion"],
  expectedRepository: string,
  expectedIssue: number,
): ReleaseAuthorization {
  const value = authorizationSchema.parse(authorization);
  if (value.schemaVersion !== expectedSchema) throw new Error("authorization schema mismatch");
  if (value.repository !== expectedRepository || value.issueNumber !== expectedIssue) {
    throw new Error("authorization is not on the candidate tracker");
  }
  const expectedUrl = `https://github.com/${value.repository}/issues/${value.issueNumber}#issuecomment-${value.commentId}`;
  if (value.commentUrl !== expectedUrl) throw new Error("authorization comment identity mismatch");
  return value;
}

export function validatePublicationAuthorization(
  receipt: unknown,
  authorization: unknown,
): ReleaseAuthorization {
  const qualified = validateQualificationReceipt(receipt);
  const value = validateAuthorizationIdentity(
    authorization,
    "aih-publication-authorization-v1",
    qualified.tracker.repository,
    qualified.tracker.issueNumber,
  );
  if (value.token !== publicationAuthorizationToken(qualified)) {
    throw new Error("publication authorization token does not match qualification");
  }
  if (Date.parse(value.createdAt) < Date.parse(qualified.createdAt)) {
    throw new Error("publication authorization predates qualification");
  }
  return value;
}

export function validatePromotionAuthorization(
  receipt: unknown,
  acceptance: unknown,
  authorization: unknown,
): ReleaseAuthorization {
  const qualified = validateQualificationReceipt(receipt);
  const installed = validateInstalledAcceptanceReceipt(acceptance);
  const value = validateAuthorizationIdentity(
    authorization,
    "aih-promotion-authorization-v1",
    qualified.tracker.repository,
    qualified.tracker.issueNumber,
  );
  if (value.token !== promotionAuthorizationToken(qualified, installed)) {
    throw new Error("promotion authorization token does not match acceptance evidence");
  }
  if (Date.parse(value.createdAt) < Date.parse(installed.createdAt)) {
    throw new Error("promotion authorization predates installed acceptance");
  }
  return value;
}

interface GitHubIssueComment {
  id?: unknown;
  html_url?: unknown;
  issue_url?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
  author_association?: unknown;
  created_at?: unknown;
}

function parseAuthorizationCommentUrl(commentUrl: string): {
  repository: string;
  issueNumber: number;
  commentId: number;
} {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)#issuecomment-([1-9]\d*)$/u.exec(
      commentUrl,
    );
  if (!match) throw new Error("authorization must use a strict GitHub issue-comment URL");
  return { repository: match[1] ?? "", issueNumber: Number(match[2]), commentId: Number(match[3]) };
}

export async function resolveReleaseAuthorizationComment(
  kind: "publication" | "promotion",
  receipt: unknown,
  acceptance: unknown | undefined,
  expectedRepository: string,
  commentUrl: string,
  run: Runner = defaultRunner,
): Promise<ReleaseAuthorization> {
  const qualified = validateQualificationReceiptForRepository(receipt, expectedRepository);
  const parsed = parseAuthorizationCommentUrl(commentUrl);
  if (
    parsed.repository !== qualified.tracker.repository ||
    parsed.issueNumber !== qualified.tracker.issueNumber
  ) {
    throw new Error("authorization comment is not on the candidate tracker");
  }
  const result = await run([
    "gh",
    "api",
    `repos/${parsed.repository}/issues/comments/${parsed.commentId}`,
  ]);
  if (result.code !== 0 || result.spawnError || result.truncated) {
    throw new Error("failed to resolve release authorization comment");
  }

  let raw: GitHubIssueComment;
  try {
    raw = JSON.parse(result.stdout) as GitHubIssueComment;
  } catch {
    throw new Error("release authorization response was not valid JSON");
  }
  const expectedIssueUrl = `https://api.github.com/repos/${parsed.repository}/issues/${parsed.issueNumber}`;
  if (
    raw.id !== parsed.commentId ||
    raw.html_url !== commentUrl ||
    raw.issue_url !== expectedIssueUrl
  ) {
    throw new Error("release authorization comment identity does not match GitHub");
  }
  const token =
    kind === "publication"
      ? publicationAuthorizationToken(qualified)
      : promotionAuthorizationToken(qualified, acceptance);
  if (
    typeof raw.body !== "string" ||
    !raw.body.split(/\r?\n/u).some((line) => line.trim() === token)
  ) {
    throw new Error("release authorization comment does not contain the exact token");
  }
  const authorization: ReleaseAuthorization = {
    schemaVersion:
      kind === "publication"
        ? "aih-publication-authorization-v1"
        : "aih-promotion-authorization-v1",
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    commentId: parsed.commentId,
    commentUrl,
    author: typeof raw.user?.login === "string" ? raw.user.login : "",
    authorAssociation: raw.author_association as ReleaseAuthorization["authorAssociation"],
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    token,
  };
  return kind === "publication"
    ? validatePublicationAuthorization(qualified, authorization)
    : validatePromotionAuthorization(qualified, acceptance, authorization);
}

export function assertCandidateActive(
  receipt: unknown,
  expectedRepository: string,
  comments: readonly unknown[],
): void {
  const qualified = validateQualificationReceiptForRepository(receipt, expectedRepository);
  const rejected = candidateStateToken(qualified, "rejected");
  const superseded = candidateStateToken(qualified, "superseded");
  for (const candidate of comments) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const comment = candidate as GitHubIssueComment;
    if (comment.author_association !== "OWNER" || typeof comment.body !== "string") {
      continue;
    }
    const lines = new Set(comment.body.split(/\r?\n/u).map((line) => line.trim()));
    if (lines.has(rejected)) throw new Error("qualified candidate was rejected");
    if (lines.has(superseded)) throw new Error("qualified candidate was superseded");
  }
}

export interface ReleasePreparationInput {
  changedPaths: readonly string[];
  packageBefore?: unknown;
  packageAfter?: unknown;
  lockBefore?: unknown;
  lockAfter?: unknown;
  versionBefore?: string;
  versionAfter?: string;
}

export interface ReleasePreparationFinding {
  code: "release-prep-path" | "release-prep-package" | "release-prep-lock" | "release-prep-version";
  detail: string;
}

const RELEASE_PREP_PATHS = new Set([
  "CHANGELOG.md",
  "RELEASING.md",
  "SUPPORT.md",
  "VERSIONING.md",
  "package-lock.json",
  "package.json",
  "release/enterprise-change.json",
  "src/version.ts",
]);

function cloneWithoutVersion(value: unknown, lockfile: boolean): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = structuredClone(value) as Record<string, unknown>;
  delete copy.version;
  if (lockfile) {
    const packages = copy.packages;
    if (packages !== null && typeof packages === "object" && !Array.isArray(packages)) {
      const root = (packages as Record<string, unknown>)[""];
      if (root !== null && typeof root === "object" && !Array.isArray(root)) {
        delete (root as Record<string, unknown>).version;
      }
    }
  }
  return copy;
}

function versionSourceShape(value: string): string {
  return value.replace(
    /(export\s+const\s+VERSION\s*=\s*["'])(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(["'])/u,
    "$1<VERSION>$2",
  );
}

export function validateReleasePreparation(
  input: ReleasePreparationInput,
): ReleasePreparationFinding[] {
  const findings: ReleasePreparationFinding[] = [];
  const changedPaths = [...new Set(input.changedPaths.map((path) => path.replace(/\\/gu, "/")))];
  for (const path of changedPaths) {
    if (!RELEASE_PREP_PATHS.has(path) && !path.startsWith("docs/releases/")) {
      findings.push({
        code: "release-prep-path",
        detail: `${path} is outside the release-preparation allowlist`,
      });
    }
  }

  if (changedPaths.includes("package.json")) {
    if (input.packageBefore === undefined || input.packageAfter === undefined) {
      findings.push({ code: "release-prep-package", detail: "package.json comparison is missing" });
    } else if (
      canonicalize(cloneWithoutVersion(input.packageBefore, false)) !==
      canonicalize(cloneWithoutVersion(input.packageAfter, false))
    ) {
      findings.push({
        code: "release-prep-package",
        detail: "package.json changed outside its version field",
      });
    }
  }

  if (changedPaths.includes("package-lock.json")) {
    if (input.lockBefore === undefined || input.lockAfter === undefined) {
      findings.push({
        code: "release-prep-lock",
        detail: "package-lock.json comparison is missing",
      });
    } else if (
      canonicalize(cloneWithoutVersion(input.lockBefore, true)) !==
      canonicalize(cloneWithoutVersion(input.lockAfter, true))
    ) {
      findings.push({
        code: "release-prep-lock",
        detail: "package-lock.json changed outside root version metadata",
      });
    }
  }

  if (changedPaths.includes("src/version.ts")) {
    if (input.versionBefore === undefined || input.versionAfter === undefined) {
      findings.push({
        code: "release-prep-version",
        detail: "version source comparison is missing",
      });
    } else if (
      versionSourceShape(input.versionBefore) !== versionSourceShape(input.versionAfter) ||
      input.versionBefore === input.versionAfter
    ) {
      findings.push({
        code: "release-prep-version",
        detail: "src/version.ts changed outside one VERSION literal",
      });
    }
  }
  return findings;
}
