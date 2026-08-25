import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function inlineModuleFollowing(workflow: string, marker: string): string {
  const markerIndex = workflow.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const delimiterIndex = workflow.indexOf("<<'NODE'\n", markerIndex);
  expect(delimiterIndex).toBeGreaterThanOrEqual(0);
  const bodyStart = delimiterIndex + "<<'NODE'\n".length;
  const bodyEnd = workflow.indexOf("\n          NODE", bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return workflow.slice(bodyStart, bodyEnd).replace(/^ {10}/gmu, "");
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
    expect(release).toContain("--generate-notes");
    expect(release).toContain('--notes "$notes"');

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

  it("constrains the temporary npm-token bootstrap to the first exact Core release", () => {
    const release = read(".github/workflows/release.yml");
    expect(parseDocument(release).errors).toEqual([]);
    expect(release).toContain("environment:");
    expect(release).toContain("name: npm-publish");
    expect(release).toMatch(/id-token:\s*write/);
    expect(release).toContain('registry-url: "https://registry.npmjs.org"');
    expect(release).toContain("if: github.ref == 'refs/tags/v-core-0.1.0'");
    expect(release).toContain('test "$GITHUB_REF_NAME" = "v-core-0.1.0"');
    expect(release).toContain(
      'npm view "@aihq/core" name --json --registry "https://registry.npmjs.org/"',
    );
    expect(release.match(/npm view "@aihq\/core" name --json/gu)).toHaveLength(2);
    expect(release.match(/--loglevel silent/gu)).toHaveLength(2);
    expect(release.match(/REGISTRY_OBSERVATION=/gu)).toHaveLength(2);
    expect(release).not.toContain("grep -Eq 'E404'");
    expect(release).toContain("secrets.NPM_BOOTSTRAP_TOKEN");
    expect(release.match(/secrets\.NPM_BOOTSTRAP_TOKEN/gu)).toHaveLength(1);
    expect(release).toContain('npm whoami --registry "https://registry.npmjs.org/" >/dev/null');
    expect(release).toContain(['if [ -z "$', '{NODE_AUTH_TOKEN:-}" ]; then'].join(""));
    expect(release).toContain(
      'npm publish "$tarball" --ignore-scripts --provenance --access public --registry "https://registry.npmjs.org/"',
    );
    expect(release).not.toContain("NPM_TOKEN");

    const verificationStart = release.indexOf("  verify-and-pack:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    const verification = release.slice(verificationStart, publishStart);
    expect(verification).toContain("Refuse every tag outside the temporary bootstrap boundary");
    expect(verification).toContain('run: test "$GITHUB_REF_NAME" = "v-core-0.1.0"');
    expect(verification).not.toContain("NODE_AUTH_TOKEN");
    expect(verification).not.toContain("NPM_BOOTSTRAP_TOKEN");

    const releasing = read("RELEASING.md");
    expect(releasing).toContain("**Bypass 2FA** enabled");
    expect(releasing).toContain("delete the GitHub `NPM_BOOTSTRAP_TOKEN` secret");
    expect(releasing).toContain("revoke the npm token");
    expect(releasing).toMatch(/restores trusted-publisher-only\s+publication/u);

    const actions = [...release.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+).*$/gmu)];
    expect(actions.length).toBeGreaterThanOrEqual(7);
    for (const [, action, revision] of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+$/u);
      expect(revision).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("parses npm package-absence evidence as one exact JSON E404 error", () => {
    const release = read(".github/workflows/release.yml");
    const validator = inlineModuleFollowing(release, "REGISTRY_OBSERVATION=");
    const validate = (observation: string) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
        env: { ...process.env, REGISTRY_OBSERVATION: observation },
        encoding: "utf8",
      });

    expect(validate(JSON.stringify({ error: { code: "E404", summary: "missing" } })).status).toBe(
      0,
    );
    expect(
      validate(JSON.stringify({ error: { code: "E500", summary: "upstream mentioned E404" } }))
        .status,
    ).not.toBe(0);
    expect(validate('npm ERR! code E500\n{"error":{"code":"E404"}}').status).not.toBe(0);
  });

  it("rejects a packed manifest that tries to redirect npm publication", () => {
    const release = read(".github/workflows/release.yml");
    const validator = inlineModuleFollowing(release, "Validate packed manifest identity");
    const fixtureRoot = mkdtempSync(join(tmpdir(), "aih-release-manifest-"));
    try {
      const packageRoot = join(fixtureRoot, "package");
      mkdirSync(packageRoot);
      const validate = (publishConfig: Record<string, unknown>) => {
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "@aihq/core", version: "0.1.0", publishConfig }),
        );
        execFileSync("tar", ["-czf", "candidate.tgz", "package"], { cwd: fixtureRoot });
        return spawnSync(process.execPath, ["--input-type=module", "-", "candidate.tgz", "0.1.0"], {
          cwd: fixtureRoot,
          input: validator,
          encoding: "utf8",
        });
      };

      expect(validate({ access: "public" }).status).toBe(0);
      expect(validate({ access: "public", registry: "https://attacker.invalid/" }).status).not.toBe(
        0,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("isolates candidate execution from protected publication permissions", () => {
    const release = read(".github/workflows/release.yml");
    const verificationStart = release.indexOf("  verify-and-pack:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    expect(verificationStart).toBeGreaterThanOrEqual(0);
    expect(publishStart).toBeGreaterThan(verificationStart);

    const verification = release.slice(verificationStart, publishStart);
    const publication = release.slice(publishStart);

    expect(verification).toMatch(/permissions:\n\s+contents:\s*read/);
    expect(verification).not.toMatch(/(?:id-token|attestations):\s*write/);
    expect(verification).not.toMatch(/contents:\s*write/);
    expect(verification).toContain("npm run verify");
    expect(verification).toContain("npm pack --ignore-scripts");
    expect(verification).toContain("Smoke-install the exact packed tarball");
    expect(verification).toContain("Upload immutable exact release candidate");

    expect(publication).toContain("needs: verify-and-pack");
    expect(publication).toMatch(/id-token:\s*write/);
    expect(publication).toMatch(/attestations:\s*write/);
    expect(publication).toMatch(/contents:\s*write/);
    expect(publication).not.toMatch(/npm (?:ci|run|install|pack)/);
    expect(publication).not.toContain("actions/checkout");
    expect(publication).not.toContain("sha256sum -c");
    expect(publication).toContain('node-version: "24"');
    expect(publication).toContain("package-manager-cache: false");
  });

  it("keeps the tag workflow on the same verify gate used by release PRs", () => {
    const release = read(".github/workflows/release.yml");
    const verificationStart = release.indexOf("  verify-and-pack:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    const verification = release.slice(verificationStart, publishStart);
    const tagGateIndex = verification.indexOf("Assert tag commit is current main");
    const setupNodeIndex = verification.indexOf("actions/setup-node");
    const npmCiIndex = verification.indexOf("npm ci --ignore-scripts");

    expect(verification).toContain(
      "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    );
    expect(verification).toContain('if [ "$GITHUB_SHA" != "$main_sha" ]; then');
    expect(verification).toContain("npm run verify");
    expect(verification).not.toContain("npx vitest run --coverage");
    expect(tagGateIndex).toBeGreaterThan(-1);
    expect(setupNodeIndex).toBeGreaterThan(tagGateIndex);
    expect(npmCiIndex).toBeGreaterThan(tagGateIndex);
  });

  it("carries immutable artifact identity and rechecks exact custody before every effect", () => {
    const release = read(".github/workflows/release.yml");
    expect(release.match(/npm pack --ignore-scripts/gmu)).toHaveLength(1);
    expect(release).toContain("tarball_sha256");
    expect(release).toContain("artifact-id");
    expect(release).toContain("artifact-digest");
    expect(release).toContain("artifact-ids:");
    expect(release).toContain("EXPECTED_TARBALL_SHA256");
    expect(release).toContain("EXPECTED_ARTIFACT_SHA256");
    expect(release).toContain('test "$actual_sha256" = "$EXPECTED_TARBALL_SHA256"');
    expect(release).toContain(
      ['test "$api_digest" = "sha256:$', '{EXPECTED_ARTIFACT_SHA256}"'].join(""),
    );
    expect(release).toContain(
      'printf \'%s  %s\\n\' "$EXPECTED_TARBALL_SHA256" "$(basename "$TARBALL")" > SHA256SUMS.txt',
    );
    expect(release).toContain('manifest.name !== "@aihq/core"');
    expect(release).toContain("manifest.version !== tag");
    expect(release).toContain("upload-artifact: false");
    expect(release).toContain("upload-release-assets: false");

    const publication = release.slice(release.indexOf("  npm-publish:\n"));
    expect(publication).toContain("Revalidate current main and tag before publication");
    expect(publication).toContain('tag_sha="$(git rev-parse "refs/tags/$GITHUB_REF_NAME^{}")"');
    expect(publication).toContain(
      'if [ "$GITHUB_SHA" != "$main_sha" ] || [ "$GITHUB_SHA" != "$tag_sha" ]; then',
    );
    expect(publication).toContain('test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"');

    const sbomIndex = publication.indexOf("Generate tarball-scoped SPDX SBOM");
    const attestIndex = publication.indexOf("Attest build provenance for the exact tarball");
    const signIndex = publication.indexOf("Sign trusted checksum and retain provenance bundle");
    const publishIndex = publication.indexOf(
      "Publish exact first tarball through the one-use npm bootstrap",
    );
    const releaseIndex = publication.indexOf("Create immutable GitHub Release evidence");
    const verificationIndexes = [...publication.matchAll(/Verify exact tarball before/gmu)].map(
      (match) => match.index ?? -1,
    );
    expect(verificationIndexes).toHaveLength(5);
    expect(verificationIndexes[0]).toBeLessThan(sbomIndex);
    expect(verificationIndexes[1]).toBeLessThan(attestIndex);
    expect(verificationIndexes[2]).toBeLessThan(signIndex);
    expect(verificationIndexes[3]).toBeLessThan(publishIndex);
    expect(verificationIndexes[4]).toBeLessThan(releaseIndex);
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
    expect(releasing).toContain("read-only `verify-and-pack` job");
    expect(releasing).toContain("runs no Core package code");
  });

  it("scopes the SLSA Build L2 claim to the Core tarball and documents the Build L3 gap", () => {
    const doc = read("docs/security/release-slsa.md");
    expect(doc).toContain("SLSA v1.2");
    expect(doc).toContain("SLSA Build L2");
    expect(doc).toContain("The `@aihq/core` tarball");
    expect(doc).toMatch(/not\s+themselves claimed as SLSA Build L2 subjects/u);
    expect(doc).toContain("No Build L3 claim is made");
    expect(doc).toContain(".github/workflows/release.yml");
    expect(doc).toContain("actions/attest-build-provenance");
    expect(doc).toContain('npm publish "$tarball" --ignore-scripts --provenance --access public');
    expect(doc).toContain("aih verify-release [version]");
    expect(doc).toContain("gh attestation verify");
  });

  it("keeps top-level release docs aligned with the SLSA level claim", () => {
    const readme = read("README.md");
    const architecture = read("docs/ARCHITECTURE.md");
    for (const text of [readme, architecture]) {
      expect(text).toContain("SLSA Build L2");
      expect(text).toContain("tagged Core tarball");
      expect(text).toMatch(/supporting evidence,?\s+not (?:additional )?L2 subjects/u);
      expect(text).not.toContain("meets SLSA Build L3");
      expect(text).not.toContain("SLSA v1 provenance material, but the project does not claim");
    }
  });

  it("directs global-install verification through the release verifier", () => {
    const coreVersion = JSON.parse(read("package.json")).version;
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
      ).filter((block) => block.includes("npm install -g @aihq/core"));
      expect(installBlocks.length).toBeGreaterThan(0);
      for (const block of installBlocks) {
        const installCommand = `npm install -g @aihq/core@${coreVersion}`;
        const verifyCommand = `aih verify-release ${coreVersion}`;
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
    // The release cut makes Core the active line while retaining an honest
    // pre-publication fallback in the README.
    const onboarding = read("docs/ENTERPRISE_ONBOARDING.md");
    expect(onboarding).toContain("install the approved explicit version (currently");
    expect(onboarding).toContain(`\`npm install -g @aihq/core@${coreVersion}\`);`);
    for (const path of [
      "guides/enterprise-developer-guide.md",
      "guides/enterprise-admin-guide.md",
    ]) {
      const text = read(path);
      expect(text).toContain(
        `Release baseline covered by this guide: \`@aihq/core@${coreVersion}\``,
      );
      expect(text).toContain(
        `For a major-version upgrade, install the approved explicit version (currently\n\`npm install -g @aihq/core@${coreVersion}\`); \`npm update -g\` may stay within the current major. Re-run\n\`aih verify-release ${coreVersion}\` after an upgrade.`,
      );
    }
    const postures = read("guides/postures.md");
    expect(postures).toContain(`The current release baseline is \`@aihq/core@${coreVersion}\`.`);
    const readme = read("README.md");
    expect(readme).toContain(`published \`@aihq/harness@${legacyVersion}\` package is frozen`);
    expect(readme).toContain(`npm install -g @aihq/core@${coreVersion}`);
    expect(readme).toContain("Until those exact artifacts exist");
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
