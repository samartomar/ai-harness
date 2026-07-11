import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  type IntentAcknowledgementArtifact,
  type IntentAcknowledgementInput,
  resolveIntentAcknowledgementComment,
  validateIntentAcknowledgementArtifact,
} from "../../src/internals/release-intent-artifact.js";

const candidateSha = "a".repeat(40);
const token = `${candidateSha}:patch:minor`;

function input(overrides: Partial<IntentAcknowledgementInput> = {}): IntentAcknowledgementInput {
  return {
    repository: "samartomar/ai-harness",
    trackerIssueNumber: 900,
    candidateSha,
    declaredIntent: "patch",
    computedBump: "minor",
    ...overrides,
  };
}

function artifact(
  overrides: Partial<IntentAcknowledgementArtifact> = {},
): IntentAcknowledgementArtifact {
  return {
    repository: "samartomar/ai-harness",
    issueNumber: 900,
    commentId: 123456,
    commentUrl: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
    author: "samartomar",
    authorAssociation: "OWNER",
    createdAt: "2026-07-10T23:00:00Z",
    token,
    ...overrides,
  };
}

describe("validateIntentAcknowledgementArtifact", () => {
  it("accepts an attributable artifact bound to the release inputs", () => {
    const value = artifact();

    expect(validateIntentAcknowledgementArtifact(input(), value)).toEqual(value);
  });

  it.each([
    ["another repository", artifact({ repository: "other/repo" })],
    ["a non-tracker issue", artifact({ issueNumber: 901 })],
    ["a mismatched token", artifact({ token: `${candidateSha}:patch:major` })],
    ["a changed candidate SHA", artifact(), input({ candidateSha: "b".repeat(40) })],
    ["a changed declared intent", artifact(), input({ declaredIntent: "minor" })],
    ["a changed computed bump", artifact(), input({ computedBump: "major" })],
  ])("rejects %s", (_name, value, context = input()) => {
    expect(() =>
      validateIntentAcknowledgementArtifact(
        context as IntentAcknowledgementInput,
        value as IntentAcknowledgementArtifact,
      ),
    ).toThrow();
  });

  it("rejects an artifact without an immutable comment ID", () => {
    expect(() =>
      validateIntentAcknowledgementArtifact(input(), artifact({ commentId: 0 })),
    ).toThrow();
  });

  it("rejects a comment URL whose immutable ID does not match the artifact", () => {
    expect(() =>
      validateIntentAcknowledgementArtifact(
        input(),
        artifact({
          commentUrl: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-654321",
        }),
      ),
    ).toThrow();
  });

  it("rejects authority outside OWNER, MEMBER, or COLLABORATOR", () => {
    expect(() =>
      validateIntentAcknowledgementArtifact(
        input(),
        artifact({ authorAssociation: "CONTRIBUTOR" as "OWNER" }),
      ),
    ).toThrow();
  });

  it("rejects a serialized artifact with no author", () => {
    const value = artifact();
    delete (value as Partial<IntentAcknowledgementArtifact>).author;

    expect(() => validateIntentAcknowledgementArtifact(input(), value)).toThrow();
  });

  it("rejects an impossible creation timestamp", () => {
    expect(() =>
      validateIntentAcknowledgementArtifact(
        input(),
        artifact({ createdAt: "2026-02-31T23:00:00Z" }),
      ),
    ).toThrow();
  });
});

describe("resolveIntentAcknowledgementComment", () => {
  it("resolves a strict GitHub issue-comment URL through the Runner boundary", async () => {
    const run = fakeRunner((argv) => {
      expect(argv).toEqual(["gh", "api", "repos/samartomar/ai-harness/issues/comments/123456"]);
      return {
        stdout: JSON.stringify({
          id: 123456,
          html_url: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
          issue_url: "https://api.github.com/repos/samartomar/ai-harness/issues/900",
          body: `Release escalation acknowledgement\n\n${token}`,
          user: { login: "samartomar" },
          author_association: "OWNER",
          created_at: "2026-07-10T23:00:00Z",
        }),
      };
    });

    await expect(
      resolveIntentAcknowledgementComment(
        "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
        input(),
        run,
      ),
    ).resolves.toEqual(artifact());
  });

  it.each([
    "http://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
    "https://github.com/samartomar/ai-harness/issues/900?view=1#issuecomment-123456",
    "https://github.com/samartomar/ai-harness/pull/900#issuecomment-123456",
    "https://evil.example/samartomar/ai-harness/issues/900#issuecomment-123456",
  ])("rejects malformed or non-GitHub comment URL %s before spawning", async (commentUrl) => {
    const run = fakeRunner(() => {
      throw new Error("Runner must not be called");
    });

    await expect(resolveIntentAcknowledgementComment(commentUrl, input(), run)).rejects.toThrow();
  });

  it.each([
    [
      "wrong repository",
      { html_url: "https://github.com/other/repo/issues/900#issuecomment-123456" },
    ],
    ["wrong issue", { issue_url: "https://api.github.com/repos/samartomar/ai-harness/issues/901" }],
    ["wrong immutable ID", { id: 654321 }],
    ["wrong token", { body: `${candidateSha}:patch:major` }],
    ["unauthorized author", { author_association: "CONTRIBUTOR" }],
    ["missing author", { user: null }],
    ["missing timestamp", { created_at: null }],
  ])("rejects a GitHub response with %s", async (_name, override) => {
    const response = {
      id: 123456,
      html_url: "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
      issue_url: "https://api.github.com/repos/samartomar/ai-harness/issues/900",
      body: token,
      user: { login: "samartomar" },
      author_association: "OWNER",
      created_at: "2026-07-10T23:00:00Z",
      ...override,
    };
    const run = fakeRunner(() => ({ stdout: JSON.stringify(response) }));

    await expect(
      resolveIntentAcknowledgementComment(artifact().commentUrl, input(), run),
    ).rejects.toThrow();
  });

  it("rejects a failed GitHub lookup", async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: "not found" }));

    await expect(
      resolveIntentAcknowledgementComment(artifact().commentUrl, input(), run),
    ).rejects.toThrow(/GitHub comment/);
  });
});
