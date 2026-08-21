import { AIH_CONFIG_FILE } from "../config/marker.js";
import { type Action, type WriteAction, writeJson } from "../internals/plan.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProjectionMarkerAction(action: Action): action is WriteAction {
  return (
    action.kind === "write" &&
    action.path === AIH_CONFIG_FILE &&
    action.merge === true &&
    isRecord(action.json) &&
    (Object.hasOwn(action.json, "managedMcpProjection") ||
      Object.hasOwn(action.json, "kiroMcpProjection") ||
      action.removeJsonTopLevelKeys?.some(
        (key) => key === "managedMcpProjection" || key === "kiroMcpProjection",
      ) === true)
  );
}

/**
 * A plan has one marker snapshot, so independent MCP projectors must commit one
 * marker transition too. The transaction intentionally collapses repeated paths
 * last-wins; coalescing here preserves both receipts and their shared content pin.
 */
export function coalesceMcpProjectionMarkerActions(actions: readonly Action[]): Action[] {
  const selected = actions.filter(isProjectionMarkerAction);
  if (selected.length < 2) return [...actions];
  const first = selected[0];
  if (first === undefined) return [...actions];
  const expect = JSON.stringify(first.expect);
  if (selected.some((action) => JSON.stringify(action.expect) !== expect)) {
    throw new Error("MCP ownership actions were planned from different marker snapshots");
  }
  for (const key of ["managedMcpProjection", "kiroMcpProjection"]) {
    const writes = selected.filter((action) => Object.hasOwn(action.json as object, key));
    if (writes.length > 1) {
      const first = writes[0];
      if (first === undefined) continue;
      const firstValue = JSON.stringify((first.json as Record<string, unknown>)[key]);
      if (
        writes.some(
          (action) => JSON.stringify((action.json as Record<string, unknown>)[key]) !== firstValue,
        )
      ) {
        throw new Error(`conflicting MCP ownership replacement for ${key}`);
      }
    }
    const replaces = selected.some((action) => action.replaceJsonKeys?.includes(key));
    const removes = selected.some((action) => action.removeJsonTopLevelKeys?.includes(key));
    if (replaces && removes)
      throw new Error(`MCP ownership action both replaces and removes ${key}`);
  }
  const json = Object.assign({}, ...selected.map((action) => action.json));
  const replaceJsonKeys = [...new Set(selected.flatMap((action) => action.replaceJsonKeys ?? []))];
  const removeJsonTopLevelKeys = [
    ...new Set(selected.flatMap((action) => action.removeJsonTopLevelKeys ?? [])),
  ];
  const coalesced: WriteAction = {
    ...writeJson(AIH_CONFIG_FILE, json, "reconcile Claude and Kiro MCP projection ownership", {
      merge: true,
      ...(replaceJsonKeys.length === 0 ? {} : { replaceJsonKeys }),
      ...(removeJsonTopLevelKeys.length === 0 ? {} : { removeJsonTopLevelKeys }),
    }),
    expect: first.expect,
  };
  const output: Action[] = [];
  let inserted = false;
  for (const action of actions) {
    if (!isProjectionMarkerAction(action)) output.push(action);
    else if (!inserted) {
      output.push(coalesced);
      inserted = true;
    }
  }
  return output;
}
