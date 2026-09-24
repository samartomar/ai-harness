import { assertOwnedRelativePath, displaySafe } from "./materialization-receipt.js";
import { eccContentDestinationMapping } from "./materialize.js";

/**
 * Where a governed ECC target places one pinned source file. Core keeps only
 * the destination inspection that sealed historical runtime descriptors are
 * checked against (`runtime-adapter-compatibility.ts`); governed
 * materialization itself lives in `@aihq/framework-ecc`.
 *
 * `eccContentDestinationMapping` is the one answer to where a source path
 * lands for a target, so this inspection reuses it rather than restating it. A
 * source with no project-scoped content mapping for the target refuses, by
 * name, with the offending source path.
 */

export type EccMaterializationTarget = "claude" | "codex" | "kimi" | "cursor" | "opencode" | "kiro";

/**
 * Operator-facing names. The CLI registry's labels are product names ("Claude
 * Code", "Codex CLI") and read wrong inside "refused by the … target"; these
 * are the target's own spelling and nothing else derives from them.
 */
const TARGET_NAME: Readonly<Record<EccMaterializationTarget, string>> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  cursor: "Cursor",
  opencode: "OpenCode",
  kiro: "Kiro",
};

export type EccTargetRefusalReason =
  | "no-install-descriptor"
  | "unowned-destination"
  | "missing-source"
  | "unreadable-source"
  | "duplicate-destination"
  | "unsupported-component";

/** One source file's refusal, raised where it is detected. */
class TargetRefusal extends Error {
  constructor(
    readonly reason: EccTargetRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "TargetRefusal";
  }
}

/**
 * Where one source file lands under this target's destination root, or a
 * refusal. A source with no project-scoped content mapping FOR THIS TARGET is
 * one this lifecycle does not own for it — MCP configuration, host runtime and
 * hook material, another runtime's home-scoped bootloader, and a surface that
 * belongs exclusively to a different target all land here. The governed root is
 * the project root, so a home-scoped mapping is a refusal, not a second root.
 */
function targetDestination(source: string, target: EccMaterializationTarget): string {
  const mapping = eccContentDestinationMapping(source, target);
  if (mapping === undefined || mapping.scope !== "project") {
    throw new TargetRefusal(
      "unowned-destination",
      `the ${TARGET_NAME[target]} target owns no content destination for ${displaySafe(source)}`,
    );
  }
  try {
    return assertOwnedRelativePath(mapping.relative);
  } catch (error) {
    throw new TargetRefusal("unowned-destination", (error as Error).message);
  }
}

/**
 * Pure adapter inspection for sealed historical descriptors. It uses the same
 * destination resolver as materialization and reads no source bytes.
 */
export function inspectEccTargetDestinationV1(
  source: string,
  target: EccMaterializationTarget,
  componentId?: string,
):
  | { state: "mapped"; scope: "project" | "home"; relative: string }
  | { state: "refused"; reason: EccTargetRefusalReason } {
  try {
    const qualifiedCommands =
      componentId === "baseline:commands" || componentId === "module:commands-core";
    if (
      qualifiedCommands &&
      (source === "scripts/harness-audit.js" ||
        source === "scripts/skills-health.js" ||
        source.startsWith("scripts/lib/"))
    ) {
      return { state: "mapped", scope: "project", relative: source };
    }
    if (qualifiedCommands && target === "codex" && /^commands\/.+\.md$/.test(source)) {
      const id = source.slice("commands/".length, -".md".length);
      return {
        state: "mapped",
        scope: "project",
        relative: `.agents/skills/ecc-workflow-${id}/SKILL.md`,
      };
    }
    if (target === "codex" && /^agents\/[a-z0-9][a-z0-9_-]*\.md$/.test(source)) {
      return {
        state: "mapped",
        scope: "project",
        relative: `.codex/agents/${source.slice("agents/".length, -".md".length)}.toml`,
      };
    }
    const mapping = targetDestination(source, target);
    const direct = eccContentDestinationMapping(source, target);
    if (direct === undefined || direct.scope !== "project" || direct.relative !== mapping) {
      throw new Error("governed target destination resolver drift");
    }
    return { state: "mapped", scope: direct.scope, relative: direct.relative };
  } catch (error) {
    if (error instanceof TargetRefusal) return { state: "refused", reason: error.reason };
    throw error;
  }
}
