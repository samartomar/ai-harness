import { describe, expect, it } from "vitest";
import {
  classifyGovernedEccOperation,
  eccAdapterDestinationV1,
} from "../../src/ecc/materialize.js";

/**
 * The governed classifier asks one question about a destination: is this where
 * the PINNED ECC install target writes this source under the root its own
 * `resolveRoot` returned? These pins come from the pinned adapters themselves
 * (`scripts/lib/install-targets/{claude-home,cursor-project,antigravity-project,zed-project}.js`
 * at 5064474d) and from K1's sealed install preview for the same sources.
 *
 * A destination the pinned adapter does not write for that source stays
 * unclassifiable, which stops a governed install instead of writing it.
 */

const PROJECT_ROOT = "/workspace/project";
const HOME_DIR = "/home/aih";

function rootsFor(target: string, targetRoot: string) {
  return { projectRoot: PROJECT_ROOT, homeDir: HOME_DIR, target, targetRoot };
}

const CLAUDE = rootsFor("claude", `${HOME_DIR}/.claude`);
const CODEX = rootsFor("codex", `${HOME_DIR}/.codex`);
const CURSOR = rootsFor("cursor", `${PROJECT_ROOT}/.cursor`);
const ANTIGRAVITY = rootsFor("antigravity", `${PROJECT_ROOT}/.agents`);
const ZED = rootsFor("zed", `${PROJECT_ROOT}/.zed`);

function operation(source: string, destination: string, moduleId = "rules-core") {
  return {
    kind: "copy-file" as const,
    moduleId,
    sourceRelativePath: source,
    destinationPath: destination,
  };
}

describe("the pinned adapter destination for the Claude target", () => {
  it("namespaces every rules source under `rules/ecc/`, as claude-home.js does", () => {
    expect(eccAdapterDestinationV1("rules", "claude")).toEqual({
      state: "relative",
      relative: "rules/ecc",
    });
    expect(eccAdapterDestinationV1("rules/README.md", "claude")).toEqual({
      state: "relative",
      relative: "rules/ecc/README.md",
    });
    expect(eccAdapterDestinationV1("rules/common/testing.md", "claude")).toEqual({
      state: "relative",
      relative: "rules/ecc/common/testing.md",
    });
    // skills and docs keep the shared scaffold identity under the same root.
    expect(eccAdapterDestinationV1("skills/tdd-workflow/SKILL.md", "claude")).toEqual({
      state: "identity",
    });
    expect(eccAdapterDestinationV1("agents/code-reviewer.md", "claude")).toEqual({
      state: "identity",
    });
  });

  it("classifies the exact operation assemble refuses today", () => {
    // DEF1 §5.3: `unclassifiable governed ECC content operation:
    // rules-core:rules/README.md -> /home/aih/.claude/rules/ecc/README.md`.
    expect(
      classifyGovernedEccOperation(
        operation("rules/README.md", `${HOME_DIR}/.claude/rules/ecc/README.md`),
        CLAUDE,
      ),
    ).toBe("ecc-content");
    expect(
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${HOME_DIR}/.claude/rules/ecc/common/testing.md`),
        CLAUDE,
      ),
    ).toBe("ecc-content");
  });

  it("still refuses a rules destination the pinned adapter does not write", () => {
    for (const destination of [
      // The pre-namespace path Core's project layout uses: upstream writes the
      // home install under `rules/ecc/`, never directly under `rules/`.
      `${HOME_DIR}/.claude/rules/README.md`,
      `${HOME_DIR}/.claude/rules/common/testing.md`,
      // A different namespace is a different tool's directory.
      `${HOME_DIR}/.claude/rules/ecc-other/README.md`,
      // Same namespace, different file: the suffix must match exactly.
      `${HOME_DIR}/.claude/rules/ecc/common/other.md`,
      `${HOME_DIR}/.claude/rules/ecc/README.md/extra.md`,
    ]) {
      expect(() =>
        classifyGovernedEccOperation(operation("rules/README.md", destination), CLAUDE),
      ).toThrow(/unclassifiable governed ECC content operation/);
    }
  });
});

describe("the pinned adapter destination for the Cursor target", () => {
  it("flattens rules to `<dir>-<file>.mdc` and prefixes agent files with `ecc-`", () => {
    expect(eccAdapterDestinationV1("rules/common/testing.md", "cursor")).toEqual({
      state: "relative",
      relative: "rules/common-testing.mdc",
    });
    expect(eccAdapterDestinationV1("rules/web/design-quality.md", "cursor")).toEqual({
      state: "relative",
      relative: "rules/web-design-quality.mdc",
    });
    // `toCursorRuleFileName` returns null for README.md: upstream plans nothing.
    expect(eccAdapterDestinationV1("rules/README.md", "cursor")).toEqual({ state: "unwritten" });
    expect(eccAdapterDestinationV1("rules/common/README.md", "cursor")).toEqual({
      state: "unwritten",
    });
    expect(eccAdapterDestinationV1("agents/a11y-architect.md", "cursor")).toEqual({
      state: "relative",
      relative: "agents/ecc-a11y-architect.md",
    });
    expect(eccAdapterDestinationV1("agents/review/deep.md", "cursor")).toEqual({
      state: "relative",
      relative: "agents/ecc-review-deep.md",
    });
  });

  it("classifies the flattened rules and prefixed agent destinations", () => {
    expect(
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.cursor/rules/common-testing.mdc`),
        CURSOR,
      ),
    ).toBe("ecc-content");
    expect(
      classifyGovernedEccOperation(
        operation(
          "agents/a11y-architect.md",
          `${PROJECT_ROOT}/.cursor/agents/ecc-a11y-architect.md`,
          "agents-core",
        ),
        CURSOR,
      ),
    ).toBe("ecc-content");
  });

  it("still refuses the unflattened and unprefixed destinations", () => {
    // Core's project-scoped layout is not what the pinned Cursor adapter writes.
    expect(() =>
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.cursor/rules/common/testing.md`),
        CURSOR,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
    expect(() =>
      classifyGovernedEccOperation(
        operation(
          "agents/a11y-architect.md",
          `${PROJECT_ROOT}/.cursor/agents/a11y-architect.md`,
          "agents-core",
        ),
        CURSOR,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
    // Upstream drops rules/README.md rather than writing it flat.
    expect(() =>
      classifyGovernedEccOperation(
        operation("rules/README.md", `${PROJECT_ROOT}/.cursor/rules/README.mdc`),
        CURSOR,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });
});

describe("the pinned adapter destination for the Antigravity target", () => {
  it("flattens rules under `rules/` and routes commands to `workflows/`", () => {
    expect(eccAdapterDestinationV1("rules/common/testing.md", "antigravity")).toEqual({
      state: "relative",
      relative: "rules/common-testing.md",
    });
    expect(eccAdapterDestinationV1("commands/aside.md", "commands-core")).toEqual({
      state: "identity",
    });
    expect(eccAdapterDestinationV1("commands/aside.md", "antigravity")).toEqual({
      state: "relative",
      relative: "workflows/aside.md",
    });
    expect(eccAdapterDestinationV1("commands", "antigravity")).toEqual({
      state: "relative",
      relative: "workflows",
    });
    expect(eccAdapterDestinationV1("agents/code-reviewer.md", "antigravity")).toEqual({
      state: "identity",
    });
    expect(eccAdapterDestinationV1("skills/tdd-workflow/SKILL.md", "antigravity")).toEqual({
      state: "identity",
    });
  });

  it("classifies the flattened rules and workflow destinations", () => {
    expect(
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.agents/rules/common-testing.md`),
        ANTIGRAVITY,
      ),
    ).toBe("ecc-content");
    expect(
      classifyGovernedEccOperation(
        operation("commands/aside.md", `${PROJECT_ROOT}/.agents/workflows/aside.md`),
        ANTIGRAVITY,
      ),
    ).toBe("ecc-content");
  });

  it("still refuses the unflattened rules and command destinations", () => {
    expect(() =>
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.agents/rules/common/testing.md`),
        ANTIGRAVITY,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
    expect(() =>
      classifyGovernedEccOperation(
        operation("commands/aside.md", `${PROJECT_ROOT}/.agents/commands/aside.md`),
        ANTIGRAVITY,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });
});

describe("the pinned adapter destination for the Zed target", () => {
  it("flattens rules under `rules/`", () => {
    expect(eccAdapterDestinationV1("rules/common/testing.md", "zed")).toEqual({
      state: "relative",
      relative: "rules/common-testing.md",
    });
    expect(eccAdapterDestinationV1("agents/code-reviewer.md", "zed")).toEqual({
      state: "identity",
    });
  });

  it("classifies the flattened destination and refuses the unflattened one", () => {
    expect(
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.zed/rules/common-testing.md`),
        ZED,
      ),
    ).toBe("ecc-content");
    expect(() =>
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${PROJECT_ROOT}/.zed/rules/common/testing.md`),
        ZED,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });
});

describe("targets whose pinned adapter keeps the scaffold identity", () => {
  it("keeps Codex rules and agents at the identity path under the verified root", () => {
    expect(eccAdapterDestinationV1("rules/common/testing.md", "codex")).toEqual({
      state: "identity",
    });
    expect(
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${HOME_DIR}/.codex/rules/common/testing.md`),
        CODEX,
      ),
    ).toBe("ecc-content");
    expect(
      classifyGovernedEccOperation(
        operation("agents/code-reviewer.md", `${HOME_DIR}/.codex/agents/code-reviewer.md`, "agents-core"),
        CODEX,
      ),
    ).toBe("ecc-content");
  });

  it("still refuses a codex destination outside the verified root", () => {
    expect(() =>
      classifyGovernedEccOperation(
        operation("rules/common/testing.md", `${HOME_DIR}/.codex/rules/other/testing.md`),
        CODEX,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });
});
