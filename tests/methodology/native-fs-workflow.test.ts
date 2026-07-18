import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const workflowPath = join(
  process.cwd(),
  ".github",
  "workflows",
  "methodology-native-fs-feasibility.yml",
);
const phaseBranch = "feature/methodology-projection-phase-4a-native-fs-feasibility";
const checkoutPin = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
const setupNodePin = "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e";
const expectedRunners = ["ubuntu-latest", "windows-latest", "macos-latest"];
const expectedCommands = [
  "npm ci --ignore-scripts",
  "npm run build:native-methodology",
  "npm run test:native-methodology",
  "npm test -- tests/methodology",
  "npm run typecheck",
  "npm run lint:ci",
  "npm run docs:lint",
  "npm run verify",
  "npm run build",
  "npm run check:artifacts",
  "git diff --check",
];

interface WorkflowStep {
  readonly uses?: unknown;
  readonly run?: unknown;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly strategy?: {
    readonly "fail-fast"?: unknown;
    readonly matrix?: { readonly os?: unknown };
  };
  readonly "runs-on"?: unknown;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly steps?: unknown;
}

interface WorkflowDocument {
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly jobs?: unknown;
}

function ownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function validateWorkflow(source: string): readonly string[] {
  const errors: string[] = [];
  const document = parseDocument(source);
  if (document.errors.length > 0) return ["workflow-yaml-invalid"];
  const workflow = document.toJSON() as WorkflowDocument;

  const triggers = ownRecord(workflow.on);
  if (
    triggers === undefined ||
    Object.keys(triggers).sort().join(",") !== "push,workflow_dispatch"
  ) {
    errors.push("workflow-triggers-not-closed");
  }
  const push = ownRecord(triggers?.push);
  const branches = push?.branches;
  if (!Array.isArray(branches) || branches.length !== 1 || branches[0] !== phaseBranch) {
    errors.push("push-branch-not-exact");
  }
  const dispatch = ownRecord(triggers?.workflow_dispatch);
  if (dispatch === undefined || Object.keys(dispatch).length !== 0) {
    errors.push("workflow-dispatch-not-closed");
  }
  const permissions = ownRecord(workflow.permissions);
  if (
    permissions === undefined ||
    Object.keys(permissions).length !== 1 ||
    permissions.contents !== "read"
  ) {
    errors.push("permissions-not-read-only");
  }

  const jobs = ownRecord(workflow.jobs);
  if (jobs === undefined || Object.keys(jobs).length !== 1) {
    errors.push("job-set-not-closed");
  }
  const job = ownRecord(jobs?.feasibility) as WorkflowJob | undefined;
  if (job === undefined) errors.push("feasibility-job-missing");
  const runners = job?.strategy?.matrix?.os;
  if (
    !Array.isArray(runners) ||
    runners.length !== expectedRunners.length ||
    expectedRunners.some((runner) => !runners.includes(runner))
  ) {
    errors.push("runner-matrix-incomplete");
  }
  if (job?.strategy?.["fail-fast"] !== false) errors.push("matrix-must-not-fail-fast");
  if (job?.["runs-on"] !== `\${{ matrix.os }}`) {
    errors.push("runner-selection-not-matrix-bound");
  }
  if (
    job?.env?.GIT_CONFIG_COUNT !== "1" ||
    job.env.GIT_CONFIG_KEY_0 !== "commit.gpgsign" ||
    job.env.GIT_CONFIG_VALUE_0 !== "false"
  ) {
    errors.push("fixture-git-signing-not-disabled");
  }

  const steps = Array.isArray(job?.steps) ? (job.steps as WorkflowStep[]) : [];
  const actions = steps.flatMap((step) => (typeof step.uses === "string" ? [step.uses] : []));
  if (actions.length !== 2 || !actions.includes(checkoutPin) || !actions.includes(setupNodePin)) {
    errors.push("required-action-pin-missing");
  }
  if (actions.some((action) => !/@[0-9a-f]{40}$/u.test(action))) {
    errors.push("action-not-sha-pinned");
  }
  if (actions.some((action) => /(?:upload-artifact|actions\/cache)/u.test(action))) {
    errors.push("artifact-upload-or-cache-forbidden");
  }
  const checkout = steps.find((step) => step.uses === checkoutPin);
  if (
    checkout?.with?.["persist-credentials"] !== false ||
    Object.keys(checkout.with).length !== 1
  ) {
    errors.push("checkout-credentials-not-disabled");
  }
  const setupNode = steps.find((step) => step.uses === setupNodePin);
  if (setupNode?.with?.["node-version"] !== "22" || Object.keys(setupNode.with).length !== 1) {
    errors.push("node-version-not-exact");
  }

  const commands = steps.flatMap((step) => (typeof step.run === "string" ? [step.run] : []));
  if (JSON.stringify(commands) !== JSON.stringify(expectedCommands)) {
    errors.push("command-sequence-not-exact");
  }
  for (const command of expectedCommands) {
    if (!commands.includes(command)) errors.push(`required-command-missing:${command}`);
  }
  if (commands.some((command) => /^npm ci(?! --ignore-scripts$)/u.test(command))) {
    errors.push("implicit-install-lifecycle-forbidden");
  }
  if (commands.some((command) => /(?:npm publish|gh release|upload-artifact)/u.test(command))) {
    errors.push("artifact-publication-forbidden");
  }
  if (/continue-on-error\s*:/u.test(source)) errors.push("continue-on-error-forbidden");

  return errors;
}

describe("Phase 4A native filesystem evidence workflow", () => {
  it("keeps the three-OS evidence gate closed and complete", () => {
    expect(validateWorkflow(readFileSync(workflowPath, "utf8"))).toEqual([]);
  });

  it("rejects weakened matrix, action, install, artifact, verification, and failure policy", () => {
    const source = readFileSync(workflowPath, "utf8");
    const weakened = [
      source.replace("      - macos-latest\n", ""),
      source.replace(checkoutPin, "actions/checkout@v7"),
      source.replace("npm ci --ignore-scripts", "npm ci"),
      source.replace(`      - uses: ${setupNodePin}`, "      - uses: actions/upload-artifact@v7"),
      source.replace('          node-version: "22"', '          node-version: "20"'),
      source.replace("        run: npm run verify", "        run: npm run typecheck"),
      `${source}\n    continue-on-error: true\n`,
    ];

    for (const candidate of weakened) {
      expect(validateWorkflow(candidate)).not.toEqual([]);
    }
  });
});
