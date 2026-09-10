import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const { resolveHostedOperator } = await import(
  pathToFileURL(resolve(".github/public-policy-acceptance/hosted-operator.mjs")).href
);
const source = "a".repeat(40);
const actor = { login: "release-owner", id: 123, type: "User" };
const run = { head_sha: source, actor };
const commit = {
  sha: source,
  author: actor,
  commit: { author: { email: "owner@example.invalid" } },
};

describe("hosted acceptance accountable operator", () => {
  it("uses the actual email associated with the same source author and dispatch actor", () => {
    expect(resolveHostedOperator(run, commit, source, actor.login)).toEqual({
      name: actor.login,
      email: "owner@example.invalid",
      githubActor: actor.login,
      githubActorId: actor.id,
      sourceCommit: source,
      identitySource: "github-associated-commit-author",
      authority: "self-asserted-disposable-test-operator",
    });
  });

  it("rejects the actual bot-email failure and malformed or missing email without substitution", () => {
    for (const email of [
      "41898282+github-actions[bot]@users.noreply.github.com",
      "owner@example.invalid\nother@example.invalid",
      "owner@example.invalid\n",
      " owner@example.invalid",
      "",
      null,
      "a".repeat(255) + "@example.invalid",
    ]) {
      expect(() =>
        resolveHostedOperator(
          run,
          { ...commit, commit: { author: { email } } },
          source,
          actor.login,
        ),
      ).toThrow(/accountable-owner email/);
    }
  });

  it("rejects missing, bot, different-account and stale-source attribution", () => {
    for (const invalid of [
      { ...commit, sha: "b".repeat(40) },
      { ...commit, author: null },
      { ...commit, author: { ...actor, type: "Bot" } },
      { ...commit, author: { ...actor, login: "different-owner" } },
      { ...commit, author: { ...actor, id: 456 } },
    ]) {
      expect(() => resolveHostedOperator(run, invalid, source, actor.login)).toThrow();
    }
    for (const invalid of [
      { ...run, head_sha: "b".repeat(40) },
      { ...run, actor: { ...actor, type: "Bot" } },
      { ...run, actor: { ...actor, id: 0 } },
      { ...run, actor: { ...actor, id: 1.5 } },
    ]) {
      expect(() => resolveHostedOperator(invalid, commit, source, actor.login)).toThrow();
    }
    expect(() => resolveHostedOperator(run, commit, source, "different-owner")).toThrow();
    expect(() => resolveHostedOperator(run, commit, source, "owner\nother")).toThrow();
    expect(() => resolveHostedOperator(run, commit, source, "release-owner\n")).toThrow();
    expect(() => resolveHostedOperator(run, commit, "main", actor.login)).toThrow();
    expect(() => resolveHostedOperator(run, commit, source + "\n", actor.login)).toThrow();
  });
});
