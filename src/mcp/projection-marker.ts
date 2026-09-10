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
      Object.hasOwn(action.json, "nativeMcpProjections") ||
      action.removeJsonKeys?.nativeMcpProjections !== undefined ||
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
    const removes = selected.some((action) => action.removeJsonTopLevelKeys?.includes(key));
    if (writes.length > 0 && removes)
      throw new Error(`MCP ownership action both writes and removes ${key}`);
  }
  const native: Record<string, unknown> = {};
  const nativeRemoves = [
    ...new Set(selected.flatMap((action) => action.removeJsonKeys?.nativeMcpProjections ?? [])),
  ];
  for (const action of selected) {
    const projections = (action.json as Record<string, unknown>).nativeMcpProjections;
    if (!isRecord(projections)) continue;
    for (const [target, receipt] of Object.entries(projections)) {
      if (
        Object.hasOwn(native, target) &&
        JSON.stringify(native[target]) !== JSON.stringify(receipt)
      )
        throw new Error(`conflicting MCP ownership replacement for native target ${target}`);
      if (nativeRemoves.includes(target))
        throw new Error(`MCP ownership action both writes and removes native target ${target}`);
      native[target] = receipt;
    }
  }
  const json = Object.assign(
    {},
    ...selected.map((action) => action.json),
    Object.keys(native).length ? { nativeMcpProjections: native } : {},
  );
  const replaceJsonKeys = [...new Set(selected.flatMap((action) => action.replaceJsonKeys ?? []))];
  const removeJsonTopLevelKeys = [
    ...new Set(selected.flatMap((action) => action.removeJsonTopLevelKeys ?? [])),
  ];
  const coalesced: WriteAction = {
    ...writeJson(AIH_CONFIG_FILE, json, "reconcile MCP projection ownership", {
      merge: true,
      ...(Object.keys(native).length
        ? { replaceJsonChildKeys: { nativeMcpProjections: Object.keys(native) } }
        : {}),
      ...(nativeRemoves.length ? { removeJsonKeys: { nativeMcpProjections: nativeRemoves } } : {}),
      ...(selected.some((action) => action.durable) ? { durable: true } : {}),
      ...(replaceJsonKeys.length === 0 ? {} : { replaceJsonKeys }),
      ...(removeJsonTopLevelKeys.length === 0 ? {} : { removeJsonTopLevelKeys }),
    }),
    expect: first.expect,
    assertAbsentPaths: [...new Set(selected.flatMap((action) => action.assertAbsentPaths ?? []))],
  };
  const output: Action[] = [];
  let remaining = selected.length;
  for (const action of actions) {
    if (!isProjectionMarkerAction(action)) output.push(action);
    else {
      remaining -= 1;
      if (remaining === 0) output.push(coalesced);
    }
  }
  return output;
}
