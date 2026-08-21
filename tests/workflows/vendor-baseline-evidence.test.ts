import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      environment?: string;
      permissions?: Record<string, string>;
      steps?: Array<{ name?: string; uses?: string; run?: string }>;
    }
  >;
}

const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/vendor-baseline-evidence.yml");

describe("vendor baseline evidence publication workflow", () => {
  it("is manual-only, environment-gated, and has only the permissions needed to attest", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const raw = readFileSync(workflowPath, "utf8");
    const document = parseDocument(raw);
    expect(document.errors).toEqual([]);
    const workflow = document.toJSON() as Workflow;
    const job = workflow.jobs?.attest;

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.environment).toBe("baseline-evidence-publish");
    expect(job?.permissions).toEqual({
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    const commands = job?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(commands).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(commands).toContain('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"');
    expect(commands).toContain("npm run baseline:artifact");
    expect(commands).not.toMatch(/npm publish|gh release|gh attestation sign|cosign sign/);
    expect(
      job?.steps?.some((step) => step.uses?.startsWith("actions/attest-build-provenance@")),
    ).toBe(true);
  });
});
