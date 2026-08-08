import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BaselineAuthorization,
  BaselineHeldComponent,
} from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import { walkManagedRoot } from "../../src/ecc/install-manifest.js";
import {
  applyEccMaterialization,
  eccMaterializationReceiptPath,
  uninstallEccMaterialization,
} from "../../src/ecc/materialization.js";
import { readEccMaterializationReceipt } from "../../src/ecc/materialization-receipt.js";
import {
  type EccEffectiveSelectionComponent,
  resolveEccMaterializationSelection,
} from "../../src/ecc/materialization-selection.js";
import {
  type EccClaudeMaterializationResult,
  resolveEccClaudeMaterialization,
} from "../../src/ecc/materialization-target-claude.js";
import { eccComponentSourcePaths } from "../../src/ecc/materialize.js";
import { resolveEffectiveOrgPolicy } from "../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

/**
 * Bytes with an embedded zero byte and a byte outside UTF-8, so a destination
 * that matches proves the adapter carried bytes rather than round-tripping text.
 */
const BINARY_ASSET = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);

/** The pinned framework checkout, shaped like the real one for the paths under test. */
const SOURCE_TREE: Readonly<Record<string, string | Buffer>> = {
  "agents/code-reviewer.md": "# code-reviewer\n",
  "agents/planner.md": "# planner\n",
  "skills/tdd-workflow/SKILL.md": "# tdd-workflow\n",
  "skills/tdd-workflow/assets/marker.bin": BINARY_ASSET,
  ".agents/skills/tdd-workflow/SKILL.md": "# tdd-workflow (agent copy)\n",
  "rules/README.md": "# rules\n",
  "rules/common/coding-style.md": "# coding style\n",
  ".mcp.json": '{"mcpServers":{}}\n',
  "mcp-configs/mcp-servers.json": '{"servers":{}}\n',
  "hooks/hooks.json": '{"hooks":{}}\n',
  "scripts/hooks/run-with-flags.js": "// hook launcher\n",
  "scripts/lib/utils.js": "// util\n",
};

function writeSource(root: string, tree: Readonly<Record<string, string | Buffer>>): void {
  for (const [path, contents] of Object.entries(tree)) {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

function authorization(componentId: string): BaselineAuthorization {
  return {
    componentId,
    source: REPOSITORY,
    pinnedSha: COMMIT,
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/harness release",
    evidenceSha256: "c".repeat(64),
  };
}

function selected(id: string, path: string): EccEffectiveSelectionComponent {
  return {
    id: id as EccComponentId,
    authorization: authorization(id),
    provenance: { repository: REPOSITORY, commit: COMMIT, componentPath: path },
  };
}

function refusalFor(result: EccClaudeMaterializationResult, id: string) {
  return result.refused.find((entry) => entry.id === id);
}

function destinations(result: EccClaudeMaterializationResult, id: string): string[] {
  return (result.components.find((component) => component.id === id)?.files ?? [])
    .map((file) => file.path)
    .sort();
}

describe("the Claude target adapter maps evidence-passed components onto owned destinations", () => {
  let sourceRoot: string;

  beforeEach(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-claude-source-"));
    writeSource(sourceRoot, SOURCE_TREE);
  });

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("maps an agent, a skill, and the rules baseline to their Claude destinations", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
      ],
    });

    expect(result.refused).toEqual([]);
    expect(destinations(result, "agent:code-reviewer")).toEqual([
      ".claude/agents/code-reviewer.md",
    ]);
    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
    ]);
    expect(destinations(result, "baseline:rules")).toEqual([
      ".claude/rules/README.md",
      ".claude/rules/common/coding-style.md",
    ]);
  });

  it("carries the exact source bytes, including a file that is not text", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("skill:tdd-workflow", "skills/tdd-workflow")],
    });

    const files = result.components[0]?.files ?? [];
    const asset = files.find((file) => file.path.endsWith("marker.bin"));
    const skill = files.find((file) => file.path === ".claude/skills/tdd-workflow/SKILL.md");
    expect(Buffer.from(asset?.contents ?? "").equals(BINARY_ASSET)).toBe(true);
    expect(Buffer.from(skill?.contents ?? "").toString("utf8")).toBe("# tdd-workflow\n");
  });

  it("owns every mapped destination as a whole file, never as named JSON keys", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
      ],
    });

    const kinds = result.components.flatMap((component) =>
      component.files.map((file) => file.kind),
    );
    // The positive control: the assertion below is over a populated list, so it
    // cannot pass because nothing was mapped.
    expect(kinds.length).toBe(6);
    expect([...new Set(kinds)]).toEqual(["copy-file"]);
  });

  it("carries the resolver's authorization tuple and provenance through unchanged", () => {
    const component = selected("agent:code-reviewer", "agents/code-reviewer.md");
    const result = resolveEccClaudeMaterialization({ sourceRoot, components: [component] });

    expect(result.components[0]?.authorization).toEqual(component.authorization);
    expect(result.components[0]?.provenance).toEqual(component.provenance);
  });

  it("refuses a component whose content lands on the MCP surface AIH owns elsewhere", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [
        selected("mcp:github", "mcp-configs/mcp-servers.json"),
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    });

    // Positive control first: the passing component still maps, so the refusal
    // below is a decision about mcp:github and not an empty run.
    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(refusalFor(result, "mcp:github")?.reason).toBe("unowned-destination");
    expect(refusalFor(result, "mcp:github")?.detail).toContain(".mcp.json");
  });

  it("refuses a component whose content is host hook material", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("baseline:hooks", "hooks")],
    });

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "baseline:hooks")?.reason).toBe("unowned-destination");
    expect(refusalFor(result, "baseline:hooks")?.detail).toContain("hooks/hooks.json");
  });

  it("refuses a component AIH has no install descriptor for", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("skill:not-a-real-skill", "skills/not-a-real-skill")],
    });

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "skill:not-a-real-skill")?.reason).toBe("no-install-descriptor");
  });

  it("refuses a component the pinned source root does not carry", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("agent:never-shipped", "agents/never-shipped.md")],
    });

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "agent:never-shipped")?.reason).toBe("missing-source");
    expect(refusalFor(result, "agent:never-shipped")?.detail).toContain("agents/never-shipped.md");
  });

  it("refuses a component whose declared source paths hold no files at all", () => {
    for (const declared of eccComponentSourcePaths("skill:coding-standards")) {
      mkdirSync(join(sourceRoot, ...declared.split("/")), { recursive: true });
    }

    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("skill:coding-standards", "skills/coding-standards")],
    });

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "skill:coding-standards")?.reason).toBe("missing-source");
    expect(refusalFor(result, "skill:coding-standards")?.detail).toContain(
      "skill:coding-standards",
    );
  });

  it("refuses a source file larger than this lifecycle materializes", () => {
    writeFileSync(
      join(sourceRoot, "agents", "oversized.md"),
      Buffer.alloc(4 * 1024 * 1024 + 1, 0x61),
    );

    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [
        selected("agent:oversized", "agents/oversized.md"),
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    });

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(refusalFor(result, "agent:oversized")?.reason).toBe("unreadable-source");
  });

  it("refuses a source root that is not an absolute real directory", () => {
    expect(() =>
      resolveEccClaudeMaterialization({ sourceRoot: "relative/ecc", components: [] }),
    ).toThrowError(/absolute path/);
    expect(() =>
      resolveEccClaudeMaterialization({
        sourceRoot: join(sourceRoot, "agents", "code-reviewer.md"),
        components: [],
      }),
    ).toThrowError(/not a real directory/);
  });
});

describe("the Claude target adapter refuses another target's home-scoped destinations", () => {
  let sourceRoot: string;

  beforeEach(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-claude-platform-"));
    // Every declared platform path present, so the refusal below is about the
    // destination and not about a path the pinned root happens to lack.
    for (const declared of eccComponentSourcePaths("baseline:platform")) {
      mkdirSync(join(sourceRoot, ...declared.split("/")), { recursive: true });
    }
    writeFileSync(join(sourceRoot, ".codex", "AGENTS.md"), "# codex agents\n");
  });

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
  });

  it("refuses a source whose only owned destination belongs to another runtime's home", () => {
    const result = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("baseline:platform", ".claude-plugin")],
    });

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "baseline:platform")?.reason).toBe("unowned-destination");
    expect(refusalFor(result, "baseline:platform")?.detail).toContain(".codex/AGENTS.md");
  });
});

interface SelectionFixture {
  kind: string;
  id: string;
  path: string;
}

const PASSED: readonly SelectionFixture[] = [
  { kind: "agent", id: "agent:code-reviewer", path: "agents/code-reviewer.md" },
  { kind: "skill", id: "skill:tdd-workflow", path: "skills/tdd-workflow" },
  { kind: "baseline", id: "baseline:rules", path: "rules" },
];
const BLOCKED: SelectionFixture = {
  kind: "agent",
  id: "agent:planner",
  path: "agents/planner.md",
};
const MCP: SelectionFixture = {
  kind: "mcp",
  id: "mcp:github",
  path: "mcp-configs/mcp-servers.json",
};

/** A real policy document, parsed by the real entry point — never a policy-shaped object. */
function policyDocument(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-07.1",
      supportedClis: ["claude"],
      catalog: { reviewed: [], custom: [] },
      externalSelections: [
        {
          framework: "ecc",
          items: [...PASSED, BLOCKED, MCP].map((item) => ({
            kind: item.kind,
            id: item.id,
            source: { repository: REPOSITORY, commit: COMMIT, path: item.path },
          })),
        },
      ],
    },
  };
}

function held(componentId: string): BaselineHeldComponent {
  return {
    componentId,
    routeCode: "baseline.evidence-blocked",
    codes: ["malicious-code"],
    details: [`${componentId} is blocked by signed evidence (malicious-code)`],
  };
}

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const path of walkManagedRoot(root)) {
    entries[path] = createHash("sha256")
      .update(readFileSync(join(root, ...path.split("/"))))
      .digest("hex");
  }
  return entries;
}

describe("selection to evidence to AIH-direct materialization, end to end on a fixture root", () => {
  let sourceRoot: string;
  let root: string;

  beforeEach(() => {
    sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-claude-e2e-source-"));
    writeSource(sourceRoot, SOURCE_TREE);
    root = mkdtempSync(join(tmpdir(), "aih-ecc-claude-e2e-root-"));
    writeSource(root, {
      // Operator content: the client settings file this lifecycle deliberately
      // does not own, a hand-written agent beside the ones AIH will write, and
      // an unrelated file.
      ".claude/settings.json": '{\n    "env": {"OPERATOR": "1"}\n}\n',
      ".claude/agents/operator-agent.md": "# my own agent\n",
      "notes/OPERATOR.md": "# keep me\n",
    });
  });

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function chain(): EccClaudeMaterializationResult {
    const policy = resolveEffectiveOrgPolicy(parseOrgPolicy(policyDocument()));
    const selection = resolveEccMaterializationSelection(policy, {
      authorizations: [...PASSED, MCP].map((item) => authorization(item.id)),
      held: [held(BLOCKED.id)],
    });
    expect(selection.included.map((component) => component.id)).toEqual([
      ...PASSED.map((item) => item.id),
      MCP.id,
    ]);
    expect(selection.excluded.map((entry) => entry.reason)).toEqual(["vet-blocked"]);
    return resolveEccClaudeMaterialization({ sourceRoot, components: selection.included });
  }

  it("materializes exactly the evidence-passed, Claude-owned components", () => {
    const target = chain();
    expect(target.refused.map((entry) => entry.id)).toEqual([MCP.id]);

    const result = applyEccMaterialization({ root, components: target.components });

    // Positive control: the components that should land, did, with the source bytes.
    for (const [source, destination] of [
      ["agents/code-reviewer.md", ".claude/agents/code-reviewer.md"],
      ["skills/tdd-workflow/SKILL.md", ".claude/skills/tdd-workflow/SKILL.md"],
      ["skills/tdd-workflow/assets/marker.bin", ".claude/skills/tdd-workflow/assets/marker.bin"],
      [".agents/skills/tdd-workflow/SKILL.md", ".agents/skills/tdd-workflow/SKILL.md"],
      ["rules/README.md", ".claude/rules/README.md"],
      ["rules/common/coding-style.md", ".claude/rules/common/coding-style.md"],
    ] as const) {
      expect(
        readFileSync(join(root, ...destination.split("/"))).equals(
          readFileSync(join(sourceRoot, ...source.split("/"))),
        ),
      ).toBe(true);
    }
    expect(result.written).toHaveLength(6);

    // The vet-blocked component never reaches a destination.
    expect(existsSync(join(root, ".claude", "agents", "planner.md"))).toBe(false);
    // Neither does the component this target does not own.
    expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(root, "mcp-configs"))).toBe(false);

    const receipt = readEccMaterializationReceipt(root);
    expect(receipt.state).toBe("valid");
    if (receipt.state !== "valid") throw new Error("expected a valid receipt");
    expect(receipt.receipt.components.map((component) => component.id)).toEqual(
      [...PASSED.map((item) => item.id)].sort(),
    );
    const operations = receipt.receipt.components.flatMap((component) =>
      component.files.map((file) => file.operation),
    );
    expect(operations).toHaveLength(6);
    expect([...new Set(operations)]).toEqual(["copy-file"]);
  });

  it("is byte-identical on a second apply", () => {
    applyEccMaterialization({ root, components: chain().components });
    const first = snapshot(root);
    expect(Object.keys(first).length).toBeGreaterThan(6);

    const second = applyEccMaterialization({ root, components: chain().components });

    expect(snapshot(root)).toEqual(first);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(6);
  });

  it("uninstalls what it owns and leaves operator content byte-identical", () => {
    const operator = {
      ".claude/settings.json": readFileSync(join(root, ".claude", "settings.json")),
      ".claude/agents/operator-agent.md": readFileSync(
        join(root, ".claude", "agents", "operator-agent.md"),
      ),
      "notes/OPERATOR.md": readFileSync(join(root, "notes", "OPERATOR.md")),
    };
    applyEccMaterialization({ root, components: chain().components });
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(true);

    const removed = uninstallEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed).toHaveLength(6);
    for (const destination of [
      ".claude/agents/code-reviewer.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/rules/README.md",
      ".claude/rules/common/coding-style.md",
    ]) {
      expect(existsSync(join(root, ...destination.split("/")))).toBe(false);
    }
    expect(existsSync(eccMaterializationReceiptPath(root))).toBe(false);
    for (const [path, bytes] of Object.entries(operator)) {
      expect(readFileSync(join(root, ...path.split("/"))).equals(bytes)).toBe(true);
    }
  });
});
