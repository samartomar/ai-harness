import { describe, expect, it } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  ISSUE_REF_RESOLUTION_EVIDENCE,
  resolveIssueRefToMergedPr,
} from "../../src/internals/release-issue-ref-resolution.js";

const GRAPHQL_ARGV_PREFIX = ["gh", "api", "graphql"];

function closedEventResponse(closers: Array<Record<string, unknown> | null>): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          issue: {
            timelineItems: {
              nodes: closers.map((closer) => ({ closer })),
            },
          },
        },
      },
    }),
  };
}

function mergedPrCloser(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: "PullRequest",
    number: 431,
    title: "feat(release): bind escalation acknowledgement to GitHub evidence",
    merged: true,
    labels: { nodes: [{ name: "semver:minor" }, { name: "area:ci" }] },
    milestone: { title: "v2.9.0" },
    ...overrides,
  };
}

describe("resolveIssueRefToMergedPr", () => {
  it("resolves through the Runner boundary with the expected graphql invocation", async () => {
    const run = fakeRunner((argv) => {
      expect(argv.slice(0, 3)).toEqual(GRAPHQL_ARGV_PREFIX);
      expect(argv).toEqual(
        expect.arrayContaining(["-F", "owner={owner}", "-F", "repo={repo}", "-F", "number=424"]),
      );
      return closedEventResponse([mergedPrCloser()]);
    });

    await expect(resolveIssueRefToMergedPr(424, run)).resolves.toEqual({
      number: 431,
      title: "feat(release): bind escalation acknowledgement to GitHub evidence",
      semverLabels: ["semver:minor"],
      milestone: "v2.9.0",
    });
  });

  it("filters non-semver labels and tolerates a missing milestone", async () => {
    const run = fakeRunner(() =>
      closedEventResponse([
        mergedPrCloser({
          labels: { nodes: [{ name: "area:ci" }] },
          milestone: null,
        }),
      ]),
    );

    await expect(resolveIssueRefToMergedPr(424, run)).resolves.toEqual({
      number: 431,
      title: "feat(release): bind escalation acknowledgement to GitHub evidence",
      semverLabels: [],
      milestone: undefined,
    });
  });

  it("rejects when the issue has no closing merged PR (zero candidates)", async () => {
    const run = fakeRunner(() => closedEventResponse([]));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(
      /has no unique closing merged PR/,
    );
  });

  it("rejects when the closer is a commit rather than a pull request", async () => {
    const run = fakeRunner(() => closedEventResponse([{ __typename: "Commit" }]));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(
      /has no unique closing merged PR/,
    );
  });

  it("rejects when the closing PR exists but was never merged", async () => {
    const run = fakeRunner(() => closedEventResponse([mergedPrCloser({ merged: false })]));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(
      /has no unique closing merged PR/,
    );
  });

  it("rejects when two distinct merged PRs both close the issue (ambiguous)", async () => {
    const run = fakeRunner(() =>
      closedEventResponse([
        mergedPrCloser({ number: 431 }),
        mergedPrCloser({ number: 500, title: "unrelated later fix" }),
      ]),
    );

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(
      /2 candidate closing merged PRs \(#431, #500\) — ambiguous/,
    );
  });

  it("dedupes repeated timeline entries for the same closing PR (reopen/reclose)", async () => {
    const run = fakeRunner(() =>
      closedEventResponse([mergedPrCloser({ number: 431 }), mergedPrCloser({ number: 431 })]),
    );

    await expect(resolveIssueRefToMergedPr(424, run)).resolves.toMatchObject({ number: 431 });
  });

  it("rejects a failed gh api call", async () => {
    const run = fakeRunner(() => ({ code: 1, stderr: "HTTP 502" }));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(/closing-PR lookup failed/);
  });

  it("rejects a spawn error (gh not found)", async () => {
    const run = fakeRunner(() => ({ code: 127, stderr: "not found", spawnError: true }));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(/closing-PR lookup failed/);
  });

  it("rejects invalid JSON from gh api", async () => {
    const run = fakeRunner(() => ({ stdout: "not json" }));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(/invalid JSON/);
  });

  it("rejects a GraphQL errors[] response", async () => {
    const run = fakeRunner(() => ({
      stdout: JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }),
    }));

    await expect(resolveIssueRefToMergedPr(424, run)).rejects.toThrow(
      /Could not resolve to a Repository/,
    );
  });

  it("exposes the evidence mechanism as a stable, descriptive constant", () => {
    expect(ISSUE_REF_RESOLUTION_EVIDENCE).toMatch(/closedEvent|CLOSED_EVENT/i);
    expect(ISSUE_REF_RESOLUTION_EVIDENCE).toMatch(/closer/i);
  });
});
