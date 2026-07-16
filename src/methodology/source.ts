import { lstatSync, realpathSync } from "node:fs";
import { hashSourceTree } from "../baseline-evidence/hash.js";
import { AihError } from "../errors.js";
import type { Runner } from "../internals/proc.js";

const GIT_COMMIT = /^[0-9a-f]{40}$/;

export interface ExactLocalSourceRequest {
  repository: string;
  root: string;
  resolvedCommit: string;
}

export interface ExactLocalSource extends ExactLocalSourceRequest {
  treeSha256: string;
}

function sourceFailure(message: string): never {
  throw new AihError(message, "PROVIDER_SOURCE_UNRESOLVED");
}

function realSourceRoot(root: string): string {
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      sourceFailure("source root must be a real directory");
    return realpathSync(root);
  } catch (error) {
    return sourceFailure(`source root is unavailable: ${(error as Error).message}`);
  }
}

async function readHead(root: string, runner: Runner): Promise<string> {
  const result = await runner(["git", "-C", root, "rev-parse", "--verify", "HEAD"]);
  const head = result.stdout.trim();
  if (result.spawnError || result.code !== 0 || !GIT_COMMIT.test(head)) {
    return sourceFailure("source root does not expose an exact local Git HEAD");
  }
  return head;
}

export async function resolveExactLocalSource(
  request: ExactLocalSourceRequest,
  runner: Runner,
): Promise<ExactLocalSource> {
  if (!GIT_COMMIT.test(request.resolvedCommit))
    sourceFailure("requested commit must be a full SHA");
  const root = realSourceRoot(request.root);
  const before = await readHead(root, runner);
  if (before !== request.resolvedCommit)
    sourceFailure("source HEAD does not match the requested commit");
  const tree = hashSourceTree(root);
  const after = await readHead(root, runner);
  if (after !== before) sourceFailure("source HEAD changed during inert qualification");
  return {
    repository: request.repository,
    root,
    resolvedCommit: before,
    treeSha256: tree.treeSha256,
  };
}
