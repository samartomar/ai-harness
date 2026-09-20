import { SUPPORTED_CLIS } from "../../../internals/clis.js";
import { type ProjectPolicyV1, ProjectPolicyV1Schema } from "../../project-policy-schema.js";
import {
  type WorkbenchOriginV1,
  WorkbenchOriginV1Schema,
  workbenchOriginKey,
} from "../contracts.js";

/**
 * View-model for the user door (P5b). Pure: no DOM, no network. Reads only
 * what the server put in the model and never invents policy data.
 *
 * Contract this page relies on: when `door === "user"` and `policySource`
 * carries a `sha256`, `initialPolicy` is the org policy those bytes were
 * digested from. Without a digest the page cannot tell the packaged default
 * policy from the bound org policy, so it lists nothing and cannot save.
 */

export type TrimUseV1 = "required" | "optional" | "skip";

export interface UserDoorTrimItemV1 {
  readonly assetId: string;
  readonly origin: WorkbenchOriginV1;
  readonly kind: string | undefined;
  readonly label: string | undefined;
  readonly sourceId: string | undefined;
}

export interface UserDoorSourceChipV1 {
  readonly kind: string;
  readonly name: string | undefined;
  readonly valid: boolean;
  readonly error: string | undefined;
  readonly sha256: string | undefined;
}

export interface UserDoorViewModelV1 {
  readonly source: UserDoorSourceChipV1 | undefined;
  readonly items: readonly UserDoorTrimItemV1[];
  /** Asset ids listed under more than one origin: never offered (origin would be a guess). */
  readonly ambiguous: readonly string[];
  readonly aiTools: readonly string[];
  /** True when the org policy names `governance.supportedClis`. */
  readonly aiToolsFromPolicy: boolean;
  readonly schemaVersion: 2 | 3 | undefined;
  /** Server data the page needs but the model does not carry. */
  readonly missing: readonly string[];
  /** Why saving is disabled; undefined when saving is possible. */
  readonly saveBlocked: string | undefined;
  /**
   * The organization's posture floor (`minimumPosture`) from the bound policy.
   * Read only when that policy is the one the digest was taken from, so the
   * packaged default policy can never be shown as the organization's choice.
   */
  readonly posture: "vibe" | "enterprise" | undefined;
  /** Basename of the folder the Workbench server was launched in. */
  readonly folderName: string | undefined;
  /** The `@aihq/core` version the page was rendered by. */
  readonly coreVersion: string | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basename(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const parts = path.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts.at(-1);
}

function sourceChip(model: Record<string, unknown>): UserDoorSourceChipV1 | undefined {
  const source = record(model.policySource);
  if (source === undefined || typeof source.valid !== "boolean") return undefined;
  const sha256 = text(source.sha256);
  return {
    kind: text(source.kind) ?? "none",
    name: basename(text(source.path)),
    valid: source.valid,
    error: text(source.error),
    sha256: sha256 !== undefined && /^[a-f0-9]{64}$/u.test(sha256) ? sha256 : undefined,
  };
}

function originOf(value: unknown): WorkbenchOriginV1 | undefined {
  const parsed = WorkbenchOriginV1Schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The org policy's allowed population, by the same rule
 * `checkProjectPolicyNarrowsV1` accepts: every root's `resolvedItems` plus
 * every request, minus any assetId named in an exclusion. A resolved item
 * inherits its root's origin.
 */
function allowedItems(
  policy: Record<string, unknown>,
  bundle: Record<string, unknown> | undefined,
): { items: UserDoorTrimItemV1[]; ambiguous: string[] } {
  const selections = record(policy.authoringSelections);
  if (selections === undefined) return { items: [], ambiguous: [] };
  const list = (key: string) =>
    Array.isArray(selections[key]) ? (selections[key] as unknown[]) : [];
  const excluded = new Set(
    list("exclusions")
      .map((exclusion) => text(record(exclusion)?.assetId))
      .filter((id): id is string => id !== undefined),
  );
  const origins = new Map<string, Map<string, WorkbenchOriginV1>>();
  const add = (assetId: string | undefined, origin: WorkbenchOriginV1 | undefined) => {
    if (assetId === undefined || origin === undefined || excluded.has(assetId)) return;
    const known = origins.get(assetId) ?? new Map<string, WorkbenchOriginV1>();
    known.set(workbenchOriginKey(origin), origin);
    origins.set(assetId, known);
  };
  for (const rootValue of list("roots")) {
    const root = record(rootValue);
    const origin = originOf(root?.origin);
    const resolved = Array.isArray(root?.resolvedItems) ? (root.resolvedItems as unknown[]) : [];
    for (const item of resolved) add(text(record(item)?.assetId), origin);
  }
  for (const requestValue of list("requests")) {
    const request = record(requestValue);
    add(text(request?.assetId), originOf(request?.origin));
  }
  const assets = record(bundle?.assets);
  const items: UserDoorTrimItemV1[] = [];
  const ambiguous: string[] = [];
  for (const assetId of [...origins.keys()].sort()) {
    const known = [...(origins.get(assetId)?.values() ?? [])];
    const origin = known[0];
    if (known.length !== 1 || origin === undefined) {
      ambiguous.push(assetId);
      continue;
    }
    const asset = record(assets?.[assetId]);
    items.push({
      assetId,
      origin,
      kind: text(asset?.kind),
      label: text(asset?.label),
      sourceId: text(asset?.sourceId),
    });
  }
  return { items, ambiguous };
}

/** `minimumPosture`, but only "vibe" or "enterprise"; anything else is unknown. */
function posture(policy: Record<string, unknown> | undefined): "vibe" | "enterprise" | undefined {
  const value = policy?.minimumPosture;
  return value === "vibe" || value === "enterprise" ? value : undefined;
}

export function userDoorViewModelV1(modelValue: unknown): UserDoorViewModelV1 {
  const model = record(modelValue) ?? {};
  const source = sourceChip(model);
  const policy = record(model.initialPolicy);
  const version = policy?.schemaVersion;
  const schemaVersion: 2 | 3 | undefined = version === 2 || version === 3 ? version : undefined;
  const server = {
    folderName: text(model.folderName),
    coreVersion: text(record(record(model.shell)?.evidence)?.coreVersion),
  };
  const empty = {
    items: [],
    ambiguous: [],
    aiTools: [],
    aiToolsFromPolicy: false,
    schemaVersion,
    // Until the digest proves `initialPolicy` is the bound policy, its posture
    // may be the packaged default's and must not be shown as the org's.
    posture: undefined,
    ...server,
  };
  if (source === undefined)
    return {
      ...empty,
      source,
      missing: ["policySource — which org policy this folder uses"],
      saveBlocked: "No policy source was provided. Saving is disabled.",
    };
  if (!source.valid)
    return {
      ...empty,
      source,
      missing: [],
      saveBlocked: `The policy source is invalid${source.error ? `: ${source.error}` : ""}. Saving is disabled.`,
    };
  if (source.sha256 === undefined)
    return {
      ...empty,
      source,
      missing: [
        "policySource.sha256 — the digest of the bound org policy, for cutFrom.sha256",
        "initialPolicy as the bound org policy — for this door the server passes the packaged default policy, not the policy the folder is bound to",
      ],
      saveBlocked: "The policy digest is unavailable. Saving is disabled.",
    };
  if (policy === undefined || schemaVersion === undefined)
    return {
      ...empty,
      source,
      missing: ["initialPolicy — the bound org policy with schemaVersion 2 or 3"],
      saveBlocked: "The org policy is unavailable. Saving is disabled.",
    };
  const { items, ambiguous } = allowedItems(policy, record(model.workbenchBundle));
  const governance = record(policy.governance);
  const listed = Array.isArray(governance?.supportedClis)
    ? (governance.supportedClis as unknown[]).filter(
        (tool): tool is string =>
          typeof tool === "string" && (SUPPORTED_CLIS as readonly string[]).includes(tool),
      )
    : undefined;
  return {
    source,
    items,
    ambiguous,
    aiTools: listed ?? [...SUPPORTED_CLIS],
    aiToolsFromPolicy: listed !== undefined,
    schemaVersion,
    missing: [],
    // A resolvable, fully-digested policy can still authorize nothing: there is
    // nothing to keep, so saving would only ever produce an empty file.
    saveBlocked:
      items.length === 0 ? "The org policy lists no items. Saving is disabled." : undefined,
    posture: posture(policy),
    ...server,
  };
}

export interface UserDoorSaveInputV1 {
  readonly choices: ReadonlyMap<string, TrimUseV1>;
  readonly forType: "project" | "persona" | "agent";
  readonly forName: string;
  readonly aiTools: readonly string[];
}

export type UserDoorSaveResultV1 =
  | { readonly ok: true; readonly policy: ProjectPolicyV1 }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Build and schema-validate the `aih-project-policy.json` document. Fails closed. */
export function buildProjectPolicyV1(
  view: UserDoorViewModelV1,
  input: UserDoorSaveInputV1,
): UserDoorSaveResultV1 {
  if (view.saveBlocked !== undefined) return { ok: false, errors: [view.saveBlocked] };
  const sha256 = view.source?.sha256;
  if (sha256 === undefined || view.schemaVersion === undefined)
    return { ok: false, errors: ["The policy digest is unavailable. Saving is disabled."] };
  const offered = new Set(view.items.map((item) => item.assetId));
  const unknown = [...input.choices.keys()].filter((assetId) => !offered.has(assetId));
  if (unknown.length > 0)
    return { ok: false, errors: [`Not offered by the org policy: ${unknown.join(", ")}`] };
  const allowedTools = new Set(view.aiTools);
  const aiTools = SUPPORTED_CLIS.filter(
    (tool) => input.aiTools.includes(tool) && allowedTools.has(tool),
  );
  const candidate = {
    schemaVersion: 1,
    kind: "aih-project-policy",
    cutFrom: { schemaVersion: view.schemaVersion, sha256 },
    for: { type: input.forType, name: input.forName.trim() },
    aiTools,
    items: view.items.flatMap((item) => {
      const use = input.choices.get(item.assetId) ?? "optional";
      return use === "skip" ? [] : [{ assetId: item.assetId, origin: item.origin, use }];
    }),
  };
  const parsed = ProjectPolicyV1Schema.safeParse(candidate);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };
  return { ok: true, policy: parsed.data };
}
