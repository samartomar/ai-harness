import { isAbsolute, join } from "node:path";
import { AihError } from "../errors.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { EccComponentId } from "./components.js";
import { walkManagedRoot } from "./install-manifest.js";
import {
  assertOwnedRelativePath,
  destinationIdentity,
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
 * F4: the target adapter for governed materialization, parameterized by target.
 *
 * The F2 resolver reports WHICH components are authorized to materialize; the
 * F1 engine writes bytes it is handed. Neither knows where a component's
 * content lands for a given target. This module is that join: it takes the
 * resolver's evidence-passed components, the source root holding the pinned
 * framework content, and the REQUESTED target set, and produces the `files`
 * each component needs — destination-relative path, exact bytes, operation kind.
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
 * the governed classifier that polices the same boundary. That mapping is
 * already target-aware, so ONE resolver serves every target; a per-target copy
 * of this file would be a second answer to the same question.
 *
 * Ownership kind: every file this adapter emits is `copy-file`. A framework
 * content destination — a skill directory, an agent definition, a rule file,
 * the plugin marketplace document — is a whole document authored end to end by
 * exactly one component, so whole-file ownership is what makes removal honest:
 * uninstall takes the file, and an existing operator file at the same path
 * refuses instead of being absorbed. Named-JSON-key ownership exists for
 * destinations SHARED with an operator or another writer, and every such
 * destination a framework target has is owned by other AIH lifecycles — client
 * settings belong to the hook registrar and usage-hook lifecycle, and MCP
 * configuration (`.mcp.json`, `mcp.json`, `opencode.json`, `config.toml`)
 * belongs to the managed MCP projection — so this adapter never merges into any
 * of them and refuses a component whose content would land there.
 *
 * Refusals are reported, never silently trimmed, and they are PER TARGET: a
 * component materializes for a target only when every file it declares has an
 * owned content destination for THAT target that can be read; otherwise that
 * target refuses it whole, by name, with the offending source path. Partial
 * materialization would install something other than what was selected while
 * the receipt claimed the component entire.
 */

/**
 * The five targets the governed materialization lifecycle is ruled for.
 * Everything else — zed, gemini, kiro, antigravity, copilot, windsurf — waits,
 * and says so by name rather than by silently doing nothing.
 */
export const GOVERNED_MATERIALIZATION_TARGETS = [
  "claude",
  "codex",
  "kimi",
  "cursor",
  "opencode",
] as const;

export type EccMaterializationTarget = (typeof GOVERNED_MATERIALIZATION_TARGETS)[number];

/**
 * The ruled targets actually DELIVERED. Rows land one at a time, so a ruled
 * target that has not landed yet refuses naming what is wired — the same
 * discipline the lifecycle's other refusals follow. Adding a target to this
 * list is what ships its row.
 *
 * All five are wired: this list now EQUALS the governed list, which is the
 * completion of F4. `tests/ecc/materialization-target.test.ts` pins that
 * equality, so a sixth governed target cannot be added without deciding what
 * the unwired branch below should say about it.
 */
export const WIRED_MATERIALIZATION_TARGETS: readonly EccMaterializationTarget[] = [
  "claude",
  "codex",
  "kimi",
  "cursor",
  "opencode",
];

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
};

/** The name this lifecycle calls a target by, in reports and refusals. */
export function eccMaterializationTargetName(target: EccMaterializationTarget): string {
  return TARGET_NAME[target];
}

function isGovernedTarget(value: string): value is EccMaterializationTarget {
  return (GOVERNED_MATERIALIZATION_TARGETS as readonly string[]).includes(value);
}

/**
 * What an operator does next after either refusal. Named because the target set
 * can come from a COMMITTED `.aih-config.json`, which the operator may not have
 * in mind while running this command: without the remedy the refusal reads as a
 * dead end rather than as one flag away. Narrowing to the wired subset silently
 * is what this lifecycle will not do — that would materialize less than the
 * workstation configuration says, which is the substitution the design refuses.
 */
function wiredTargetRemedy(): string {
  return `pass \`--cli ${WIRED_MATERIALIZATION_TARGETS.join(",")}\` (or any subset of it) to materialize for the wired targets — an explicit \`--cli\` outranks the committed \`.aih-config.json\` targets`;
}

/**
 * Narrow a requested CLI list to governed materialization targets, or refuse by
 * name. Two distinct refusals, because they mean different things to whoever
 * reads them: a CLI outside the ruled five is not a materialization target at
 * all, while a ruled one that has not landed yet is a row still to come. Both
 * name what IS wired and how to ask for it, so neither reads as "AIH does
 * nothing here" or as a dead end.
 */
export function assertGovernedMaterializationTargets(
  requested: readonly string[],
): EccMaterializationTarget[] {
  const wired = WIRED_MATERIALIZATION_TARGETS.join(", ");
  const unruled = requested.filter((cli) => !isGovernedTarget(cli));
  if (unruled.length > 0) {
    throw new AihError(
      `materialization capability gate refused governed ECC framework materialization: ${unruled.map((cli) => displaySafe(cli)).join(", ")} is not a governed materialization target — the governed targets are ${GOVERNED_MATERIALIZATION_TARGETS.join(", ")}, of which ${wired} ${WIRED_MATERIALIZATION_TARGETS.length === 1 ? "is" : "are"} wired today; ${wiredTargetRemedy()}`,
      "AIH_CONFIG",
    );
  }
  const targets = requested.filter(isGovernedTarget);
  const unwired = targets.filter((target) => !WIRED_MATERIALIZATION_TARGETS.includes(target));
  // Unreachable while the two target lists are equal, which they are today. Kept
  // as the fail-closed guard for the edit that adds a sixth governed target:
  // without it that target would materialize nothing and report success.
  if (unwired.length > 0) {
    throw new AihError(
      `materialization capability gate refused governed ECC framework materialization: the ${unwired.map((target) => TARGET_NAME[target]).join(", ")} target is a governed materialization target that is not wired yet — ${wired} ${WIRED_MATERIALIZATION_TARGETS.length === 1 ? "is" : "are"} wired today; ${wiredTargetRemedy()}`,
      "AIH_CONFIG",
    );
  }
  // `resolveClis` never returns an empty list, so an empty target set here means
  // a caller built one by hand; materializing nothing for nobody is not a
  // request this lifecycle can honour.
  if (targets.length === 0) {
    throw new AihError(
      "materialization capability gate refused governed ECC framework materialization: no target was requested",
      "AIH_CONFIG",
    );
  }
  return [...new Set(targets)];
}

export type EccTargetRefusalReason =
  | "no-install-descriptor"
  | "unowned-destination"
  | "missing-source"
  | "unreadable-source"
  | "duplicate-destination";

export interface EccTargetRefusal {
  id: string;
  reason: EccTargetRefusalReason;
  detail: string;
}

/** The same refusal, carrying WHICH target refused — the multi-target report needs it. */
export interface EccTargetedRefusal extends EccTargetRefusal {
  target: EccMaterializationTarget;
}

export interface EccTargetMaterializationRequest {
  /** Absolute path to the checkout holding the pinned framework content. */
  sourceRoot: string;
  /** The requested governed targets, already narrowed by the assertion above. */
  targets: readonly EccMaterializationTarget[];
  /** The F2 resolver's evidence-passed components, carried through unchanged. */
  components: readonly EccEffectiveSelectionComponent[];
}

export interface EccTargetMaterializationResult {
  /** Ready for `EccMaterializationRequest.components` — nothing else to attach. */
  components: EccMaterializationComponentInput[];
  refused: EccTargetedRefusal[];
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

/**
 * The first pair of destinations in ONE target's list that resolve to the same
 * owned file, or `undefined`. Two spellings collide when `destinationIdentity`
 * folds them together — it folds Unicode normalization AND case, because both
 * resolve to one file on the platforms AIH targets. A pinned checkout carrying
 * `café.md` in NFC beside `café.md` in NFD (NTFS and ext4 both store those as
 * two entries), or `README.md` beside `readme.md` on a case-sensitive volume,
 * declares two sources for one destination.
 *
 * Exported because the folding, not the filesystem, is what has to be pinned:
 * neither pair can be CREATED on every platform, so the probe that proves this
 * rule holds must be able to hand it the pair directly.
 */
export function foldedDestinationCollision(
  paths: readonly string[],
): { first: string; second: string } | undefined {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const first = seen.get(destinationIdentity(path));
    if (first !== undefined) return { first, second: path };
    seen.set(destinationIdentity(path), path);
  }
  return undefined;
}

function componentFiles(
  sourceRoot: string,
  id: EccComponentId,
  target: EccMaterializationTarget,
): EccMaterializationFileInput[] {
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
        path: targetDestination(file.source, target),
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
  // Two of this ONE target's own sources claiming one destination is a defect in
  // the pinned checkout, not a shared row: the cross-target union below collapses
  // by the same folded identity, so without this the second file would vanish and
  // the component would install one file short, with the survivor decided by
  // directory enumeration order. Refuse the component for this target instead —
  // all-or-nothing, like every other refusal here.
  const collision = foldedDestinationCollision(files.map((file) => file.path));
  if (collision !== undefined) {
    throw new TargetRefusal(
      "duplicate-destination",
      `two pinned sources claim one ${TARGET_NAME[target]} destination: ${displaySafe(collision.first)} and ${displaySafe(collision.second)} differ only by Unicode normalization or case`,
    );
  }
  return files;
}

/**
 * Map evidence-passed components onto the requested targets: the `components`
 * half is a complete `EccMaterializationRequest.components`, and the `refused`
 * half names every component a target left unmaterialized, with its reason and
 * that target.
 *
 * A request for N targets emits, per component, the UNION of its per-target
 * destinations in ONE list — the receipt already holds N paths per component,
 * so there is no second receipt and no per-target root. Destinations two
 * targets share (`AGENTS.md`, `.agents/plugins/`, `.agents/skills/`) collapse on
 * `destinationIdentity`, the same folded identity every ownership guard uses;
 * without that collapse the engine would see one component claiming one
 * destination twice and refuse the whole request.
 *
 * That collapse is CROSS-target only, and it is safe for exactly one reason: a
 * destination two targets agree on comes from a mapping row with no target in
 * it, so both spellings are the identical string produced from the identical
 * source file. Two spellings that merely FOLD together never reach here — they
 * are a defect inside one target's own list, and `componentFiles` refuses the
 * component for that target before the union sees either of them.
 *
 * A target that refuses a component does not veto the others: the component
 * still materializes for the targets that own it, and the refusal is reported
 * against the target that made it.
 */
export function resolveEccTargetMaterialization(
  request: EccTargetMaterializationRequest,
): EccTargetMaterializationResult {
  const sourceRoot = assertComponentSourceRoot(request.sourceRoot);
  const components: EccMaterializationComponentInput[] = [];
  const refused: EccTargetedRefusal[] = [];
  for (const component of request.components) {
    const union = new Map<string, EccMaterializationFileInput>();
    for (const target of request.targets) {
      try {
        for (const file of componentFiles(sourceRoot, component.id, target)) {
          const identity = destinationIdentity(file.path);
          if (!union.has(identity)) union.set(identity, file);
        }
      } catch (error) {
        if (!(error instanceof TargetRefusal)) throw error;
        refused.push({ target, id: component.id, reason: error.reason, detail: error.message });
      }
    }
    if (union.size > 0) components.push({ ...component, files: [...union.values()] });
  }
  return { components, refused };
}
