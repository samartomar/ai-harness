import {
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  probe,
  writeText,
} from "../internals/plan.js";
import { gitleaksToml } from "./gitleaks.js";
import { preCommitConfigYaml } from "./precommit.js";
import { blockingLicenses, scaWorkflowYaml } from "./sca.js";
import { taxonomyDoc } from "./taxonomy.js";

const GITLEAKS_PATH = ".gitleaks.toml";
const PRECOMMIT_PATH = ".pre-commit-config.yaml";
const SCA_PATH = ".github/workflows/sca.yml";

/** Path of the taxonomy doc under the (configurable) canonical context dir. */
function taxonomyPath(ctx: PlanContext): string {
  return `${ctx.contextDir}/guardrails-taxonomy.md`;
}

/** CI guidance: the SCA workflow runs in the customer's pipeline, never here. */
function ciNote(): string {
  const blocking = blockingLicenses().join(", ");
  return [
    "The SCA license gate runs in YOUR CI, not from this CLI. aih only writes the",
    `workflow file (${SCA_PATH}); GitHub Actions executes it on push / pull_request.`,
    "",
    "To activate it:",
    "  1. Commit the generated workflow and push.",
    "  2. Make the `license-gate` job a required status check on protected branches",
    "     (Settings -> Branches -> branch protection rules).",
    `  3. Confirm the gate blocks strong / network copyleft (${blocking}).`,
    "",
    "On other CI systems (GitLab CI, Azure Pipelines, Jenkins), port the SBOM scan +",
    "the blocked-license grep into the equivalent pipeline stage.",
  ].join("\n");
}

/**
 * Generate the repo's security guardrails: a gitleaks secret-scanning config, a
 * pre-commit gate that runs it, a CI license-compliance workflow that blocks
 * AGPL / strong copyleft, and the control-taxonomy doc. Every action is a local
 * write or human-facing doc — CI execution is left to the customer's pipeline.
 */
function guardrailsPlan(ctx: PlanContext): ReturnType<typeof plan> {
  return plan(
    "guardrails",
    writeText(
      GITLEAKS_PATH,
      gitleaksToml(),
      "Secret-scanning policy: gitleaks defaults + enterprise AWS/private-key rules",
    ),
    writeText(
      PRECOMMIT_PATH,
      preCommitConfigYaml(),
      "Pre-commit gate: run gitleaks (and lint) on every commit",
    ),
    writeText(
      SCA_PATH,
      scaWorkflowYaml(),
      "CI SCA workflow: license scan that fails on AGPL / strong copyleft",
    ),
    doc(
      "Golden Paths / Guardrails / Safety Nets control taxonomy",
      taxonomyDoc(),
      taxonomyPath(ctx),
    ),
    doc("CI license gate runs in your pipeline, not from aih", ciNote()),
    probe("gitleaks present", async (c) => {
      const res = await c.run(["gitleaks", "version"]);
      if (res.spawnError) {
        return {
          name: "gitleaks present",
          verdict: "skip",
          detail: "gitleaks not on PATH — install to enforce the pre-commit gate",
        };
      }
      const version = res.stdout.trim() || res.stderr.trim();
      return res.code === 0
        ? { name: "gitleaks present", verdict: "pass", detail: version || "installed" }
        : { name: "gitleaks present", verdict: "fail", detail: version || `exit ${res.code}` };
    }),
  );
}

export const command: CommandSpec = {
  name: "guardrails",
  summary: "Generate gitleaks + pre-commit guardrails and a CI license-compliance gate",
  options: [],
  plan: guardrailsPlan,
};
