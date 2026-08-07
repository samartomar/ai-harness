import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentId } from "../../src/ecc/components.js";
import { walkManagedRoot } from "../../src/ecc/install-manifest.js";
import {
  applyEccMaterialization,
  uninstallEccMaterialization,
} from "../../src/ecc/materialization.js";
import { readEccMaterializationReceipt } from "../../src/ecc/materialization-receipt.js";
import type { EccEffectiveSelectionComponent } from "../../src/ecc/materialization-selection.js";
import {
  assertGovernedMaterializationTargets,
  type EccMaterializationTarget,
  type EccTargetMaterializationResult,
  foldedDestinationCollision,
  GOVERNED_MATERIALIZATION_TARGETS,
  resolveEccTargetMaterialization,
  WIRED_MATERIALIZATION_TARGETS,
} from "../../src/ecc/materialization-target.js";
import { resolveEccClaudeMaterialization } from "../../src/ecc/materialization-target-claude.js";
import {
  classifyGovernedEccOperation,
  eccComponentSourcePaths,
  eccContentDestinationMapping,
} from "../../src/ecc/materialize.js";

/**
 * F4, the targets past the first: Codex and Kimi, and the seam that made them
 * one resolver instead of a copy of the Claude one apiece.
 *
 * The Claude suite (`materialization-target-claude.test.ts`) still pins the
 * single-target binding exactly as it shipped. This file pins what the
 * generalization added: each further target's destinations, the refusals that
 * keep their per-target voice, the union a multi-target request produces in ONE
 * receipt, and the two refusals that decide whether a target is a governed
 * materialization target at all.
 *
 * Everything runs against temporary fixture roots — never a real checkout.
 */

const COMMIT = "a".repeat(40);
const REPOSITORY = "affaan-m/ECC";

/**
 * Bytes with an embedded zero byte and a byte outside UTF-8, so a destination
 * that matches proves the adapter carried bytes rather than round-tripping text.
 */
const BINARY_ASSET = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);

const SOURCE_TREE: Readonly<Record<string, string | Buffer>> = {
  "AGENTS.md": "# agents bootloader\n",
  ".agents/plugins/marketplace.json": '{"plugins":[]}\n',
  "agents/code-reviewer.md": "# code-reviewer\n",
  "skills/tdd-workflow/SKILL.md": "# tdd-workflow\n",
  "skills/tdd-workflow/assets/marker.bin": BINARY_ASSET,
  ".agents/skills/tdd-workflow/SKILL.md": "# tdd-workflow (agent copy)\n",
  "rules/README.md": "# rules\n",
  "rules/common/coding-style.md": "# coding style\n",
  ".mcp.json": '{"mcpServers":{}}\n',
  "mcp-configs/mcp-servers.json": '{"servers":{}}\n',
  "hooks/hooks.json": '{"hooks":{}}\n',
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

function destinations(result: EccTargetMaterializationResult, id: string): string[] {
  return (result.components.find((component) => component.id === id)?.files ?? [])
    .map((file) => file.path)
    .sort();
}

function refusalFor(result: EccTargetMaterializationResult, id: string, target: string) {
  return result.refused.find((entry) => entry.id === id && entry.target === target);
}

let sourceRoot: string;

beforeEach(() => {
  sourceRoot = mkdtempSync(join(tmpdir(), "aih-ecc-target-source-"));
  writeSource(sourceRoot, SOURCE_TREE);
});

afterEach(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

function resolve(
  targets: readonly EccMaterializationTarget[],
  components: readonly EccEffectiveSelectionComponent[],
): EccTargetMaterializationResult {
  return resolveEccTargetMaterialization({ sourceRoot, targets, components });
}

describe("the Codex target maps evidence-passed components onto the Codex project rows", () => {
  it("maps an agent, a skill, and the rules baseline under .codex/", () => {
    const result = resolve(
      ["codex"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
      ],
    );

    expect(result.refused).toEqual([]);
    expect(destinations(result, "agent:code-reviewer")).toEqual([".codex/agents/code-reviewer.md"]);
    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // The shared row is every target's; only the tool-owned rows carry the
      // target's own directory.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".codex/skills/tdd-workflow/SKILL.md",
      ".codex/skills/tdd-workflow/assets/marker.bin",
    ]);
    expect(destinations(result, "baseline:rules")).toEqual([
      ".codex/rules/README.md",
      ".codex/rules/common/coding-style.md",
    ]);
  });

  it("carries the exact source bytes for Codex, including a file that is not text", () => {
    const result = resolve(["codex"], [selected("skill:tdd-workflow", "skills/tdd-workflow")]);

    const files = result.components[0]?.files ?? [];
    const asset = files.find(
      (file) => file.path === ".codex/skills/tdd-workflow/assets/marker.bin",
    );
    const skill = files.find((file) => file.path === ".codex/skills/tdd-workflow/SKILL.md");
    expect(Buffer.from(asset?.contents ?? "").equals(BINARY_ASSET)).toBe(true);
    expect(Buffer.from(skill?.contents ?? "").toString("utf8")).toBe("# tdd-workflow\n");
    expect([...new Set(files.map((file) => file.kind))]).toEqual(["copy-file"]);
  });

  it("refuses by name, in the Codex target's own voice, what Codex does not own", () => {
    const result = resolve(
      ["codex"],
      [
        selected("mcp:github", "mcp-configs/mcp-servers.json"),
        selected("baseline:hooks", "hooks"),
        // Positive control: the run is not empty, so the refusals below are
        // decisions and not an adapter that mapped nothing.
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(refusalFor(result, "mcp:github", "codex")).toEqual({
      target: "codex",
      id: "mcp:github",
      reason: "unowned-destination",
      detail: "the Codex target owns no content destination for .mcp.json",
    });
    expect(refusalFor(result, "baseline:hooks", "codex")?.detail).toContain("hooks/hooks.json");
  });

  it("keeps refusing the home-scoped Codex bootloader — the governed root is the project root", () => {
    // Every declared platform path present, so the refusal is about the
    // destination and not a path the pinned root happens to lack.
    for (const declared of eccComponentSourcePaths("baseline:platform")) {
      mkdirSync(join(sourceRoot, ...declared.split("/")), { recursive: true });
    }
    writeFileSync(join(sourceRoot, ".codex", "AGENTS.md"), "# codex agents\n");

    const result = resolve(["codex"], [selected("baseline:platform", ".claude-plugin")]);

    expect(result.components).toEqual([]);
    expect(refusalFor(result, "baseline:platform", "codex")?.reason).toBe("unowned-destination");
    expect(refusalFor(result, "baseline:platform", "codex")?.detail).toContain(".codex/AGENTS.md");
  });

  it("leaves the Claude binding's single-target result shape and text untouched", () => {
    const claude = resolveEccClaudeMaterialization({
      sourceRoot,
      components: [selected("mcp:github", "mcp-configs/mcp-servers.json")],
    });

    // No `target` key: the single-target result carries no information it could
    // put there, and the acceptance journey pins this object exactly.
    expect(claude.refused).toEqual([
      {
        id: "mcp:github",
        reason: "unowned-destination",
        detail: "the Claude target owns no content destination for .mcp.json",
      },
    ]);
  });
});

/**
 * F4, third target: Kimi, whose project root is the one that is NOT `.<target>`.
 *
 * Upstream's own Kimi adapter roots the project install at `.kimi-code`
 * (`scripts/lib/install-targets/kimi-project.js`: `kind: 'project'`,
 * `rootSegments: ['.kimi-code']`) and keeps its install state inside that root.
 * The generic scaffold there is `join(targetRoot, sourceRelativePath)`, which is
 * what the four content classes below preserve. Two upstream shapes are recorded
 * and deliberately NOT imitated: upstream special-cases `.agents/skills` into
 * `<root>/skills`, while this lifecycle keeps that row shared at the project
 * root for every target; and upstream syncs a `.kimi/` source as root children
 * rather than recreating the directory it calls obsolete compat docs, which this
 * copy-file-only lifecycle cannot express and therefore refuses.
 */
describe("the Kimi target maps evidence-passed components onto the .kimi-code project rows", () => {
  it("maps an agent, a skill, and the rules baseline under .kimi-code/", () => {
    const result = resolve(
      ["kimi"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
      ],
    );

    expect(result.refused).toEqual([]);
    // `.kimi-code`, never the `.kimi` the parameterized root would produce.
    expect(destinations(result, "agent:code-reviewer")).toEqual([
      ".kimi-code/agents/code-reviewer.md",
    ]);
    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // The shared row stays shared: it is NOT duplicated into `.kimi-code/`,
      // which is where upstream's own adapter puts it and this one does not.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".kimi-code/skills/tdd-workflow/SKILL.md",
      ".kimi-code/skills/tdd-workflow/assets/marker.bin",
    ]);
    expect(destinations(result, "baseline:rules")).toEqual([
      ".kimi-code/rules/README.md",
      ".kimi-code/rules/common/coding-style.md",
    ]);
    // Source paths are preserved verbatim below the root — no flattening and no
    // renaming, exactly as upstream's `join(targetRoot, sourceRelativePath)`.
    expect(destinations(result, "skill:tdd-workflow")).not.toContain(
      ".kimi-code/skills/tdd-workflow-assets-marker.bin",
    );
  });

  it("refuses by name, in the Kimi target's own voice, what Kimi does not own", () => {
    const result = resolve(
      ["kimi"],
      [
        selected("mcp:github", "mcp-configs/mcp-servers.json"),
        selected("baseline:hooks", "hooks"),
        // Positive control: the run is not empty, so the refusals below are
        // decisions and not an adapter that mapped nothing.
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(refusalFor(result, "mcp:github", "kimi")).toEqual({
      target: "kimi",
      id: "mcp:github",
      reason: "unowned-destination",
      detail: "the Kimi target owns no content destination for .mcp.json",
    });
    expect(refusalFor(result, "baseline:hooks", "kimi")?.detail).toContain("hooks/hooks.json");
  });

  it("refuses a `.kimi/`-sourced platform component for every target, Kimi included", () => {
    // Every declared platform path present, so the refusal is about the
    // destination and not a path the pinned root happens to lack. The platform
    // roots that sort ahead of `.kimi` are all empty here, so `.kimi/` holds the
    // first file the walk reaches and is the source the refusal must name.
    for (const declared of eccComponentSourcePaths("baseline:platform")) {
      mkdirSync(join(sourceRoot, ...declared.split("/")), { recursive: true });
    }
    writeFileSync(join(sourceRoot, ".kimi", "compat-docs.md"), "# obsolete compat docs\n");

    const result = resolve(
      ["claude", "kimi"],
      [
        selected("baseline:platform", ".claude-plugin"),
        // Positive control: the run is not empty.
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    for (const target of ["claude", "kimi"] as const) {
      const refusal = refusalFor(result, "baseline:platform", target);
      expect(refusal?.reason, target).toBe("unowned-destination");
      expect(refusal?.detail, target).toContain(".kimi/compat-docs.md");
    }
  });

  it("unions Claude and Kimi into one set with the shared rows written once", () => {
    const result = resolve(
      ["claude", "kimi"],
      [
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // Once, not twice.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
      ".kimi-code/skills/tdd-workflow/SKILL.md",
      ".kimi-code/skills/tdd-workflow/assets/marker.bin",
    ]);
    // `baseline:agents` declares only target-independent rows, so two targets
    // must produce exactly one `AGENTS.md` — a component claiming one
    // destination twice is refused by the engine.
    expect(destinations(result, "baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
  });
});

/**
 * F4, fourth target: Cursor, whose project root the parameterized mapping
 * already produces. Upstream's own Cursor adapter is `kind: 'project'` rooted at
 * `.cursor` (`scripts/lib/install-targets/cursor-project.js`), and the pinned
 * install-preview artifact records every Cursor row as project-scoped under
 * `<project>/.cursor/` with `agents/`, `skills/`, `commands/` and `rules/`
 * beneath it. That is exactly `.${target}` for `target === "cursor"`, so this
 * row wires the target and changes no mapping.
 *
 * Three upstream spellings are recorded and deliberately NOT imitated, on the
 * same principle the Kimi row states: this lifecycle materializes catalog paths
 * verbatim. Upstream prefixes agent filenames (`agents/architect.md` ->
 * `.cursor/agents/ecc-architect.md`), which is the framework namespacing its own
 * install inside a directory it shares; it flattens and renames rules
 * (`rules/common/agents.md` -> `.cursor/rules/common-agents.mdc`); and it nests
 * the shared `.agents/` tree under `.cursor/`, while this lifecycle keeps that
 * row shared at the project root for every target. A rename here would make the
 * receipt's destination unpredictable from the source path, which is what
 * removal and re-apply are checked against.
 */
describe("the Cursor target maps evidence-passed components onto the .cursor project rows", () => {
  it("maps an agent, a skill, and the rules baseline under .cursor/", () => {
    const result = resolve(
      ["cursor"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
      ],
    );

    expect(result.refused).toEqual([]);
    // Verbatim: no `ecc-` filename prefix, which is upstream namespacing its own
    // install and not a destination this lifecycle can derive back from.
    expect(destinations(result, "agent:code-reviewer")).toEqual([
      ".cursor/agents/code-reviewer.md",
    ]);
    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // The shared row stays at the project root; upstream nests it under
      // `.cursor/` and this lifecycle does not.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".cursor/skills/tdd-workflow/SKILL.md",
      ".cursor/skills/tdd-workflow/assets/marker.bin",
    ]);
    // Verbatim again: the nested rule keeps its directory and its extension,
    // rather than upstream's flattened `common-coding-style.mdc`.
    expect(destinations(result, "baseline:rules")).toEqual([
      ".cursor/rules/README.md",
      ".cursor/rules/common/coding-style.md",
    ]);
  });

  it("carries the exact source bytes for Cursor, including a file that is not text", () => {
    const result = resolve(["cursor"], [selected("skill:tdd-workflow", "skills/tdd-workflow")]);

    const files = result.components[0]?.files ?? [];
    const asset = files.find(
      (file) => file.path === ".cursor/skills/tdd-workflow/assets/marker.bin",
    );
    expect(Buffer.from(asset?.contents ?? "").equals(BINARY_ASSET)).toBe(true);
    expect([...new Set(files.map((file) => file.kind))]).toEqual(["copy-file"]);
  });

  it("refuses by name, in the Cursor target's own voice, what Cursor does not own", () => {
    const result = resolve(
      ["cursor"],
      [
        selected("mcp:github", "mcp-configs/mcp-servers.json"),
        selected("baseline:hooks", "hooks"),
        // Positive control: the run is not empty, so the refusals below are
        // decisions and not an adapter that mapped nothing.
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
    expect(refusalFor(result, "mcp:github", "cursor")).toEqual({
      target: "cursor",
      id: "mcp:github",
      reason: "unowned-destination",
      detail: "the Cursor target owns no content destination for .mcp.json",
    });
    expect(refusalFor(result, "baseline:hooks", "cursor")?.detail).toContain("hooks/hooks.json");
  });

  it("unions Claude and Cursor into one set with the shared rows written once", () => {
    const result = resolve(
      ["claude", "cursor"],
      [
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // Once, not twice.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
      ".cursor/skills/tdd-workflow/SKILL.md",
      ".cursor/skills/tdd-workflow/assets/marker.bin",
    ]);
    expect(destinations(result, "baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
  });
});

/**
 * F4, fifth and last target: OpenCode, the honest-small one.
 *
 * There is no evidenced per-component PROJECT content layout for OpenCode. The
 * framework's only OpenCode adapter is home-scoped — this repository already
 * records it as `{ scope: "home", rootSegment: ".opencode" }` in the ECC
 * reconcile locations — and the pinned install-preview artifact carries, for
 * OpenCode, home-scoped `opencode.json` MCP merges and a home `.opencode` exec
 * and nothing else. Not one project-scoped content row.
 *
 * So OpenCode ships with the SHARED target-independent rows only: `AGENTS.md`,
 * `.agents/plugins/` and `.agents/skills/`, which are the tool-shared project
 * surfaces OpenCode genuinely reads. Every other component refuses by name, in
 * the OpenCode voice. Inventing `.opencode/agents/` to make the target look
 * complete would write a directory no evidence says anything reads.
 *
 * Refusal stays all-or-nothing per target, so a component with one shared row
 * and one generic row — `skill:tdd-workflow` — refuses WHOLE for OpenCode
 * rather than installing the half it can map.
 */
describe("the OpenCode target ships the shared rows and refuses the rest by name", () => {
  it("materializes a shared-row-only component and nothing under .opencode/", () => {
    const result = resolve(["opencode"], [selected("baseline:agents", "AGENTS.md")]);

    expect(result.refused).toEqual([]);
    expect(destinations(result, "baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
  });

  it("refuses a component whose sources are all generic content, in the OpenCode voice", () => {
    const result = resolve(
      ["opencode"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("baseline:rules", "rules"),
        // Positive control: the run is not empty, so the refusals below are
        // decisions and not an adapter that mapped nothing.
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["baseline:agents"]);
    expect(refusalFor(result, "agent:code-reviewer", "opencode")).toEqual({
      target: "opencode",
      id: "agent:code-reviewer",
      reason: "unowned-destination",
      detail: "the OpenCode target owns no content destination for agents/code-reviewer.md",
    });
    expect(refusalFor(result, "baseline:rules", "opencode")?.detail).toContain(
      "the OpenCode target owns no content destination for rules/",
    );
  });

  it("refuses a half-shared component whole rather than installing the half it can map", () => {
    const result = resolve(
      ["opencode"],
      [
        // `.agents/skills/tdd-workflow` is shared and WOULD map; `skills/tdd-workflow`
        // does not. Per-target refusal is all-or-nothing, so neither lands.
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    expect(result.components.map((component) => component.id)).toEqual(["baseline:agents"]);
    expect(refusalFor(result, "skill:tdd-workflow", "opencode")?.reason).toBe(
      "unowned-destination",
    );
    expect(destinations(result, "skill:tdd-workflow")).toEqual([]);
  });

  it("produces no `.opencode/` destination for any evidence-passed component", () => {
    const result = resolve(
      ["opencode"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("skill:tdd-workflow", "skills/tdd-workflow"),
        selected("baseline:rules", "rules"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    expect(
      result.components.flatMap((component) => component.files.map((file) => file.path)),
    ).toEqual([".agents/plugins/marketplace.json", "AGENTS.md"]);
  });

  it("lets Claude materialize what OpenCode refuses, in one union", () => {
    const result = resolve(
      ["claude", "opencode"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    // A target that refuses a component does not veto the target that owns it.
    expect(destinations(result, "agent:code-reviewer")).toEqual([
      ".claude/agents/code-reviewer.md",
    ]);
    expect(refusalFor(result, "agent:code-reviewer", "opencode")?.reason).toBe(
      "unowned-destination",
    );
    expect(refusalFor(result, "agent:code-reviewer", "claude")).toBeUndefined();
    // The shared rows both targets agree on collapse to one claim.
    expect(destinations(result, "baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
  });
});

describe("a multi-target request is one union in one materialization", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aih-ecc-target-root-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits the union of per-target destinations for one component", () => {
    const result = resolve(
      ["claude", "codex"],
      [selected("skill:tdd-workflow", "skills/tdd-workflow")],
    );

    expect(destinations(result, "skill:tdd-workflow")).toEqual([
      // Once, not twice: the shared row is the same destination for both targets.
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
      ".codex/skills/tdd-workflow/SKILL.md",
      ".codex/skills/tdd-workflow/assets/marker.bin",
    ]);
  });

  it("collapses a component whose every row is shared to exactly one set of files", () => {
    // `baseline:agents` declares only target-independent rows, so two targets
    // must not produce two claims on the same bytes — the engine refuses a
    // component that claims one destination twice, so a missing collapse is not
    // a cosmetic duplicate but a broken install.
    const single = resolve(["claude"], [selected("baseline:agents", "AGENTS.md")]);
    const both = resolve(["claude", "codex"], [selected("baseline:agents", "AGENTS.md")]);

    expect(destinations(single, "baseline:agents")).toEqual([
      ".agents/plugins/marketplace.json",
      "AGENTS.md",
    ]);
    expect(destinations(both, "baseline:agents")).toEqual(destinations(single, "baseline:agents"));
  });

  it("applies the union into one root with one receipt holding every target's paths", () => {
    const result = resolve(
      ["claude", "codex"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );

    const applied = applyEccMaterialization({ root, components: result.components });

    // Both tool-owned rows landed, and each carries the source bytes.
    for (const [source, destination] of [
      ["agents/code-reviewer.md", ".claude/agents/code-reviewer.md"],
      ["agents/code-reviewer.md", ".codex/agents/code-reviewer.md"],
      ["AGENTS.md", "AGENTS.md"],
      [".agents/plugins/marketplace.json", ".agents/plugins/marketplace.json"],
    ] as const) {
      expect(
        readFileSync(join(root, ...destination.split("/"))).equals(
          readFileSync(join(sourceRoot, ...source.split("/"))),
        ),
        destination,
      ).toBe(true);
    }
    expect(applied.written).toHaveLength(4);

    const read = readEccMaterializationReceipt(root);
    if (read.state !== "valid") throw new Error("expected a valid receipt");
    // ONE receipt, at the one receipt path, holding both targets' paths under
    // the same component — no second receipt and no per-target root.
    expect(
      read.receipt.components.map((component) => ({
        id: component.id,
        files: component.files.map((file) => file.path),
      })),
    ).toEqual([
      {
        id: "agent:code-reviewer",
        files: [".claude/agents/code-reviewer.md", ".codex/agents/code-reviewer.md"],
      },
      { id: "baseline:agents", files: [".agents/plugins/marketplace.json", "AGENTS.md"] },
    ]);
  });

  it("subtracts a dropped target's files on a later, narrower apply", () => {
    const both = resolve(
      ["claude", "codex"],
      [selected("agent:code-reviewer", "agents/code-reviewer.md")],
    );
    applyEccMaterialization({ root, components: both.components });
    expect(existsSync(join(root, ".codex", "agents", "code-reviewer.md"))).toBe(true);

    // Apply IS the reconcile: the same components for fewer targets.
    const claudeOnly = resolve(
      ["claude"],
      [selected("agent:code-reviewer", "agents/code-reviewer.md")],
    );
    const narrowed = applyEccMaterialization({ root, components: claudeOnly.components });

    expect(narrowed.removed.map((file) => file.path)).toEqual([".codex/agents/code-reviewer.md"]);
    expect(existsSync(join(root, ".codex", "agents", "code-reviewer.md"))).toBe(false);
    // ...and the target that stayed is untouched, not rewritten.
    expect(existsSync(join(root, ".claude", "agents", "code-reviewer.md"))).toBe(true);
    expect(narrowed.unchanged.map((file) => file.path)).toEqual([
      ".claude/agents/code-reviewer.md",
    ]);
  });

  it("uninstalls every target's owned bytes and leaves operator content alone", () => {
    writeSource(root, { "notes/OPERATOR.md": "# keep me\n" });
    const result = resolve(
      ["claude", "codex"],
      [selected("skill:tdd-workflow", "skills/tdd-workflow")],
    );
    applyEccMaterialization({ root, components: result.components });

    const removed = uninstallEccMaterialization(root);

    expect(removed.advisories).toEqual([]);
    expect(removed.removed.map((file) => file.path).sort()).toEqual([
      ".agents/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/SKILL.md",
      ".claude/skills/tdd-workflow/assets/marker.bin",
      ".codex/skills/tdd-workflow/SKILL.md",
      ".codex/skills/tdd-workflow/assets/marker.bin",
    ]);
    expect(walkManagedRoot(root)).toEqual(["notes/OPERATOR.md"]);
  });

  it("rolls back both targets' writes when a later write in the same apply fails", () => {
    const { components } = resolve(
      ["claude", "codex"],
      [
        selected("agent:code-reviewer", "agents/code-reviewer.md"),
        selected("baseline:agents", "AGENTS.md"),
      ],
    );
    let renames = 0;

    expect(() =>
      applyEccMaterialization(
        { root, components },
        {
          rename: (from, to) => {
            renames += 1;
            if (renames > 1) throw new Error("injected rename failure");
            renameSync(from, to);
          },
        },
      ),
    ).toThrow(/injected rename failure/);

    // A union is still ONE transaction: the second target's rows are not a
    // separate apply that could survive the first one's failure.
    expect(walkManagedRoot(root)).toEqual([]);
    expect(readEccMaterializationReceipt(root)).toEqual({ state: "absent" });
  });

  it("is byte-identical on a second multi-target apply", () => {
    const components = () =>
      resolve(["claude", "codex"], [selected("skill:tdd-workflow", "skills/tdd-workflow")])
        .components;
    applyEccMaterialization({ root, components: components() });
    const first = Object.fromEntries(
      walkManagedRoot(root).map((path) => [
        path,
        createHash("sha256")
          .update(readFileSync(join(root, ...path.split("/"))))
          .digest("hex"),
      ]),
    );
    expect(Object.keys(first).length).toBeGreaterThan(5);

    const second = applyEccMaterialization({ root, components: components() });

    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(5);
    expect(
      Object.fromEntries(
        walkManagedRoot(root).map((path) => [
          path,
          createHash("sha256")
            .update(readFileSync(join(root, ...path.split("/"))))
            .digest("hex"),
        ]),
      ),
    ).toEqual(first);
  });
});

/**
 * `café.md`, spelled as one precomposed é and as e + combining acute. Derived
 * with `normalize` rather than written as two literals, so the pair cannot
 * silently become one spelling in transit through an editor or a formatter.
 */
const NFC_NAME = "café.md".normalize("NFC");
const NFD_NAME = "café.md".normalize("NFD");

/** Whether this volume stores two entries that differ only by case. */
function caseSensitiveVolume(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-case-probe-"));
  try {
    writeFileSync(join(probe, "probe"), "x", "utf8");
    return !existsSync(join(probe, "PROBE"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** Whether this volume stores NFC and NFD spellings as two entries (APFS does not). */
function preservesUnicodeSpelling(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "aih-ecc-nfd-probe-"));
  try {
    writeFileSync(join(probe, NFC_NAME), "x", "utf8");
    return !existsSync(join(probe, NFD_NAME));
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe("two of one target's own sources may not claim one destination", () => {
  /**
   * The folding, not the filesystem, is the rule under test. Neither colliding
   * pair can be created on every platform — a case-insensitive volume refuses
   * the second spelling of one, a normalizing volume refuses the other — so the
   * probe hands the pair straight to the predicate the resolver calls. That
   * keeps both fold classes pinned on every platform this suite runs on.
   */
  it("folds a Unicode-normalization pair and a case pair onto one destination", () => {
    expect(
      foldedDestinationCollision([
        `.codex/skills/x/${NFC_NAME}`,
        ".codex/skills/x/other.md",
        `.codex/skills/x/${NFD_NAME}`,
      ]),
    ).toEqual({
      first: `.codex/skills/x/${NFC_NAME}`,
      second: `.codex/skills/x/${NFD_NAME}`,
    });
    expect(
      foldedDestinationCollision([".codex/rules/README.md", ".codex/rules/readme.md"]),
    ).toEqual({ first: ".codex/rules/README.md", second: ".codex/rules/readme.md" });
    // The positive control: distinct destinations, including the ones a
    // multi-target union legitimately produces, are not a collision.
    expect(
      foldedDestinationCollision([
        ".agents/skills/x/SKILL.md",
        ".claude/skills/x/SKILL.md",
        ".codex/skills/x/SKILL.md",
      ]),
    ).toBeUndefined();
  });

  it.skipIf(!preservesUnicodeSpelling())(
    "refuses the component for that target when the pinned checkout carries both spellings",
    () => {
      // Skipped where the volume normalizes filenames (APFS): the pair cannot
      // exist there, so there is nothing for the resolver to see.
      const skill = join(sourceRoot, "skills", "tdd-workflow");
      writeFileSync(join(skill, NFC_NAME), "# precomposed\n");
      writeFileSync(join(skill, NFD_NAME), "# decomposed\n");

      const result = resolve(
        ["codex"],
        [
          selected("skill:tdd-workflow", "skills/tdd-workflow"),
          // Positive control: the run is not empty, so the refusal is a decision.
          selected("agent:code-reviewer", "agents/code-reviewer.md"),
        ],
      );

      expect(result.components.map((component) => component.id)).toEqual(["agent:code-reviewer"]);
      const refusal = refusalFor(result, "skill:tdd-workflow", "codex");
      expect(refusal?.reason).toBe("duplicate-destination");
      expect(refusal?.detail).toContain("two pinned sources claim one Codex destination");
      expect(refusal?.detail).toContain("Unicode normalization or case");
    },
  );

  it.skipIf(!preservesUnicodeSpelling())(
    "refuses the same component on the default Claude path, never one file short",
    () => {
      const skill = join(sourceRoot, "skills", "tdd-workflow");
      writeFileSync(join(skill, NFC_NAME), "# precomposed\n");
      writeFileSync(join(skill, NFD_NAME), "# decomposed\n");

      const claude = resolveEccClaudeMaterialization({
        sourceRoot,
        components: [selected("skill:tdd-workflow", "skills/tdd-workflow")],
      });

      // Materializing one of the two and reporting nothing is the regression
      // this pins: the component is refused whole, by name, for the target.
      expect(claude.components).toEqual([]);
      expect(claude.refused[0]?.reason).toBe("duplicate-destination");
      expect(claude.refused[0]?.detail).toContain(
        "two pinned sources claim one Claude destination",
      );
    },
  );

  it.skipIf(!caseSensitiveVolume())(
    "refuses a case-folded pair the same way on a case-sensitive volume",
    () => {
      // Inside `rules/common`, which the descriptor declares as a DIRECTORY, so
      // the walk sees both spellings. `rules/README.md` is declared as an exact
      // file and a differently-cased sibling would simply not be a source.
      writeFileSync(join(sourceRoot, "rules", "common", "Coding-Style.md"), "# shouting\n");

      const result = resolve(["codex"], [selected("baseline:rules", "rules")]);

      expect(result.components).toEqual([]);
      expect(refusalFor(result, "baseline:rules", "codex")?.reason).toBe("duplicate-destination");
    },
  );
});

describe("which CLIs are governed materialization targets", () => {
  it("accepts the wired targets and collapses a repeated one", () => {
    expect(assertGovernedMaterializationTargets(["claude"])).toEqual(["claude"]);
    expect(assertGovernedMaterializationTargets(["claude", "codex"])).toEqual(["claude", "codex"]);
    expect(assertGovernedMaterializationTargets(["codex", "codex"])).toEqual(["codex"]);
    expect(assertGovernedMaterializationTargets(["kimi"])).toEqual(["kimi"]);
    expect(assertGovernedMaterializationTargets(["cursor"])).toEqual(["cursor"]);
    expect(assertGovernedMaterializationTargets(["opencode"])).toEqual(["opencode"]);
    expect(
      assertGovernedMaterializationTargets(["claude", "codex", "kimi", "cursor", "opencode"]),
    ).toEqual(["claude", "codex", "kimi", "cursor", "opencode"]);
  });

  /**
   * The completion fact itself. Every ruled target is wired, so the two lists
   * are the same list.
   *
   * `assertGovernedMaterializationTargets` still carries its unwired-target
   * branch, and while these lists are equal that branch cannot be reached. It
   * is kept as a fail-closed guard for the edit that adds a sixth governed
   * target: without it, a ruled-but-unbuilt target would silently materialize
   * nothing instead of refusing by name. This pin is what turns that future
   * edit into a visible decision — adding to GOVERNED alone breaks it, and the
   * fix is either to wire the target or to accept the refusal this test is
   * changed to describe.
   *
   * No test exercises the guarded branch. It cannot be reached without mutating
   * the lists, and a pin that cannot fail is worse than no pin.
   */
  it("has every governed target wired — the ruled five are complete", () => {
    expect([...WIRED_MATERIALIZATION_TARGETS]).toEqual([...GOVERNED_MATERIALIZATION_TARGETS]);
  });

  it("refuses a CLI outside the governed five, by name", () => {
    expect(() => assertGovernedMaterializationTargets(["zed"])).toThrowError(
      /zed is not a governed materialization target/,
    );
    // The refusal names both lists, so "everything else waits" is a statement
    // the operator can read rather than an absence they have to infer.
    const failure = (() => {
      try {
        assertGovernedMaterializationTargets(["gemini", "kiro"]);
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(failure).toContain("gemini, kiro");
    // The refusal names both lists, which now coincide — see the completion pin
    // above. The remedy still has to be reachable from the message, so the
    // wired list is asserted on its own rather than folded into the other.
    expect(failure).toContain(GOVERNED_MATERIALIZATION_TARGETS.join(", "));
    expect(failure).toContain(WIRED_MATERIALIZATION_TARGETS.join(", "));
    expect(failure).toContain(`--cli ${WIRED_MATERIALIZATION_TARGETS.join(",")}`);
  });

  it("refuses an empty target set rather than materializing for nobody", () => {
    expect(() => assertGovernedMaterializationTargets([])).toThrowError(/no target was requested/);
  });
});

describe("the one destination mapping keeps each target off the others' exclusive surfaces", () => {
  it("answers the generic project rows for Codex", () => {
    expect(eccContentDestinationMapping("agents/code-reviewer.md", "codex")).toEqual({
      scope: "project",
      relative: ".codex/agents/code-reviewer.md",
    });
    expect(eccContentDestinationMapping("skills/tdd-workflow/SKILL.md", "codex")).toEqual({
      scope: "project",
      relative: ".codex/skills/tdd-workflow/SKILL.md",
    });
    expect(eccContentDestinationMapping("commands/tdd.md", "codex")).toEqual({
      scope: "project",
      relative: ".codex/commands/tdd.md",
    });
    expect(eccContentDestinationMapping("rules/common/testing.md", "codex")).toEqual({
      scope: "project",
      relative: ".codex/rules/common/testing.md",
    });
  });

  it("answers the generic project rows for Cursor at the parameterized `.cursor` root", () => {
    // The mapping needed no Cursor row: `.${target}` is already the root
    // upstream's own project adapter uses, and the pinned install-preview
    // artifact records every Cursor destination under `<project>/.cursor/`.
    for (const [source, relative] of [
      ["agents/code-reviewer.md", ".cursor/agents/code-reviewer.md"],
      ["skills/tdd-workflow/SKILL.md", ".cursor/skills/tdd-workflow/SKILL.md"],
      ["commands/tdd.md", ".cursor/commands/tdd.md"],
      ["rules/common/testing.md", ".cursor/rules/common/testing.md"],
    ] as const) {
      expect(eccContentDestinationMapping(source, "cursor"), source).toEqual({
        scope: "project",
        relative,
      });
    }
  });

  it("answers no generic project row for OpenCode, and never `.opencode/`", () => {
    // Suppressed deliberately: no evidence records a per-component OpenCode
    // PROJECT layout. Its only framework adapter is home-scoped, so `.opencode/`
    // here would be a directory this lifecycle invented.
    for (const source of [
      "agents/code-reviewer.md",
      "skills/tdd-workflow/SKILL.md",
      "commands/tdd.md",
      "rules/common/testing.md",
    ]) {
      expect(eccContentDestinationMapping(source, "opencode"), source).toBeUndefined();
    }
    expect(
      GOVERNED_MATERIALIZATION_TARGETS.flatMap((target) =>
        ["agents/x.md", "skills/x/SKILL.md", "commands/x.md", "rules/x.md"].map(
          (source) => eccContentDestinationMapping(source, target)?.relative ?? "",
        ),
      ).filter((relative) => relative.startsWith(".opencode/")),
    ).toEqual([]);
    // The shared rows still answer for OpenCode — the suppression removes the
    // four generic rows, not the target.
    expect(eccContentDestinationMapping("AGENTS.md", "opencode")).toEqual({
      scope: "project",
      relative: "AGENTS.md",
    });
    expect(
      eccContentDestinationMapping(".agents/skills/tdd-workflow/SKILL.md", "opencode"),
    ).toEqual({ scope: "project", relative: ".agents/skills/tdd-workflow/SKILL.md" });
  });

  it("fails the governed classifier closed when OpenCode claims a `.opencode/` content path", () => {
    const operation = {
      kind: "copy-file" as const,
      moduleId: "agents-core",
      sourceRelativePath: "agents/code-reviewer.md",
      destinationPath: "/fixture/.opencode/agents/code-reviewer.md",
    };

    // The classifier reads the SAME mapping the adapter does, so the suppression
    // has to reach it: a classifier that still derived `.opencode` would admit
    // at apply time exactly the row the adapter refuses to plan.
    expect(() =>
      classifyGovernedEccOperation(operation, {
        projectRoot: "/fixture",
        homeDir: "/home/aih",
        target: "opencode",
      }),
    ).toThrow(/unclassifiable governed ECC content operation/);
    // Positive control: the same source still classifies for a target that owns
    // a generic row, so this is the suppression and not a broken operation.
    expect(
      classifyGovernedEccOperation(
        { ...operation, destinationPath: "/fixture/.cursor/agents/code-reviewer.md" },
        { projectRoot: "/fixture", homeDir: "/home/aih", target: "cursor" },
      ),
    ).toBe("ecc-content");
  });

  it("roots the Kimi project rows at `.kimi-code`, not at the parameterized `.kimi`", () => {
    for (const [source, relative] of [
      ["agents/code-reviewer.md", ".kimi-code/agents/code-reviewer.md"],
      ["skills/tdd-workflow/SKILL.md", ".kimi-code/skills/tdd-workflow/SKILL.md"],
      ["commands/tdd.md", ".kimi-code/commands/tdd.md"],
      ["rules/common/testing.md", ".kimi-code/rules/common/testing.md"],
    ] as const) {
      expect(eccContentDestinationMapping(source, "kimi"), source).toEqual({
        scope: "project",
        relative,
      });
    }
    // `.kimi` is upstream's own obsolete compat-docs directory, which its Kimi
    // adapter refuses to recreate. No target's generic rows may land there.
    expect(
      GOVERNED_MATERIALIZATION_TARGETS.flatMap((target) =>
        ["agents/x.md", "skills/x/SKILL.md", "commands/x.md", "rules/x.md"].map(
          (source) => eccContentDestinationMapping(source, target)?.relative ?? "",
        ),
      ).filter((relative) => relative.startsWith(".kimi/")),
    ).toEqual([]);
  });

  it("owns no destination for a `.kimi/` source, for Kimi or for anyone else", () => {
    for (const target of GOVERNED_MATERIALIZATION_TARGETS) {
      expect(eccContentDestinationMapping(".kimi/compat-docs.md", target), target).toBeUndefined();
      expect(
        eccContentDestinationMapping(".kimi-code/agents/x.md", target),
        target,
      ).toBeUndefined();
    }
  });

  it("keeps the shared rows shared and the Codex home row home-scoped", () => {
    for (const target of GOVERNED_MATERIALIZATION_TARGETS) {
      expect(eccContentDestinationMapping("AGENTS.md", target), target).toEqual({
        scope: "project",
        relative: "AGENTS.md",
      });
      expect(
        eccContentDestinationMapping(".agents/skills/tdd-workflow/SKILL.md", target),
        target,
      ).toEqual({ scope: "project", relative: ".agents/skills/tdd-workflow/SKILL.md" });
      expect(eccContentDestinationMapping(".codex/AGENTS.md", target), target).toEqual({
        scope: "home",
        relative: ".codex/AGENTS.md",
      });
    }
  });

  it("answers `.claude/commands/` for Claude and for nobody else", () => {
    expect(eccContentDestinationMapping(".claude/commands/tdd.md", "claude")).toEqual({
      scope: "project",
      relative: ".claude/commands/tdd.md",
    });
    for (const target of ["codex", "kimi", "cursor", "opencode"]) {
      expect(
        eccContentDestinationMapping(".claude/commands/tdd.md", target),
        target,
      ).toBeUndefined();
    }
  });

  it("fails the governed classifier closed when a non-Claude target claims Claude's commands", () => {
    const operation = {
      kind: "copy-file" as const,
      moduleId: "commands-core",
      sourceRelativePath: ".claude/commands/tdd.md",
      destinationPath: "/fixture/.claude/commands/tdd.md",
    };

    // Claude still classifies it as content — the row did not disappear.
    expect(
      classifyGovernedEccOperation(operation, {
        projectRoot: "/fixture",
        homeDir: "/home/aih",
        target: "claude",
      }),
    ).toBe("ecc-content");
    // Codex cannot: an unmapped destination is unclassifiable, and
    // unclassifiable stops a governed install rather than writing the file.
    expect(() =>
      classifyGovernedEccOperation(operation, {
        projectRoot: "/fixture",
        homeDir: "/home/aih",
        target: "codex",
      }),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });

  it("classifies a `.kimi-code/` destination as governed content for Kimi and for nobody else", () => {
    const operation = {
      kind: "copy-file" as const,
      moduleId: "agents-core",
      sourceRelativePath: "agents/code-reviewer.md",
      destinationPath: "/fixture/.kimi-code/agents/code-reviewer.md",
    };

    // The classifier reads the SAME mapping the adapter does, so the root
    // override has to reach it — a mapping that answered `.kimi-code` while the
    // classifier still derived `.kimi` would refuse every byte the adapter
    // planned, at apply time, after the plan said it would write them.
    expect(
      classifyGovernedEccOperation(operation, {
        projectRoot: "/fixture",
        homeDir: "/home/aih",
        target: "kimi",
      }),
    ).toBe("ecc-content");
    for (const target of ["claude", "codex"] as const) {
      expect(() =>
        classifyGovernedEccOperation(operation, {
          projectRoot: "/fixture",
          homeDir: "/home/aih",
          target,
        }),
      ).toThrow(/unclassifiable governed ECC content operation/);
    }
    // ...and the root the parameterized mapping would have produced is not a
    // destination Kimi owns.
    expect(() =>
      classifyGovernedEccOperation(
        { ...operation, destinationPath: "/fixture/.kimi/agents/code-reviewer.md" },
        { projectRoot: "/fixture", homeDir: "/home/aih", target: "kimi" },
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });

  /**
   * The verified installer's spawned child restates this mapping in a script
   * string: it runs out of process against the framework's own executor and
   * cannot import the module above. Nothing but this pin keeps the two copies
   * saying the same thing, and a Kimi root applied to only one of them is a
   * classifier that rejects at apply what the planner promised to write.
   */
  it("keeps the runtime restatement of the mapping in lockstep on the Kimi root", () => {
    const kimiRoot = /const targetRoot = [^\n]*"\.kimi-code"[^\n]*;/;
    for (const module of ["materialize.ts", "verified.ts"]) {
      expect(readFileSync(join(process.cwd(), "src", "ecc", module), "utf8"), module).toMatch(
        kimiRoot,
      );
    }
  });

  /**
   * The same lockstep, on the OpenCode suppression. The behavioural pins above
   * only reach the importable copy; the child's restatement is a script string
   * this suite can read but not call. Suppression applied to one copy only is a
   * classifier and a planner that disagree about whether `.opencode/agents/` is
   * a governed content destination at all.
   */
  it("keeps the runtime restatement of the mapping in lockstep on the OpenCode suppression", () => {
    // The four generic rows must sit INSIDE the suppressed arm, so the regex
    // spans from the target test through the first row it guards.
    const suppression = /target === "opencode"\s*\?\s*\[\]\s*:\s*\(?\[\s*\[\s*"agents\/"/;
    for (const module of ["materialize.ts", "verified.ts"]) {
      expect(readFileSync(join(process.cwd(), "src", "ecc", module), "utf8"), module).toMatch(
        suppression,
      );
    }
  });

  it("has no shipped component that declares a `.claude/commands/` source", () => {
    // The row above is the gate, not a reachable install path: no install
    // descriptor in the pinned snapshot declares a source under `.claude/`, so
    // the adapter cannot be handed one today. Stated as a test so a snapshot
    // that starts shipping one is caught by the gate rather than by surprise.
    for (const id of ["baseline:commands", "baseline:agents", "baseline:platform"] as const) {
      expect(
        eccComponentSourcePaths(id).filter((path) => path.startsWith(".claude/")),
        id,
      ).toEqual([]);
    }
  });
});
