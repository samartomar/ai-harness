import { execFileSync } from "node:child_process";
import { hermeticGitEnv } from "../internals/git-env.js";

/**
 * What one checkout has checked out (its `HEAD` commit). Every production git spawn goes
 * through the repository's hermetic environment, so no inherited `GIT_DIR` can steer it.
 */
export function checkoutHeadV1(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(),
  }).trim();
}

/**
 * Every file path of one commit's tree, read from the checkout's own object store
 * (`git ls-tree -r --name-only`). This is verified commit material: an untracked or
 * modified working-tree file is not in it, so it cannot change what a pinned declaration
 * says its committed material is. The command fails when the object store does not carry
 * the commit; callers turn that into their own typed refusal.
 */
export function committedTreePathsV1(root: string, commit: string): readonly string[] {
  return execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", commit], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hermeticGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((line) => line.length > 0);
}
