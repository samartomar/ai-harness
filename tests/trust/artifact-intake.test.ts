import { describe, expect, it } from "vitest";
import {
  ArtifactIntakeV1Schema,
  artifactEvidenceRecordIdV1,
  artifactIntakeDigestV1,
  artifactIntakeSourceGroupsV1,
  effectiveArtifactIntakeItemsV1,
  parseArtifactIntakeV1Text,
} from "../../src/trust/artifact-intake.js";

const SHA = "a".repeat(40);

interface MutableIntake {
  format: string;
  version: number;
  defaults: {
    accountableOwner?: string;
    targets: string[];
  };
  items: Array<{
    id: string;
    kind: string;
    source: Record<string, unknown>;
    [key: string]: unknown;
  }>;
}

function intake(): MutableIntake {
  return {
    format: "aih-artifact-intake",
    version: 1,
    defaults: {
      accountableOwner: "platform@acme.example",
      targets: ["codex"],
    },
    items: [
      {
        id: "firecrawl-mcp",
        kind: "mcp",
        discoveryUrl: "https://mcpmarket.com/server/firecrawl",
        source: {
          type: "npm",
          registry: "https://registry.npmjs.org",
          package: "firecrawl-mcp",
          version: "3.24.0",
        },
        execution: { transport: "stdio", resolver: "npx" },
        clarification: "Developer web research",
      },
      {
        id: "security-skill",
        kind: "skill",
        discoveryUrl: "https://skills.sh/example/security-skill",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: SHA,
          path: "skills/security/SKILL.md",
        },
      },
      {
        id: "review-agent",
        kind: "agent",
        accountableOwner: "review@acme.example",
        source: {
          type: "github",
          repository: "acme/security-assets",
          commit: SHA,
          path: "agents/reviewer.md",
        },
      },
    ],
  };
}

describe("ArtifactIntakeV1", () => {
  it("accepts one attributable batch spanning MCP, Skill, and Agent sources", () => {
    const parsed = ArtifactIntakeV1Schema.parse(intake());
    const items = effectiveArtifactIntakeItemsV1(parsed);

    expect(items.map((item) => item.kind)).toEqual(["mcp", "skill", "agent"]);
    expect(items.map((item) => item.accountableOwner)).toEqual([
      "platform@acme.example",
      "platform@acme.example",
      "review@acme.example",
    ]);
    expect(items.every((item) => item.targets[0] === "codex")).toBe(true);
  });

  it("treats marketplace URLs as optional discovery context, never source identity", () => {
    const parsed = ArtifactIntakeV1Schema.parse(intake());
    const first = parsed.items[0];
    if (first === undefined) throw new Error("expected MCP intake item");

    expect(first.discoveryUrl).toBe("https://mcpmarket.com/server/firecrawl");
    expect(first.source).toEqual({
      type: "npm",
      registry: "https://registry.npmjs.org",
      package: "firecrawl-mcp",
      version: "3.24.0",
    });
  });

  it("groups duplicate acquisition sources once while preserving distinct requested items", () => {
    const parsed = ArtifactIntakeV1Schema.parse(intake());
    const groups = artifactIntakeSourceGroupsV1(parsed);

    expect(groups).toHaveLength(2);
    expect(
      groups.find((group) => group.source.type === "github")?.items.map((item) => item.id),
    ).toEqual(["review-agent", "security-skill"]);
  });

  it("produces a deterministic intake digest and source-bound evidence identifiers", () => {
    const first = ArtifactIntakeV1Schema.parse(intake());
    const reordered = ArtifactIntakeV1Schema.parse({
      ...intake(),
      items: [...first.items].reverse(),
    });
    const digest = artifactIntakeDigestV1(first);

    expect(digest).toBe(artifactIntakeDigestV1(reordered));
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(artifactEvidenceRecordIdV1("firecrawl-mcp", digest)).toMatch(
      /^scan-firecrawl-mcp-[a-f0-9]{12}$/,
    );
  });

  it.each([
    [
      "duplicate item identifiers",
      (value: MutableIntake) => value.items.push({ ...value.items[0] }),
    ],
    ["missing accountable owner", (value: MutableIntake) => delete value.defaults.accountableOwner],
    [
      "incomplete npm scope",
      (value: MutableIntake) => (value.items[0].source.package = "@firecrawl"),
    ],
    ["mutable npm version", (value: MutableIntake) => (value.items[0].source.version = "latest")],
    ["mutable GitHub ref", (value: MutableIntake) => (value.items[1].source.commit = "main")],
    [
      "unsafe artifact path",
      (value: MutableIntake) => (value.items[1].source.path = "../SKILL.md"),
    ],
    ["unknown member", (value: MutableIntake) => (value.items[0].approval = "approved")],
  ])("rejects %s before any source acquisition", (_label, mutate) => {
    const value = intake();
    mutate(value);
    expect(ArtifactIntakeV1Schema.safeParse(value).success).toBe(false);
  });

  it("rejects duplicate JSON members instead of accepting the last value", () => {
    expect(() =>
      parseArtifactIntakeV1Text(
        '{"format":"aih-artifact-intake","format":"other","version":1,"items":[]}',
      ),
    ).toThrow(/duplicate JSON object key/i);
  });
});
