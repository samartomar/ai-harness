import { posix } from "node:path";
import type { CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { scanRepo } from "../profile/scan.js";
import {
  PROJECT_CONTRACT_FILE,
  PROJECT_DOC_FILE,
  type ProjectContract,
  projectContractJson,
  SETUP_DOC_FILE,
} from "./schema.js";
import { synthesizeContract, unportablePaths } from "./synth.js";
import { projectContractDoc, setupDoc } from "./templates.js";

/**
 * The portable-paths invariant as a verification {@link Check}: every path-like value
 * in the contract must be a portable repo-relative POSIX path. `pass` clean; `fail`
 * (flipping the exit under `--verify`) on any `..`/absolute/drive-letter value. The
 * `Check.code` is intentionally absent here — the `contract.path-unportable` taxonomy
 * member and the doctor wiring land in PR 1D; an un-routed `fail` still gates correctly.
 */
export function portablePathsCheck(contract: ProjectContract): Check {
  const name = "contract portable-paths";
  const bad = unportablePaths(contract);
  if (bad.length === 0) {
    return {
      name,
      verdict: "pass",
      detail: "every contract path is a portable repo-relative POSIX path",
    };
  }
  return {
    name,
    verdict: "fail",
    code: "contract.path-unportable",
    detail: `non-portable path(s) in ${PROJECT_CONTRACT_FILE}: ${bad.join(", ")}`,
  };
}

/**
 * Plan the repo contract: scan the tree once, synthesize the contract object, and emit
 * exactly two actions — a merged `project.json` write (preserving any user-added keys)
 * and the portable-paths probe. No prose, no exec; the human mirror (`project.md`) and
 * `setup.md` are PR 1B, the init wiring is PR 1C. The write is schema-validated through
 * {@link projectContractJson} so only a conformant contract is ever persisted.
 */
async function contractPlan(ctx: PlanContext): Promise<Plan> {
  const dir = ctx.contextDir;
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: dir });
  const contract = projectContractJson(await synthesizeContract(ctx, stack));
  return plan(
    "contract",
    writeJson(
      posix.join(dir, PROJECT_CONTRACT_FILE),
      contract,
      "machine-readable repo contract (the project.json seam)",
      { merge: true },
    ),
    // The human mirror is regenerated each run (NOT once) — it tracks project.json.
    writeText(
      posix.join(dir, PROJECT_DOC_FILE),
      projectContractDoc(dir, contract),
      "human-readable contract mirror (rendered from project.json)",
    ),
    // The setup seed is write-once: a team owns and edits it.
    writeText(
      posix.join(dir, SETUP_DOC_FILE),
      setupDoc(dir, contract),
      "first-run setup checklist (write-once)",
      { once: true },
    ),
    probe("contract portable-paths", () => portablePathsCheck(contract)),
  );
}

export const command: CommandSpec = {
  name: "contract",
  summary: "Synthesize the machine-readable repo contract (project.json) from the detected stack",
  options: [],
  plan: contractPlan,
};
