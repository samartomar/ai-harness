import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateEccInstallPreviewArtifact } from "../../src/ecc/install-preview-generate.js";
import {
  classifyGovernedEccOperation,
  eccAdapterDestinationV1,
  eccPreviewAdapterDestinationV1,
  filterEccManifestPlan,
  filterEccPreviewManifestPlan,
} from "../../src/ecc/materialize.js";

/**
 * D82, route (A): the install preview DESCRIBES what the PINNED ECC installer
 * does; Core's governed OWNERSHIP classifier decides what AIH itself
 * materializes, at apply. These pins hold the preview route to that split.
 *
 * The preview route keeps the selection filter, the root escape check, the
 * normalized destination collision check, the MCP exclusion, #1016's executable
 * consent rule for host-runtime operations, and DESTINATION INTEGRITY: the
 * destination must be the one the pinned adapter itself writes for that source
 * under its own `resolveRoot`. The governed route is unchanged, including the
 * ownership refusal for upstream scaffold material AIH never owned.
 */

const PIN = "1234567890abcdef1234567890abcdef12345678";
const PROJECT_ROOT = "/workspace/project";
const HOME_DIR = "/home/aih";

const CLAUDE_ROOTS = {
  projectRoot: PROJECT_ROOT,
  homeDir: HOME_DIR,
  target: "claude",
  targetRoot: `${HOME_DIR}/.claude`,
};

function selection(componentId: string) {
  return {
    scope: "scoped" as const,
    components: [componentId as `${string}:${string}`],
    mcps: [],
    recommendations: [],
  };
}

function operation(
  source: string,
  destination: string,
  moduleId = "commands-core",
  kind = "copy-file",
) {
  return { kind, moduleId, sourceRelativePath: source, destinationPath: destination };
}

function planWith(...operations: ReturnType<typeof operation>[]) {
  return {
    operations: operations.map((entry) => ({ ...entry })),
    statePreview: { operations: operations.map((entry) => ({ ...entry })) },
  };
}

function preview(
  plan: ReturnType<typeof planWith>,
  componentId = "baseline:commands",
  roots = CLAUDE_ROOTS,
): ReturnType<typeof planWith> {
  filterEccPreviewManifestPlan(plan, selection(componentId), { roots });
  return plan;
}

describe("the preview route describes the pinned installer's own scaffold", () => {
  it("keeps the exact operation the governed route refuses", () => {
    // The operation `baseline:assemble` stopped on at 5064474d: module
    // `commands-core` scaffolds a script AIH's content model does not own.
    const kept = preview(
      planWith(
        operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
      ),
    );
    expect(kept.operations).toEqual([
      expect.objectContaining({
        moduleId: "commands-core",
        sourceRelativePath: "scripts/harness-audit.js",
        destinationPath: `${HOME_DIR}/.claude/scripts/harness-audit.js`,
      }),
    ]);
    expect(kept.statePreview.operations).toEqual(kept.operations);
  });

  it("still refuses that same operation when it is classified with governance", () => {
    const governed = planWith(
      operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
    );
    expect(() =>
      filterEccManifestPlan(governed, selection("baseline:commands"), {
        governance: true,
        roots: CLAUDE_ROOTS,
      }),
    ).toThrow(
      /unclassifiable governed ECC content operation: commands-core:scripts\/harness-audit\.js -> \/home\/aih\/\.claude\/scripts\/harness-audit\.js/,
    );
    expect(() =>
      classifyGovernedEccOperation(
        operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/harness-audit.js`),
        CLAUDE_ROOTS,
      ),
    ).toThrow(/unclassifiable governed ECC content operation/);
  });

  it("keeps the pinned adapters' remapped and native-root scaffold destinations", () => {
    // `rules` is namespaced under rules/ecc (claude-home.js:11,17-28), and a
    // source equal to the adapter's nativeRootRelativePath (`.claude-plugin`,
    // claude-home.js:55) is materialized under the target root itself
    // (helpers.js:317-329 + plan.js:196-210).
    const kept = preview(
      planWith(
        operation("rules/README.md", `${HOME_DIR}/.claude/rules/ecc/README.md`, "rules-core"),
        operation(
          ".claude-plugin/plugin.json",
          `${HOME_DIR}/.claude/plugin.json`,
          "platform-configs",
        ),
      ),
      "baseline:platform",
    );
    expect(kept.operations).toHaveLength(1);
    expect(
      preview(
        planWith(
          operation("rules/README.md", `${HOME_DIR}/.claude/rules/ecc/README.md`, "rules-core"),
        ),
        "baseline:rules",
      ).operations,
    ).toHaveLength(1);
    expect(
      preview(
        planWith(
          operation(
            ".claude-plugin/plugin.json",
            `${HOME_DIR}/.claude/plugin.json`,
            "platform-configs",
          ),
        ),
        "baseline:platform",
      ).operations,
    ).toHaveLength(1);
  });

  it("keeps Cursor's `.cursor/rules` flattening and drops the README rule", () => {
    const cursorRoots = {
      projectRoot: PROJECT_ROOT,
      homeDir: HOME_DIR,
      target: "cursor",
      targetRoot: `${PROJECT_ROOT}/.cursor`,
    };
    expect(
      preview(
        planWith(
          operation(
            ".cursor/rules/common-agents.md",
            `${PROJECT_ROOT}/.cursor/rules/common-agents.mdc`,
            "platform-configs",
          ),
        ),
        "baseline:platform",
        cursorRoots,
      ).operations,
    ).toHaveLength(1);
    expect(eccPreviewAdapterDestinationV1(".cursor/rules/common-agents.md", "cursor")).toEqual({
      state: "relative",
      relative: "rules/common-agents.mdc",
    });
    expect(eccPreviewAdapterDestinationV1(".cursor/rules/common/README.md", "cursor")).toEqual({
      state: "unwritten",
    });
    expect(() =>
      preview(
        planWith(
          operation(
            ".cursor/rules/common-agents.md",
            `${PROJECT_ROOT}/.cursor/rules/common/agents.mdc`,
            "platform-configs",
          ),
        ),
        "baseline:platform",
        cursorRoots,
      ),
    ).toThrow(/unclassifiable ECC install preview destination/);
  });

  it("still refuses a scaffold destination the pinned adapter would not produce", () => {
    // Wrong relative path under the verified root.
    expect(() =>
      preview(
        planWith(operation("scripts/harness-audit.js", `${HOME_DIR}/.claude/scripts/other.js`)),
      ),
    ).toThrow(/unclassifiable ECC install preview destination/);
    // Wrong root: the project root, not the adapter's resolved target root.
    expect(() =>
      preview(
        planWith(operation("scripts/harness-audit.js", `${PROJECT_ROOT}/scripts/harness-audit.js`)),
      ),
    ).toThrow(/unclassifiable ECC install preview destination/);
    // A remapped destination the adapter does not write for that source.
    expect(() =>
      preview(
        planWith(operation("rules/README.md", `${HOME_DIR}/.claude/rules/README.md`, "rules-core")),
        "baseline:rules",
      ),
    ).toThrow(/unclassifiable ECC install preview destination/);
    // A Cursor rule the adapter drops rather than writes flat.
    expect(() =>
      preview(
        planWith(
          operation("rules/README.md", `${PROJECT_ROOT}/.cursor/rules/README.mdc`, "rules-core"),
        ),
        "baseline:rules",
        {
          projectRoot: PROJECT_ROOT,
          homeDir: HOME_DIR,
          target: "cursor",
          targetRoot: `${PROJECT_ROOT}/.cursor`,
        },
      ),
    ).toThrow(/unclassifiable ECC install preview destination/);
  });

  it("still refuses a destination outside the authorized roots", () => {
    expect(() =>
      preview(planWith(operation("scripts/harness-audit.js", "/tmp/elsewhere/harness-audit.js"))),
    ).toThrow(/ECC destination escapes authorized project\/home roots/);
  });

  it("still refuses an operation kind the pinned source cannot explain", () => {
    expect(() =>
      preview(
        planWith(
          operation(
            "scripts/harness-audit.js",
            `${HOME_DIR}/.claude/scripts/harness-audit.js`,
            "commands-core",
            "delete-file",
          ),
        ),
      ),
    ).toThrow(/unsupported ECC manifest operation kind: delete-file/);
  });

  it("treats the Claude settings hook merge as host runtime under the consent rule", () => {
    // helpers.js:153-165 plans `update-claude-settings` for the claude target's
    // hooks-runtime module; claude-settings.js:10 and :50-52 pin the source and
    // the destination (`<targetRoot>/settings.json`).
    const settings = operation(
      "hooks/hooks.json",
      `${HOME_DIR}/.claude/settings.json`,
      "hooks-runtime",
      "update-claude-settings",
    );
    const kept = preview(planWith(settings), "baseline:hooks");
    expect(kept.operations).toHaveLength(1);
    // Without `baseline:hooks` selected there is no executable consent, so the
    // host-runtime operation is dropped rather than described.
    expect(preview(planWith(settings), "baseline:rules").operations).toEqual([]);
    // The pinned source plans this kind only for claude / hooks-runtime /
    // hooks/hooks.json and only under the Claude settings file.
    expect(() =>
      preview(
        planWith(
          operation(
            "hooks/hooks.json",
            `${HOME_DIR}/.claude/hooks/hooks.json`,
            "hooks-runtime",
            "update-claude-settings",
          ),
        ),
        "baseline:hooks",
      ),
    ).toThrow(/unclassifiable ECC install preview settings operation/);
    expect(() =>
      preview(
        planWith(
          operation(
            "hooks/hooks.json",
            `${PROJECT_ROOT}/.cursor/settings.json`,
            "hooks-runtime",
            "update-claude-settings",
          ),
        ),
        "baseline:hooks",
        {
          projectRoot: PROJECT_ROOT,
          homeDir: HOME_DIR,
          target: "cursor",
          targetRoot: `${PROJECT_ROOT}/.cursor`,
        },
      ),
    ).toThrow(/unclassifiable ECC install preview settings operation/);
  });

  it("keeps the MCP exclusion", () => {
    expect(
      preview(
        planWith(
          operation(".mcp.json", `${HOME_DIR}/.claude/.mcp.json`, "platform-configs", "merge-json"),
        ),
        "baseline:platform",
      ).operations,
    ).toEqual([]);
  });

  it("keeps the exact destination the adapter computes for every target", () => {
    const targets = [
      ["claude", `${HOME_DIR}/.claude`, `${HOME_DIR}/.claude/scripts/harness-audit.js`],
      ["codex", `${HOME_DIR}/.codex`, `${HOME_DIR}/.codex/scripts/harness-audit.js`],
      ["cursor", `${PROJECT_ROOT}/.cursor`, `${PROJECT_ROOT}/.cursor/scripts/harness-audit.js`],
      [
        "antigravity",
        `${PROJECT_ROOT}/.agents`,
        `${PROJECT_ROOT}/.agents/scripts/harness-audit.js`,
      ],
      ["gemini", `${PROJECT_ROOT}/.gemini`, `${PROJECT_ROOT}/.gemini/scripts/harness-audit.js`],
      ["zed", `${PROJECT_ROOT}/.zed`, `${PROJECT_ROOT}/.zed/scripts/harness-audit.js`],
    ] as const;
    for (const [target, targetRoot, destination] of targets) {
      const kept = preview(
        planWith(operation("scripts/harness-audit.js", destination)),
        "baseline:commands",
        { projectRoot: PROJECT_ROOT, homeDir: HOME_DIR, target, targetRoot },
      );
      expect(kept.operations, target).toHaveLength(1);
      expect(eccAdapterDestinationV1("scripts/harness-audit.js", target), target).toEqual({
        state: "identity",
      });
    }
  });
});

/**
 * The route itself: `generateEccInstallPreviewArtifact` is the only production
 * caller that passes a verified targetRoot, so it is the only caller whose
 * refusal this decision moves.
 */
describe("the preview generator describes an upstream scaffold operation", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  function writeFixture(
    root: string,
    components: readonly string[],
    operations: readonly Record<string, string>[],
  ): void {
    mkdirSync(resolve(root, "scripts/lib/install-targets"), { recursive: true });
    mkdirSync(resolve(root, "scripts/lib/install"), { recursive: true });
    writeFileSync(resolve(root, "package.json"), '{"name":"ecc-fixture","type":"commonjs"}\n');
    writeFileSync(
      resolve(root, "scripts/lib/install-manifests.js"),
      `exports.listInstallComponents = () => ${JSON.stringify(components.map((id) => ({ id })))};\n`,
    );
    writeFileSync(
      resolve(root, "scripts/lib/install/plan.js"),
      `exports.createManifestInstallPlan = (input) => {
        const operations = ${JSON.stringify(operations)}
          .filter((operation) => operation.target === input.target)
          .map(({ target, ...operation }) => operation);
        return { operations, statePreview: { operations: operations.map((operation) => ({ ...operation })) } };
      };\n`,
    );
    writeFileSync(
      resolve(root, "scripts/lib/install-targets/registry.js"),
      `exports.getInstallTargetAdapter = (target) => ({
        resolveRoot: ({ homeDir, projectRoot }) =>
          (target === "claude" || target === "codex" || target === "opencode" ? homeDir : projectRoot) + "/." + target,
      });\n`,
    );
  }

  it("keeps the exact operation as a described preview row", () => {
    root = mkdtempSync(resolve(tmpdir(), "aih-ecc-preview-route-"));
    writeFixture(
      root,
      ["baseline:commands"],
      [
        {
          target: "claude",
          kind: "copy-file",
          moduleId: "commands-core",
          sourceRelativePath: "scripts/harness-audit.js",
          destinationPath: `${HOME_DIR}/.claude/scripts/harness-audit.js`,
        },
      ],
    );

    const result = generateEccInstallPreviewArtifact(root, PIN);

    expect(result.operations).toContainEqual({
      target: "claude",
      componentId: "baseline:commands",
      kind: "copy-file",
      source: "scripts/harness-audit.js",
      destination: "<home>/.claude/scripts/harness-audit.js",
      contingentOn: "evidence-authorization",
    });
  });

  it("describes scaffold copies, hook scaffolds and the settings merge without a schema change", () => {
    root = mkdtempSync(resolve(tmpdir(), "aih-ecc-preview-route-"));
    writeFixture(
      root,
      ["baseline:platform", "baseline:hooks"],
      [
        {
          target: "claude",
          kind: "copy-file",
          moduleId: "platform-configs",
          sourceRelativePath: ".claude-plugin/plugin.json",
          destinationPath: `${HOME_DIR}/.claude/plugin.json`,
        },
        {
          target: "claude",
          kind: "update-claude-settings",
          moduleId: "hooks-runtime",
          sourceRelativePath: "hooks/hooks.json",
          destinationPath: `${HOME_DIR}/.claude/settings.json`,
        },
        {
          target: "claude",
          kind: "copy-file",
          moduleId: "hooks-runtime",
          sourceRelativePath: "hooks/audit.js",
          destinationPath: `${HOME_DIR}/.claude/hooks/audit.js`,
        },
      ],
    );

    const result = generateEccInstallPreviewArtifact(root, PIN);

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        target: "claude",
        componentId: "baseline:platform",
        kind: "copy-file",
        source: ".claude-plugin/plugin.json",
        destination: "<home>/.claude/plugin.json",
      }),
    );
    // The pinned settings merge is described with the artifact's existing
    // `merge-json` kind: it merges managed hook entries into a host JSON file.
    expect(result.operations).toContainEqual({
      target: "claude",
      componentId: "baseline:hooks",
      kind: "merge-json",
      source: "hooks/hooks.json",
      destination: "<home>/.claude/settings.json",
      contingentOn: "evidence-authorization",
    });
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        target: "claude",
        componentId: "baseline:hooks",
        kind: "copy-file",
        source: "hooks/audit.js",
        destination: "<home>/.claude/hooks/audit.js",
      }),
    );
    // The generator's own runtime rows are untouched.
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        target: "claude",
        componentId: "runtime:ecc-installer",
        kind: "exec",
        source: "scripts/install-apply.js",
      }),
    );
  });
});
