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
      needs?: string | readonly string[];
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
}

const root = resolve(import.meta.dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/vendor-baseline-evidence.yml");

describe("vendor baseline evidence publication workflow", () => {
  it("separates unprivileged candidate preparation from environment-gated attestation", () => {
    expect(existsSync(workflowPath)).toBe(true);
    const raw = readFileSync(workflowPath, "utf8");
    const document = parseDocument(raw);
    expect(document.errors).toEqual([]);
    const workflow = document.toJSON() as Workflow;
    const build = workflow.jobs?.build;
    const attest = workflow.jobs?.attest;

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(build?.permissions).toEqual({ contents: "read" });
    expect(build?.environment).toBeUndefined();
    expect(
      build?.steps?.some((step) => step.uses?.startsWith("actions/attest-build-provenance@")),
    ).toBe(false);
    expect(build?.steps?.some((step) => step.uses?.startsWith("actions/download-artifact@"))).toBe(
      false,
    );
    const buildCommands = build?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(buildCommands).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(buildCommands).toContain('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"');
    expect(buildCommands).toContain("npm ci --ignore-scripts");
    expect(buildCommands).toContain("npm run baseline:artifact");

    const upload = build?.steps?.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload?.with).toEqual({
      "if-no-files-found": "error",
      "include-hidden-files": true,
      name: "vendor-baseline-evidence-v1",
      path: ".baseline-evidence-artifact",
    });

    expect(attest?.needs).toBe("build");
    expect(attest?.environment).toBe("baseline-evidence-publish");
    expect(attest?.permissions).toEqual({
      attestations: "write",
      "id-token": "write",
    });
    const download = attest?.steps?.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download?.uses).toBe(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(download?.with).toEqual({
      name: "vendor-baseline-evidence-v1",
      path: ".baseline-evidence-artifact",
    });
    const commands = attest?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(commands).toContain("test -f .baseline-evidence-artifact/SHA256SUMS");
    expect(commands).not.toMatch(
      /npm |git |checkout|npm publish|gh release|gh attestation sign|cosign sign/,
    );
    expect(
      attest?.steps?.some((step) => step.uses?.startsWith("actions/attest-build-provenance@")),
    ).toBe(true);
    expect(raw).not.toMatch(/^\s*(push|pull_request|merge_group):/m);
  });
});
