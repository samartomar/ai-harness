import {
  type PackageGraphSource,
  type PackageGraphSourceDigest,
  PackageGraphSourceSchema,
} from "../schema.js";

const GITHUB_REPOSITORY = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const LOWER_GIT_SHA1 = /^[0-9a-f]{40}$/;

export type GitHubSkillSourceFailureReason = "unsupported-source" | "source-commit-mismatch";

export type GitHubSkillSourceResult =
  | {
      success: true;
      source: PackageGraphSource;
      sourceDigest: PackageGraphSourceDigest & { algorithm: "git-sha1" };
    }
  | { success: false; reason: GitHubSkillSourceFailureReason };

/** Normalize the exact two-segment GitHub repository identity used by trust policy. */
export function normalizeGitHubRepository(repository: string): string | undefined {
  const match = GITHUB_REPOSITORY.exec(repository);
  if (match === null) return undefined;
  const owner = match[1];
  const repo = match[2];
  if (owner === undefined || repo === undefined) return undefined;
  const normalized = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const result = PackageGraphSourceSchema.safeParse({
    provider: "github",
    repository: normalized,
  });
  return result.success ? result.data.repository : undefined;
}

/** Parse the anchored approval form `owner/repo@<lowercase full Git SHA>`. */
export function parseGitHubSkillSource(source: string, commit: string): GitHubSkillSourceResult {
  if (!LOWER_GIT_SHA1.test(commit)) return { success: false, reason: "unsupported-source" };
  const separator = source.lastIndexOf("@");
  if (separator <= 0 || separator !== source.length - commit.length - 1) {
    return { success: false, reason: "unsupported-source" };
  }
  const repository = normalizeGitHubRepository(source.slice(0, separator));
  const sourceCommit = source.slice(separator + 1);
  if (repository === undefined || !LOWER_GIT_SHA1.test(sourceCommit)) {
    return { success: false, reason: "unsupported-source" };
  }
  if (sourceCommit !== commit) return { success: false, reason: "source-commit-mismatch" };
  return {
    success: true,
    source: { provider: "github", repository },
    sourceDigest: { algorithm: "git-sha1", value: commit },
  };
}
