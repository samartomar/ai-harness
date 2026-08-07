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
 * F4, second target: Codex, and the seam that made it one resolver instead of a
 * second copy of the Claude one.
 *
 * The Claude suite (`materialization-target-claude.test.ts`) still pins the
 * single-target binding exactly as it shipped. This file pins what the
 * generalization added: a second target's destinations, the refusals that keep
 * their per-target voice, the union a multi-target request produces in ONE
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
    expect(failure).toContain(GOVERNED_MATERIALIZATION_TARGETS.join(", "));
    expect(failure).toContain(WIRED_MATERIALIZATION_TARGETS.join(", "));
  });

  it("refuses a ruled target that is not wired yet, naming what IS wired", () => {
    for (const target of ["kimi", "cursor", "opencode"]) {
      const failure = (() => {
        try {
          assertGovernedMaterializationTargets([target]);
        } catch (error) {
          return (error as Error).message;
        }
        return "";
      })();
      expect(failure, target).toMatch(/is a governed materialization target that is not wired yet/);
      expect(failure, target).toContain("claude, codex");
      // Not the other refusal: an unwired ruled target is a row still to come,
      // not a tool this lifecycle will never serve.
      expect(failure, target).not.toContain("is not a governed materialization target");
    }
    expect(() => assertGovernedMaterializationTargets(["claude", "cursor"])).toThrowError(
      /Cursor target is a governed materialization target that is not wired yet/,
    );
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
