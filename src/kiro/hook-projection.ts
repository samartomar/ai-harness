import { lstatSync } from "node:fs";
import { join } from "node:path";
import { SettingsError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import { type Action, type PlanContext, type WriteAction, writeJson } from "../internals/plan.js";
import { jsonFile } from "../internals/render.js";
import { withExpectedContents } from "../mcp/managed-projection.js";

const MAX_KIRO_HOOK_BYTES = 1024 * 1024;

function hasSymlinkParent(root: string, relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Kiro hook filenames are a shared namespace, not ownership evidence. Refuse a
 * differing or unsafe pre-existing file instead of overwriting it. An exact
 * existing file is left byte-for-byte untouched and remains operator-owned.
 */
export function kiroHookWriteAction(
  ctx: PlanContext,
  path: string,
  hook: unknown,
  describe: string,
): Action | undefined {
  const abs = join(ctx.root, path);
  if (hasSymlinkParent(ctx.root, path)) {
    throw new SettingsError(`refusing Kiro hook behind a symlinked parent: ${path}`);
  }
  let kind: ReturnType<typeof lstatSync> | undefined;
  try {
    kind = lstatSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SettingsError(`refusing unreadable Kiro hook path: ${path}`);
    }
  }
  if (kind === undefined) {
    return withExpectedContents(writeJson(path, hook, describe), undefined);
  }
  if (!kind.isFile()) {
    throw new SettingsError(`refusing non-regular Kiro hook path: ${path}`);
  }
  const current = readRegularFile(abs, { maxBytes: MAX_KIRO_HOOK_BYTES });
  if (current === undefined) {
    throw new SettingsError(`refusing non-regular or unreadable Kiro hook path: ${path}`);
  }
  if (current.toString("utf8") !== jsonFile(hook)) {
    throw new SettingsError(`refusing to overwrite an unowned Kiro hook: ${path}`);
  }
  return {
    ...withExpectedContents(writeJson(path, hook, describe), current.toString("utf8")),
    assertUnchanged: true,
  } satisfies WriteAction;
}
