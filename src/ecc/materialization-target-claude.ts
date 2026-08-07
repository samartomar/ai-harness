import { isAbsolute, join } from "node:path";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { EccComponentId } from "./components.js";
import { walkManagedRoot } from "./install-manifest.js";
import {
  assertOwnedRelativePath,
  displaySafe,
  MAX_MATERIALIZED_FILE_BYTES,
  MAX_MATERIALIZED_FILES_PER_COMPONENT,
} from "./materialization-receipt.js";
import type { EccEffectiveSelectionComponent } from "./materialization-selection.js";
import type {
  EccMaterializationComponentInput,
  EccMaterializationFileInput,
} from "./materialization-types.js";
import { eccComponentSourcePaths, eccContentDestinationMapping } from "./materialize.js";

/**
 * F4, first target: the Claude target adapter.
 *
 * The F2 resolver reports WHICH components are authorized to materialize; the
 * F1 engine writes bytes it is handed. Neither knows where a component's
 * content lands for a given target. This module is that join: it takes the
 * resolver's evidence-passed components plus the source root holding the
 * pinned framework content, and produces the `files` each component needs —
 * destination-relative path, exact bytes, operation kind.
 *
 * AIH-direct (ruling 5). The framework's own profile installer is never
 * invoked, required, or spawned here: the adapter reads bytes out of a pinned
 * checkout and hands them to AIH's engine, which is what makes per-component
 * control possible at all.
 *
 * Two pieces of knowledge already exist in this repository and are reused
 * rather than restated — `eccComponentSourcePaths` (which source paths a
 * component owns) and `eccContentDestinationMapping` (where one source path
 * lands for one target). A second copy of either would be free to drift from
 * the governed classifier that polices the same boundary.
 *
 * Ownership kind: every file this adapter emits is `copy-file`. A framework
 * content destination — a skill directory, an agent definition, a rule file,
 * the plugin marketplace document — is a whole document authored end to end by
 * exactly one component, so whole-file ownership is what makes removal honest:
 * uninstall takes the file, and an existing operator file at the same path
 * refuses instead of being absorbed. Named-JSON-key ownership exists for
 * destinations SHARED with an operator or another writer, and the two Claude
 * destinations that fit that description are owned by other AIH lifecycles —
 * the client settings file belongs to the hook registrar and usage-hook
 * lifecycle, and MCP configuration belongs to the managed MCP projection — so
 * this adapter never merges into either and refuses a component whose content
 * would land there.
 *
 * Refusals are reported, never silently trimmed. A component materializes only
 * when every file it declares has an owned Claude content destination that can
 * be read; otherwise it is refused whole, by name, with the offending source
 * path. Partial materialization would install something other than what was
 * selected while the receipt claimed the component entire.
 */

/** The target this adapter maps for. Follow-up rows add their own targets. */
export const CLAUDE_MATERIALIZATION_TARGET = "claude";

export type EccTargetRefusalReason =
  | "no-install-descriptor"
  | "unowned-destination"
  | "missing-source"
  | "unreadable-source";

export interface EccTargetRefusal {
  id: string;
  reason: EccTargetRefusalReason;
  detail: string;
}

export interface EccClaudeMaterializationRequest {
  /** Absolute path to the checkout holding the pinned framework content. */
  sourceRoot: string;
  /** The F2 resolver's evidence-passed components, carried through unchanged. */
  components: readonly EccEffectiveSelectionComponent[];
}

export interface EccClaudeMaterializationResult {
  /** Ready for `EccMaterializationRequest.components` — nothing else to attach. */
  components: EccMaterializationComponentInput[];
  refused: EccTargetRefusal[];
}

/** One component's refusal, raised where it is detected and caught per component. */
class TargetRefusal extends Error {
  constructor(
    readonly reason: EccTargetRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "TargetRefusal";
  }
}

interface SourceFile {
  /** Source-root-relative path, the identity the destination mapping answers on. */
  source: string;
  /** What the filesystem resolved it to, so the read is not a second lookup by name. */
  realPath: string;
}

/**
 * The source root must be absolute and a real directory. Absolute because
 * `resolve` would otherwise silently anchor a relative root at the process
 * working directory, and real because a symlinked root would let a pinned
 * checkout point anywhere.
 */
function assertComponentSourceRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error("ECC component source root must be an absolute path");
  }
  const inspected = inspectContainedRelativePath(root, ".");
  if (inspected.state !== "present" || inspected.kind !== "directory") {
    throw new Error(`ECC component source root is not a real directory: ${displaySafe(root)}`);
  }
  return inspected.realPath;
}

/**
 * Expand one declared source path — a file or a directory — into the concrete
 * regular files under it. Symlinks are skipped by the walk rather than
 * followed, so a link inside the pinned checkout cannot pull foreign bytes into
 * a component.
 */
function sourceFiles(sourceRoot: string, declared: string): SourceFile[] {
  const inspected = inspectContainedRelativePath(sourceRoot, declared);
  if (inspected.state === "absent") {
    throw new TargetRefusal(
      "missing-source",
      `the pinned source root carries no ${displaySafe(declared)}`,
    );
  }
  if (inspected.state === "unsafe") {
    throw new TargetRefusal(
      "missing-source",
      `the pinned source path is unsafe (${inspected.reason}): ${displaySafe(declared)}`,
    );
  }
  if (inspected.kind === "file") return [{ source: declared, realPath: inspected.realPath }];
  if (inspected.kind !== "directory") {
    throw new TargetRefusal(
      "missing-source",
      `the pinned source path is not a regular file or directory: ${displaySafe(declared)}`,
    );
  }
  // Bounded one above the engine's own per-component file bound, so a walk that
  // hits its limit can never look like a complete component: the truncated list
  // still exceeds what the engine records, and the engine refuses it there.
  return walkManagedRoot(inspected.realPath, MAX_MATERIALIZED_FILES_PER_COMPONENT + 1).map(
    (relative) => ({
      source: `${declared}/${relative}`,
      realPath: join(inspected.realPath, ...relative.split("/")),
    }),
  );
}

/**
 * Where one source file lands under the Claude destination root, or a refusal.
 * A source with no project-scoped content mapping is one this lifecycle does
 * not own — MCP configuration, host runtime and hook material, and anything
 * else the framework ships outside its content surface all land here.
 */
function claudeDestination(source: string): string {
  const mapping = eccContentDestinationMapping(source, CLAUDE_MATERIALIZATION_TARGET);
  if (mapping === undefined || mapping.scope !== "project") {
    throw new TargetRefusal(
      "unowned-destination",
      `the Claude target owns no content destination for ${displaySafe(source)}`,
    );
  }
  try {
    return assertOwnedRelativePath(mapping.relative);
  } catch (error) {
    throw new TargetRefusal("unowned-destination", (error as Error).message);
  }
}

function sourceBytes(file: SourceFile): Buffer {
  const opened = readRegularFileWithStats(file.realPath, {
    maxBytes: MAX_MATERIALIZED_FILE_BYTES,
  });
  if (opened === undefined) {
    throw new TargetRefusal(
      "unreadable-source",
      `pinned source file is unreadable or larger than this lifecycle materializes: ${displaySafe(file.source)}`,
    );
  }
  return opened.contents;
}

function componentFiles(sourceRoot: string, id: EccComponentId): EccMaterializationFileInput[] {
  let declared: string[];
  try {
    declared = eccComponentSourcePaths(id);
  } catch (error) {
    throw new TargetRefusal("no-install-descriptor", (error as Error).message);
  }
  const files: EccMaterializationFileInput[] = [];
  for (const path of declared) {
    for (const file of sourceFiles(sourceRoot, path)) {
      // Destination first: a source this target does not own refuses without
      // its bytes ever being read.
      files.push({
        path: claudeDestination(file.source),
        kind: "copy-file",
        contents: sourceBytes(file),
      });
    }
  }
  if (files.length === 0) {
    throw new TargetRefusal(
      "missing-source",
      `the pinned source root carries no content for ${displaySafe(id)}`,
    );
  }
  return files;
}

/**
 * Map evidence-passed components onto the Claude target: the `components` half
 * is a complete `EccMaterializationRequest.components`, and the `refused` half
 * names every component that stays visible and unmaterialized, with its reason.
 */
export function resolveEccClaudeMaterialization(
  request: EccClaudeMaterializationRequest,
): EccClaudeMaterializationResult {
  const sourceRoot = assertComponentSourceRoot(request.sourceRoot);
  const components: EccMaterializationComponentInput[] = [];
  const refused: EccTargetRefusal[] = [];
  for (const component of request.components) {
    try {
      components.push({ ...component, files: componentFiles(sourceRoot, component.id) });
    } catch (error) {
      if (!(error instanceof TargetRefusal)) throw error;
      refused.push({ id: component.id, reason: error.reason, detail: error.message });
    }
  }
  return { components, refused };
}
