import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CapabilityIdSchema } from "../../src/capability/id.js";
import {
  type ChangeFact,
  classifyChangeProfile,
  renderChangeProfile,
  serializeChangeProfile,
} from "../../src/profile/change-profile.js";
import {
  CHANGE_PROFILE_RULE_TABLE_VERSION,
  CHANGE_PROFILE_RULES,
} from "../../src/profile/change-profile-rules.js";

const text = (value: string) => ({
  kind: "text" as const,
  text: value,
  byteLength: Buffer.byteLength(value),
});

function classify(changes: ChangeFact[]) {
  return classifyChangeProfile({ schemaVersion: 1, source: "worktree", changes });
}

function added(path: string, value = "content"): ChangeFact {
  return {
    scope: "staged",
    status: "added",
    path,
    previousPath: null,
    before: null,
    after: text(value),
  };
}

function ids(profile: ReturnType<typeof classify>, category: keyof ReturnType<typeof classify>) {
  const value = profile[category];
  return Array.isArray(value) ? value.map((item) => item.id) : [];
}

describe("change-profile rule table", () => {
  it("is deeply frozen with unique IDs and ordinals", () => {
    expect(CHANGE_PROFILE_RULE_TABLE_VERSION).toBe("1.0.0");
    expect(Object.isFrozen(CHANGE_PROFILE_RULES)).toBe(true);
    expect(CHANGE_PROFILE_RULES.every((rule) => Object.isFrozen(rule))).toBe(true);
    expect(new Set(CHANGE_PROFILE_RULES.map((rule) => rule.id)).size).toBe(
      CHANGE_PROFILE_RULES.length,
    );
    expect(new Set(CHANGE_PROFILE_RULES.map((rule) => rule.ordinal)).size).toBe(
      CHANGE_PROFILE_RULES.length,
    );
    for (const rule of CHANGE_PROFILE_RULES) {
      expect(CapabilityIdSchema.safeParse(rule.id).success).toBe(true);
    }
  });

  it("emits baseline and path-based language, generic, and risk rules", () => {
    const profile = classify([
      added("src/view.tsx"),
      added("service/main.py"),
      added("api/openapi.yaml"),
      added("db/migrations/001.sql"),
      added(".github/workflows/ci.yml"),
      added("infra/main.tf"),
      added("tests/view.spec.ts"),
      added("README.md"),
      added("scripts/release.sh"),
    ]);
    expect(ids(profile, "baseline")).toEqual([
      "review.correctness",
      "review.maintainability",
      "review.verification",
    ]);
    expect(ids(profile, "overlays")).toEqual(
      expect.arrayContaining(["language.typescript", "language.python"]),
    );
    expect(ids(profile, "triggers")).toEqual(
      expect.arrayContaining([
        "risk.api-contract",
        "risk.database",
        "risk.infrastructure",
        "risk.ci",
        "surface.tests",
        "surface.documentation",
        "surface.scripts",
      ]),
    );
    expect(ids(profile, "escalations")).toContain("framework.ui-ambiguous");
  });

  it("infers frameworks only from changed valid package.json and go.mod", () => {
    const profile = classify([
      added("package.json", JSON.stringify({ dependencies: { react: "1", express: "1" } })),
      added("go.mod", "module example.com/demo\nrequire github.com/gin-gonic/gin v1.9.0\n"),
      added("cdk.json", "{}"),
      added("samconfig.toml", ""),
      added("serverless.yml", ""),
    ]);
    expect(ids(profile, "overlays")).toEqual(
      expect.arrayContaining([
        "framework.react",
        "framework.express",
        "framework.gin",
        "framework.aws-cdk",
        "framework.aws-sam",
        "framework.serverless",
      ]),
    );
    const malformed = classify([added("package.json", "{"), added("go.mod", "not a module")]);
    expect(ids(malformed, "escalations")).toContain("manifest.malformed");
    expect(ids(malformed, "overlays")).not.toContain("framework.react");
    expect(ids(malformed, "overlays")).not.toContain("framework.gin");
    for (const value of [[], null, { dependencies: "react" }, { devDependencies: ["react"] }]) {
      const invalid = classify([added("package.json", JSON.stringify(value))]);
      expect(ids(invalid, "escalations")).toContain("manifest.malformed");
      expect(ids(invalid, "overlays")).not.toContain("framework.react");
    }
  });

  it("keeps UI ambiguity when only non-UI frameworks are present", () => {
    const profile = classify([added("src/view.tsx"), added("cdk.json", "{}")]);
    expect(ids(profile, "overlays")).toContain("framework.aws-cdk");
    expect(ids(profile, "escalations")).toContain("framework.ui-ambiguous");
  });

  it("handles all statuses/scopes and unavailable content without arbitrary token scanning", () => {
    const facts: ChangeFact[] = [
      added("src/a.ts"),
      { ...added("src/b.js"), scope: "unstaged", status: "modified", before: text("a") },
      { ...added("src/c.py"), scope: "untracked" },
      { ...added("src/d.go"), status: "deleted", before: text("a"), after: null },
      { ...added("src/new.rs"), status: "renamed", previousPath: "src/old.rs", before: text("a") },
      { ...added("assets/a.bin"), after: { kind: "binary", byteLength: 10 } },
      { ...added("vendor/mod"), after: { kind: "submodule", revision: "a".repeat(40) } },
      { ...added("private.txt"), after: { kind: "unreadable", reason: "io-error" } },
      { ...added("large.txt"), after: { kind: "oversized", byteLength: 300_000 } },
      { ...added("mystery.txt"), after: { kind: "unknown", code: "gatherer-gap" } },
      added("notes.txt", "password security terraform migration"),
    ];
    const profile = classify(facts);
    expect(ids(profile, "escalations")).toEqual(
      expect.arrayContaining([
        "content.binary",
        "content.submodule-unclassified",
        "content.unreadable",
        "content.oversized",
        "content.unknown",
      ]),
    );
    expect(ids(profile, "triggers")).toContain("risk.dependencies");
    expect(ids(profile, "triggers")).toContain("surface.unknown");
    expect(ids(profile, "triggers")).not.toContain("risk.security");
    const unknown = profile.escalations.find((item) => item.id === "content.unknown");
    expect(unknown?.reasons[0]?.signal).toBe("unknown:gatherer-gap");
    expect(unknown?.evidence[0]?.signal).toBe("unknown:gatherer-gap");
  });

  it("emits denied-path security evidence, dedupes evidence, and rejects near misses", () => {
    const denied = classify([
      {
        ...added("secrets/token"),
        after: { kind: "unreadable", reason: "policy-denied" },
      },
    ]);
    const security = denied.triggers.find((item) => item.id === "risk.security");
    expect(security?.evidence).toEqual([
      { ruleId: "risk.security", path: "secrets/token", side: "change", signal: "denied-path" },
    ]);

    const deleted = {
      ...added("README.md"),
      status: "deleted" as const,
      before: text("old"),
      after: null,
    };
    const readd = {
      ...deleted,
      scope: "untracked" as const,
      status: "added" as const,
      before: null,
      after: text("new"),
    };
    const documentation = classify([deleted, readd]).triggers.find(
      (item) => item.id === "surface.documentation",
    );
    expect(documentation?.reasons).toHaveLength(2);
    expect(documentation?.evidence).toHaveLength(1);
    expect(ids(classify([added("src/authors/list.ts")]), "triggers")).not.toContain(
      "risk.security",
    );
    expect(ids(classify([added("src/secrets/token.ts")]), "triggers")).not.toContain(
      "risk.security",
    );
  });

  it("keeps classifier imports inside the pure static boundary", () => {
    const source = readFileSync("src/profile/change-profile.ts", "utf8");
    const rules = readFileSync("src/profile/change-profile-rules.ts", "utf8");
    const modules = [...`${source}\n${rules}`.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(modules).toEqual([
      "node:crypto",
      "zod",
      "../capability/id.js",
      "../errors.js",
      "./change-profile-rules.js",
    ]);
  });

  it("uses the pinned architecture exclusion only for low-risk inspectable changes", () => {
    const low = classify([added("src/value.ts")]);
    expect(ids(low, "exclusions")).toContain("review.architecture");
    const risky = classify([added("infra/main.tf")]);
    expect(ids(risky, "exclusions")).not.toContain("review.architecture");
  });

  it("orders output stably and is independent of clock, randomness, and environment", () => {
    const facts = [added("z.py"), added("a.ts")];
    const previousNow = Date.now;
    const previousRandom = Math.random;
    const previousEnv = process.env.AIH_CHANGE_PROFILE_TEST;
    Date.now = () => 1;
    Math.random = () => 0.1;
    process.env.AIH_CHANGE_PROFILE_TEST = "one";
    const first = classify(facts);
    Date.now = () => 999;
    Math.random = () => 0.9;
    process.env.AIH_CHANGE_PROFILE_TEST = "two";
    const second = classify([...facts].reverse());
    Date.now = previousNow;
    Math.random = previousRandom;
    if (previousEnv === undefined) delete process.env.AIH_CHANGE_PROFILE_TEST;
    else process.env.AIH_CHANGE_PROFILE_TEST = previousEnv;
    expect(serializeChangeProfile(first)).toBe(serializeChangeProfile(second));
    expect(renderChangeProfile(first)).toBe(renderChangeProfile(second));
    expect(first.inputIdentity).toBe(
      "c4aa3ff690cc61148ed5005cf44187f97fbea5a35fce7d88c0c7bce90f336d70",
    );
  });
});
