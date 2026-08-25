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

  // #563 — an evaluator starting from the npm package page (which renders only the
  // README) must be able to reach per-version release notes without cloning.
  it("ships the curated changelog in the published tarball and links it from both surfaces", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    expect(pkg.files).toContain("CHANGELOG.md");

    // The Release body leads with a tag-pinned link, so it can never drift or 404.
    const release = read(".github/workflows/release.yml");
    expect(release).toContain(
      'notes="Curated release notes: [CHANGELOG.md](https://github.com/${GITHUB_REPOSITORY}/blob/${GITHUB_REF_NAME}/CHANGELOG.md)"',
    );
    expect(release).toContain('--generate-notes --notes "$notes"');

    expect(read("README.md")).toContain(
      "[CHANGELOG.md](https://github.com/samartomar/ai-harness/blob/main/CHANGELOG.md)",
    );
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

  it("documents stable-direct as the default and names every required RC trigger", () => {
    const releasing = read("RELEASING.md");

    expect(releasing).toContain("Stable-direct is the default release path");
    expect(releasing).toContain("SHA-bound publication approval");
    expect(releasing).toContain("major-version or schema migration");
    expect(releasing).toContain("evidence format");
    expect(releasing).toContain("publishing machinery");
    expect(releasing).toContain("production-equivalent verification");
    expect(releasing).toContain("publishes under `next` and never touches `latest`");
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

  it("directs global-install verification through the release verifier", () => {
    const coreCandidateVersion = JSON.parse(read("package.json")).version;
    const legacyVersion = "6.1.0";
    const installDocs = [
      "README.md",
      "guides/vibe-developer-guide.md",
      "guides/enterprise-developer-guide.md",
      "guides/enterprise-admin-guide.md",
      // #506 F4: the enterprise onboarding runbook's provisioning step must route
      // global-install provenance through the release verifier — a bare
      // `npm audit signatures` cannot audit a global install (EAUDITGLOBAL).
      "docs/ENTERPRISE_ONBOARDING.md",
    ];
    for (const path of installDocs) {
      const text = read(path);
      const installBlocks = (
        text.match(/```(?:bash|console|powershell)\n[\s\S]*?```/g) ?? []
      ).filter((block) => block.includes("npm install -g @aihq/harness"));
      expect(installBlocks.length).toBeGreaterThan(0);
      for (const block of installBlocks) {
        const installCommand = `npm install -g @aihq/harness@${legacyVersion}`;
        const verifyCommand = `aih verify-release ${legacyVersion}`;
        expect(block).toContain(installCommand);
        expect(block).toContain(verifyCommand);
        const lines = block.split(/\r?\n/gu);
        const commands = lines.map((line) => line.split(" #", 1)[0]?.trim() ?? "");
        const installLine = commands.indexOf(installCommand);
        expect(installLine).toBeGreaterThanOrEqual(0);
        expect(commands[installLine + 1]).toBe(verifyCommand);
        expect(block).not.toContain("npm audit signatures");
      }
      expect(text).toContain("Full release verification requires local `npm`, `gh`, and `cosign`");
      expect(text).toContain("all three legs");
      expect(text).toContain("skipped leg is incomplete evidence");
    }
    // #506 F4: copy-pasteable command blocks in the release verification doc must
    // not carry a bare `npm audit signatures` step either — for a release consumer
    // (global install) it fails with EAUDITGLOBAL; `aih verify-release` runs the
    // signature audit against a temporary prefix instead.
    const slsa = read("docs/security/release-slsa.md");
    for (const block of slsa.match(/```(?:bash|console|powershell)\n[\s\S]*?```/g) ?? []) {
      expect(block).not.toContain("npm audit signatures");
    }
    expect(slsa).toContain("aih verify-release <version>");
    // The current published release remains the frozen legacy package until the
    // separately authorized Core release exists. Guard both fenced and inline pins
    // so the transition cannot present unpublished @aihq/core candidate bytes as installable.
    const onboarding = read("docs/ENTERPRISE_ONBOARDING.md");
    expect(onboarding).toContain("install the approved explicit version (currently");
    expect(onboarding).toContain(`\`npm install -g @aihq/harness@${legacyVersion}\`);`);
    for (const path of [
      "guides/enterprise-developer-guide.md",
      "guides/enterprise-admin-guide.md",
    ]) {
      const text = read(path);
      expect(text).toContain(
        `Release baseline covered by this guide: \`@aihq/harness@${legacyVersion}\`.`,
      );
      expect(text).toContain(
        `For a major-version upgrade, install the approved explicit version (currently\n\`npm install -g @aihq/harness@${legacyVersion}\`); \`npm update -g\` may stay within the current major. Re-run\n\`aih verify-release ${legacyVersion}\` after an upgrade.`,
      );
    }
    const postures = read("guides/postures.md");
    expect(postures).toContain(
      `The current release baseline is \`@aihq/harness@${legacyVersion}\`.`,
    );
    const readme = read("README.md");
    expect(readme).toContain("That legacy package is\nfrozen");
    expect(readme).toContain(`\`@aihq/core@${coreCandidateVersion}\` has not been published`);
    expect(readme).not.toContain(`npm install -g @aihq/core@${coreCandidateVersion}`);
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
