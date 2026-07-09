import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowDocument {
  jobs: {
    evidence: {
      steps: WorkflowStep[];
    };
  };
}

function readYaml(path: string): WorkflowDocument {
  const doc = parseDocument(read(path));
  expect(doc.errors).toEqual([]);
  return doc.toJSON() as WorkflowDocument;
}

function expectPinnedAction(value: string | undefined, action: string): void {
  expect(value).toBeDefined();
  expect(value).toMatch(
    new RegExp(`^${action}@[a-f0-9]{40}(?:\\\\s+#\\\\s+v\\\\d+\\\\.\\\\d+\\\\.\\\\d+)?$`),
  );
}

describe("release readiness metadata", () => {
  it("declares npm package provenance metadata used by enterprise buyers", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/samartomar/ai-harness.git",
    });
    expect(pkg.homepage).toBe("https://github.com/samartomar/ai-harness#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/samartomar/ai-harness/issues" });
    expect(pkg.publishConfig).toMatchObject({ access: "public" });
  });

  it("names release SBOM artifacts by their actual format", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("SPDX SBOM");
    expect(release).not.toContain("CycloneDX SBOM");
    expect(release).toContain("format: spdx-json");
  });

  it("publishes through npm trusted publishing instead of a long-lived token", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("environment:");
    expect(release).toContain("name: npm-publish");
    expect(release).toMatch(/id-token:\s*write/);
    expect(release).toContain('registry-url: "https://registry.npmjs.org"');
    expect(release).toContain("npm publish ./*.tgz --provenance --access public");
    expect(release).not.toContain("NPM_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
  });

  it("keeps the tag workflow on the same verify gate used by release PRs", () => {
    const release = read(".github/workflows/release.yml");
    const tagGateIndex = release.indexOf("Assert tag commit is current main");
    const setupNodeIndex = release.indexOf("actions/setup-node");
    const npmCiIndex = release.indexOf("npm ci");

    expect(release).toContain(
      "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    );
    expect(release).toContain('if [ "$GITHUB_SHA" != "$main_sha" ]; then');
    expect(release).toContain("npm run verify");
    expect(release).not.toContain("npx vitest run --coverage");
    expect(tagGateIndex).toBeGreaterThan(-1);
    expect(setupNodeIndex).toBeGreaterThan(tagGateIndex);
    expect(npmCiIndex).toBeGreaterThan(tagGateIndex);
  });

  it("documents the SLSA Build L2 release claim and the Build L3 gap", () => {
    const doc = read("docs/security/release-slsa.md");
    expect(doc).toContain("SLSA v1.2");
    expect(doc).toContain("SLSA Build L2");
    expect(doc).toContain("No Build L3 claim is made");
    expect(doc).toContain(".github/workflows/release.yml");
    expect(doc).toContain("actions/attest-build-provenance");
    expect(doc).toContain("npm publish ./*.tgz --provenance --access public");
    expect(doc).toContain("aih verify-release [version]");
    expect(doc).toContain("gh attestation verify");
  });

  it("keeps top-level release docs aligned with the SLSA level claim", () => {
    const readme = read("README.md");
    const architecture = read("docs/ARCHITECTURE.md");
    for (const text of [readme, architecture]) {
      expect(text).toContain("SLSA Build L2");
      expect(text).not.toContain("meets SLSA Build L3");
      expect(text).not.toContain("SLSA v1 provenance material, but the project does not claim");
    }
  });

  it("ships basic repository governance files for controlled rollout", () => {
    expect(existsSync(join(root, ".github", "CODEOWNERS"))).toBe(true);
    expect(existsSync(join(root, "DCO.md"))).toBe(true);
    expect(existsSync(join(root, "TRADEMARKS.md"))).toBe(true);
    // The contract tests' drift guidance points breaking changes at STABILITY.md —
    // the v1 stability contract must exist for those messages to mean anything.
    expect(existsSync(join(root, "STABILITY.md"))).toBe(true);
  });

  it("keeps nightly evidence uploads credential-minimized and visible to upload-artifact", () => {
    const workflow = readYaml(".github/workflows/nightly-safety.yml");
    const steps = workflow.jobs.evidence.steps;
    const checkout = steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    const upload = steps.find((step) => step.name === "Upload nightly evidence");
    const runCommands = steps.map((step) => String(step.run ?? "")).join("\n");

    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    expect(runCommands).toContain("nightly-safety-evidence");
    expect(runCommands).not.toContain(".aih/nightly-safety");
    expect(upload?.with).toMatchObject({
      path: "nightly-safety-evidence/",
      "if-no-files-found": "error",
      "retention-days": 5,
    });
    expect(upload?.with?.["include-hidden-files"]).toBeUndefined();
  });

  it("keeps nightly workflow actions pinned to immutable SHAs", () => {
    const workflow = readYaml(".github/workflows/nightly-safety.yml");
    const steps = workflow.jobs.evidence.steps;

    expectPinnedAction(
      steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"))?.uses,
      "actions/checkout",
    );
    expectPinnedAction(
      steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"))?.uses,
      "actions/setup-node",
    );
    expectPinnedAction(
      steps.find((step) => String(step.uses ?? "").startsWith("actions/upload-artifact@"))?.uses,
      "actions/upload-artifact",
    );
  });
});
