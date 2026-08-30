import { describe, expect, it } from "vitest";
import {
  ArtifactIntakeV1Schema,
  ArtifactIntakeV2Schema,
  artifactEvidenceRecordIdV1,
  artifactIntakeDigestV1,
  artifactIntakeDirectoryGroupsV2,
  artifactIntakeSourceGroupsV1,
  effectiveArtifactIntakeItemsV1,
  parseArtifactIntakeV1Text,
} from "../../src/trust/artifact-intake.js";

const SHA = "a".repeat(40);

interface MutableIntake {
  format: string;
  version: number;
  authority: { state: string };
  defaults: {
    accountableOwner?: string;
    [key: string]: unknown;
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
    authority: { state: "not-authority" },
    defaults: {
      accountableOwner: "platform@acme.example",
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

function mutableItem(value: MutableIntake, index: number): MutableIntake["items"][number] {
  const item = value.items[index];
  if (item === undefined) throw new Error(`expected intake item ${String(index)}`);
  return item;
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
    expect(parsed.authority).toEqual({ state: "not-authority" });
    expect(items.every((item) => !("targets" in item))).toBe(true);
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
      (value: MutableIntake) => value.items.push({ ...mutableItem(value, 0) }),
    ],
    ["missing accountable owner", (value: MutableIntake) => delete value.defaults.accountableOwner],
    ["authority claim", (value: MutableIntake) => (value.authority.state = "approved")],
    ["target authority in intake", (value: MutableIntake) => (value.defaults.targets = ["codex"])],
    [
      "item-level target authority in intake",
      (value: MutableIntake) => (mutableItem(value, 0).targets = ["codex"]),
    ],
    [
      "unobserved execution claim in intake",
      (value: MutableIntake) =>
        (mutableItem(value, 0).execution = { transport: "stdio", resolver: "npx" }),
    ],
    [
      "incomplete npm scope",
      (value: MutableIntake) => (mutableItem(value, 0).source.package = "@firecrawl"),
    ],
    [
      "mutable npm version",
      (value: MutableIntake) => (mutableItem(value, 0).source.version = "latest"),
    ],
    [
      "mutable GitHub ref",
      (value: MutableIntake) => (mutableItem(value, 1).source.commit = "main"),
    ],
    [
      "non-canonical registry URL",
      (value: MutableIntake) =>
        (mutableItem(value, 0).source.registry = "https://user@example.test/?channel=latest"),
    ],
    [
      "short registry integrity",
      (value: MutableIntake) => (mutableItem(value, 0).source.integrity = "sha512-Zg=="),
    ],
    [
      "unsafe artifact path",
      (value: MutableIntake) => (mutableItem(value, 1).source.path = "../SKILL.md"),
    ],
    ["unknown member", (value: MutableIntake) => (mutableItem(value, 0).approval = "approved")],
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

describe("ArtifactIntakeV2 directory discovery", () => {
  function discoveryIntake(): Record<string, unknown> {
    return {
      format: "aih-artifact-intake",
      version: 2,
      authority: { state: "not-authority" },
      defaults: { accountableOwner: "platform@acme.example" },
      items: [
        {
          id: "firecrawl-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "pulsemcp",
            url: "https://www.pulsemcp.com/servers/firecrawl",
          },
        },
        {
          id: "atlassian-directory",
          kind: "mcp",
          source: {
            type: "directory",
            provider: "mcpmarket",
            url: "https://mcpmarket.com/server/atlassian-jira-confluence",
          },
        },
      ],
    };
  }

  it("accepts directory-only MCP candidates without execution or authority claims", () => {
    const parsed = ArtifactIntakeV2Schema.parse(discoveryIntake());

    expect(parsed.authority).toEqual({ state: "not-authority" });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.every((item) => !Object.hasOwn(item, "targets"))).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("execution");
    expect(JSON.stringify(parsed)).not.toContain("approved");
  });

  it("deduplicates one directory lookup while preserving every requested item", () => {
    const value = discoveryIntake();
    const items = value.items as Array<Record<string, unknown>>;
    items.push({ ...items[0], id: "firecrawl-second-team" });
    const parsed = ArtifactIntakeV2Schema.parse(value);
    const groups = artifactIntakeDirectoryGroupsV2(parsed);

    expect(groups).toHaveLength(2);
    expect(
      groups.find((group) => group.source.provider === "pulsemcp")?.items.map((item) => item.id),
    ).toEqual(["firecrawl-directory", "firecrawl-second-team"]);
  });

  it.each([
    ["provider mismatch", (source: Record<string, unknown>) => (source.provider = "mcpmarket")],
    ["query-bearing URL", (source: Record<string, unknown>) => (source.url += "?ref=other")],
    ["unsupported provider", (source: Record<string, unknown>) => (source.provider = "other")],
  ])("rejects %s before directory acquisition", (_label, mutate) => {
    const value = discoveryIntake();
    const source = ((value.items as Array<Record<string, unknown>>)[0]?.source ?? {}) as Record<
      string,
      unknown
    >;
    mutate(source);
    expect(ArtifactIntakeV2Schema.safeParse(value).success).toBe(false);
  });

  it("rejects directory sources for Skills and Agents", () => {
    for (const kind of ["skill", "agent"]) {
      const value = discoveryIntake();
      const first = (value.items as Array<Record<string, unknown>>)[0];
      if (first === undefined) throw new Error("expected directory item fixture");
      first.kind = kind;
      expect(ArtifactIntakeV2Schema.safeParse(value).success).toBe(false);
    }
  });
});
