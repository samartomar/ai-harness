import { readAihConfig } from "../config/marker.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { LARGE_REPO_FILE_THRESHOLD, trackedFileCount } from "../scale-safety.js";
import { PROJECT_CONTRACT_FILE, readProjectContract } from "./schema.js";
import { unportablePaths } from "./synth.js";

/**
 * `aih doctor`'s read-only contract probe — validate the COMMITTED `project.json`
 * without re-deriving it.
 *
 *  - No contract on disk → `skip`: a pre-init or `--canon legacy` repo is not broken.
 *  - A non-portable path in the contract → `fail` (`contract.path-unportable`): a
 *    committed `..` / absolute / drive-letter path misleads the next agent on another
 *    machine, so the doctor fails closed and the exit flips.
 *  - Otherwise `pass`. Deep staleness validation (re-deriving the whole stack to confirm
 *    the contract is current) is graph territory on a LARGE repo, so it is deferred to the
 *    sibling `large-repo graph safety` probe ({@link scaleSafetyCheck}) rather than forced
 *    here — doctor never false-fails a big repo. Reuses {@link trackedFileCount} +
 *    {@link LARGE_REPO_FILE_THRESHOLD} for that gate.
 */
export async function contractTruthCheck(ctx: PlanContext): Promise<Check> {
  const name = "contract truth";
  // Honor the committed context dir (like doctor + classifyCanon), not just the flag.
  const contextDir = readAihConfig(ctx.root)?.contextDir ?? ctx.contextDir;
  const contract = readProjectContract(ctx.root, contextDir);
  if (contract === undefined) {
    return { name, verdict: "skip", detail: "no contract — run `aih contract --apply`" };
  }
  const bad = unportablePaths(contract);
  if (bad.length > 0) {
    return {
      name,
      verdict: "fail",
      code: "contract.path-unportable",
      detail: `non-portable path(s) in ${contextDir}/${PROJECT_CONTRACT_FILE}: ${bad.join(", ")}`,
    };
  }
  const live = await trackedFileCount(ctx);
  if (live !== undefined && live >= LARGE_REPO_FILE_THRESHOLD) {
    return {
      name,
      verdict: "pass",
      detail: `paths portable; deep validation deferred to large-repo graph safety (${live} files)`,
    };
  }
  return { name, verdict: "pass", detail: "contract present; every path is portable" };
}
