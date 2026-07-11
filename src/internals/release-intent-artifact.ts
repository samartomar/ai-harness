import { defaultRunner, type Runner } from "./proc.js";
import { intentAcknowledgementToken, type SemverClass } from "./release-preflight.js";

export interface IntentAcknowledgementArtifact {
  repository: string;
  issueNumber: number;
  commentId: number;
  commentUrl: string;
  author: string;
  authorAssociation: "OWNER" | "MEMBER" | "COLLABORATOR";
  createdAt: string;
  token: string;
}

export interface IntentAcknowledgementInput {
  repository: string;
  trackerIssueNumber: number;
  candidateSha: string;
  declaredIntent: SemverClass;
  computedBump: SemverClass;
}

const AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const COMMENT_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._-]+)\/issues\/([1-9]\d*)#issuecomment-([1-9]\d*)$/;
const AUTHOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface ParsedCommentUrl {
  repository: string;
  issueNumber: number;
  commentId: number;
}

function parseCommentUrl(commentUrl: string): ParsedCommentUrl {
  if (typeof commentUrl !== "string") {
    throw new Error("intent acknowledgement must include a GitHub issue-comment URL");
  }
  const match = COMMENT_URL.exec(commentUrl);
  if (!match) throw new Error("intent acknowledgement must be a strict GitHub issue-comment URL");
  const issueNumber = Number(match[3]);
  const commentId = Number(match[4]);
  if (!Number.isSafeInteger(issueNumber) || !Number.isSafeInteger(commentId)) {
    throw new Error("intent acknowledgement issue and comment IDs must be safe integers");
  }
  return {
    repository: `${match[1]}/${match[2]}`,
    issueNumber,
    commentId,
  };
}

function expectedToken(input: IntentAcknowledgementInput): string {
  return intentAcknowledgementToken(input.candidateSha, input.declaredIntent, input.computedBump);
}

function isValidCreatedAt(value: unknown): value is string {
  if (typeof value !== "string" || !CREATED_AT.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value.replace(/Z$/, ".000Z")
  );
}

export function validateIntentAcknowledgementArtifact(
  input: IntentAcknowledgementInput,
  artifact: IntentAcknowledgementArtifact,
): IntentAcknowledgementArtifact {
  if (artifact.repository !== input.repository) {
    throw new Error("intent acknowledgement repository does not match the release repository");
  }
  if (artifact.issueNumber !== input.trackerIssueNumber) {
    throw new Error("intent acknowledgement issue is not the release tracker");
  }
  if (!Number.isSafeInteger(artifact.commentId) || artifact.commentId <= 0) {
    throw new Error("intent acknowledgement is missing an immutable comment ID");
  }

  const parsed = parseCommentUrl(artifact.commentUrl);
  if (
    parsed.repository !== artifact.repository ||
    parsed.issueNumber !== artifact.issueNumber ||
    parsed.commentId !== artifact.commentId
  ) {
    throw new Error(
      "intent acknowledgement URL does not match its repository, issue, and comment ID",
    );
  }
  if (typeof artifact.author !== "string" || !AUTHOR.test(artifact.author)) {
    throw new Error("intent acknowledgement is missing a valid GitHub author");
  }
  if (!AUTHOR_ASSOCIATIONS.has(artifact.authorAssociation)) {
    throw new Error("intent acknowledgement author lacks repository authority");
  }
  if (!isValidCreatedAt(artifact.createdAt)) {
    throw new Error("intent acknowledgement is missing a valid creation timestamp");
  }
  if (artifact.token !== expectedToken(input)) {
    throw new Error("intent acknowledgement token does not match the release inputs");
  }
  return artifact;
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

export async function resolveIntentAcknowledgementComment(
  commentUrl: string,
  input: IntentAcknowledgementInput,
  run: Runner = defaultRunner,
): Promise<IntentAcknowledgementArtifact> {
  const parsed = parseCommentUrl(commentUrl);
  if (parsed.repository !== input.repository || parsed.issueNumber !== input.trackerIssueNumber) {
    throw new Error("intent acknowledgement comment is not on the release tracker");
  }

  const result = await run([
    "gh",
    "api",
    `repos/${parsed.repository}/issues/comments/${parsed.commentId}`,
  ]);
  if (result.code !== 0 || result.spawnError) {
    throw new Error("failed to resolve GitHub comment for intent acknowledgement");
  }

  let raw: GitHubIssueComment;
  try {
    raw = JSON.parse(result.stdout) as GitHubIssueComment;
  } catch {
    throw new Error("GitHub comment response was not valid JSON");
  }

  const expectedIssueUrl = `https://api.github.com/repos/${parsed.repository}/issues/${parsed.issueNumber}`;
  const token = expectedToken(input);
  if (raw.id !== parsed.commentId) {
    throw new Error("GitHub comment immutable ID does not match its URL");
  }
  if (raw.html_url !== commentUrl) {
    throw new Error("GitHub comment URL does not match the requested comment");
  }
  if (raw.issue_url !== expectedIssueUrl) {
    throw new Error("GitHub comment does not belong to the release tracker");
  }
  if (
    typeof raw.body !== "string" ||
    !raw.body.split(/\r?\n/).some((line) => line.trim() === token)
  ) {
    throw new Error("GitHub comment does not contain the exact acknowledgement token");
  }

  const artifact: IntentAcknowledgementArtifact = {
    repository: parsed.repository,
    issueNumber: parsed.issueNumber,
    commentId: parsed.commentId,
    commentUrl,
    author: typeof raw.user?.login === "string" ? raw.user.login : "",
    authorAssociation: raw.author_association as IntentAcknowledgementArtifact["authorAssociation"],
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    token,
  };
  return validateIntentAcknowledgementArtifact(input, artifact);
}
