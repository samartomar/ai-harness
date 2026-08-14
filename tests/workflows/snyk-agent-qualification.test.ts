import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface QualificationWorkflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: {
    qualify: {
      env?: Record<string, string>;
      permissions?: Record<string, string>;
      "runs-on": string;
      steps: WorkflowStep[];
    };
  };
}

const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/snyk-agent-qualification.yml");

function githubExpression(value: string): string {
  return `${String.fromCharCode(36)}{{ ${value} }}`;
}

function readWorkflow(): { raw: string; parsed: QualificationWorkflow } {
  expect(existsSync(workflowPath)).toBe(true);
  const raw = readFileSync(workflowPath, "utf8");
  const document = parseDocument(raw);
  expect(document.errors).toEqual([]);
  return { raw, parsed: document.toJSON() as QualificationWorkflow };
}

function expectPinnedAction(value: string | undefined, action: string): void {
  expect(value).toMatch(new RegExp(`^${action}@[0-9a-f]{40}$`));
}

describe("Snyk Agent Scan behavioral qualification workflow", () => {
  it("is manual-only, read-only, and keeps the secret scoped to the scan step", () => {
    const { raw, parsed } = readWorkflow();
    const job = parsed.jobs.qualify;
    const scan = job.steps.find((step) => step.name === "Run AIH against the synthetic fixture");

    expect(Object.keys(parsed.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(scan?.env).toEqual({ SNYK_TOKEN: githubExpression("secrets.SNYK_TOKEN") });
    expect(raw.match(/secrets\.SNYK_TOKEN/g)).toHaveLength(1);
    expect(raw).not.toMatch(/(?:echo|printf|cat).*SNYK_TOKEN/);
  });

  it("targets only a disposable skill fixture and never enables MCP execution", () => {
    const { raw, parsed } = readWorkflow();
    const commands = parsed.jobs.qualify.steps.map((step) => step.run ?? "").join("\n");

    expect(commands).toMatch(/mktemp -d "\$\{RUNNER_TEMP\}\/aih-snyk-qualification\.XXXXXX"/);
    expect(commands).toContain('node dist/cli.js trust scan "$fixture/skill" --json');
    expect(commands).not.toMatch(/trust scan\s+["']?\.["']?(?:\s|$)/);
    expect(raw).not.toContain(".mcp.json");
    expect(raw).not.toContain("mcpServers");
    expect(raw).not.toContain("--dangerously-run-mcp-servers");
  });

  it("uses immutable actions, the exact locked runtime, and a sanitized short-lived artifact", () => {
    const { parsed } = readWorkflow();
    const steps = parsed.jobs.qualify.steps;
    const commands = steps.map((step) => step.run ?? "").join("\n");
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    const upload = steps.find((step) => step.name === "Upload sanitized qualification evidence");

    expect(parsed.jobs.qualify["runs-on"]).toBe("ubuntu-latest");
    expectPinnedAction(checkout?.uses, "actions/checkout");
    expectPinnedAction(
      steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.uses,
      "actions/setup-node",
    );
    expectPinnedAction(
      steps.find((step) => step.uses?.startsWith("actions/setup-python@"))?.uses,
      "actions/setup-python",
    );
    expectPinnedAction(
      steps.find((step) => step.uses?.startsWith("astral-sh/setup-uv@"))?.uses,
      "astral-sh/setup-uv",
    );
    expectPinnedAction(upload?.uses, "actions/upload-artifact");
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    expect(commands).toContain("tools/trust-scanners/snyk-agent-scan/uv.lock");
    expect(commands).toContain("--locked");
    expect(commands).toContain("snyk-agent-scan help");
    expect(commands).toContain("snyk-agent-scan@uv:0.5.17");
    expect(upload?.with).toMatchObject({
      path: `${githubExpression("runner.temp")}/aih-snyk-qualification-summary.json`,
      "if-no-files-found": "error",
      "retention-days": 5,
    });
  });
});
