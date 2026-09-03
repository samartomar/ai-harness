import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const root = process.cwd();
const githubExpression = (body: string): string => `\${{ ${body} }}`;

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
      [
        'notes="Curated release notes: [CHANGELOG.md](https://github.com/$',
        "{GITHUB_REPOSITORY}/blob/$",
        '{TAG}/CHANGELOG.md)"',
      ].join(""),
    );
    expect(release).toContain("--generate-notes");
    expect(release).toContain('--notes "$notes"');

    expect(read("README.md")).toContain(
      "[CHANGELOG.md](https://github.com/samartomar/ai-harness/blob/main/CHANGELOG.md)",
    );
  });

  it("ships the release guide linked from the package README", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    expect(pkg.files).toContain("RELEASING.md");
    expect(pkg.files).toContain("VERSIONING.md");
    expect(read("README.md")).toContain("[RELEASING.md](RELEASING.md)");
    expect(read("RELEASING.md")).toContain(
      "https://github.com/samartomar/ai-harness/blob/main/.github/workflows/release.yml",
    );
  });

  it("detects release preparation from changed content instead of trusting branch naming", () => {
    const workflow = read(".github/workflows/ci.yml");
    const guardStart = workflow.indexOf("  release_prep_guard:\n");
    const verifyStart = workflow.indexOf("  verify:\n", guardStart);
    const guard = workflow.slice(guardStart, verifyStart);

    expect(workflow).toContain(
      ["release_preparation: $", "{{ steps.impact.outputs.release_preparation }}"].join(""),
    );
    expect(guard).toContain("needs: classify");
    expect(guard).toContain("needs.classify.outputs.release_preparation == 'true'");
    expect(guard).not.toContain(
      ["if: $", "{{ startsWith(github.head_ref, 'release/v-core-') }}"].join(""),
    );
  });

  it("launches authoritative selected tests through Node on every selected runner", () => {
    const workflow = read(".github/workflows/ci.yml");
    const runner = read(".github/scripts/run-selected-tests.mjs");
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const selectedStart = workflow.indexOf("  selected_tests:\n");
    const guardStart = workflow.indexOf("  release_prep_guard:\n", selectedStart);
    const selected = workflow.slice(selectedStart, guardStart);

    expect(selected).toContain("run: npm run --silent ci:run-selected");
    expect(selected).toContain("needs.classify.outputs.full_suite != 'true'");
    expect(selected).not.toContain("continue-on-error");
    expect(selected).not.toContain("shell: bash");
    expect(selected).not.toContain('"npx.cmd"');
    expect(pkg.scripts["ci:run-selected"]).toBe("node .github/scripts/run-selected-tests.mjs");
    expect(runner).toContain("const executable = process.execPath;");
    expect(runner).toContain('resolve("node_modules/vitest/vitest.mjs")');
    expect(runner).toContain('"--maxWorkers=2"');
    expect(runner).toContain('"--testTimeout=15000"');
    expect(runner).toContain("if (result.error) throw result.error;");
  });

  it("graduates selected replay behind fail-closed protected contexts", () => {
    const ci = parseDocument(read(".github/workflows/ci.yml")).toJSON() as {
      concurrency?: { group?: string; "cancel-in-progress"?: string };
      jobs?: {
        selected_tests?: {
          "continue-on-error"?: boolean;
          needs?: string;
          env?: Record<string, string>;
        };
        full_verify?: { if?: string };
        windows_full_tests?: { if?: string };
        quality?: { steps?: WorkflowStep[] };
        required_verify?: {
          name?: string;
          if?: string;
          needs?: string[];
          strategy?: { matrix?: { os?: string[] } };
          steps?: WorkflowStep[];
        };
        pr_gate?: { needs?: string[]; steps?: WorkflowStep[] };
      };
    };
    const expectedConcurrency = {
      group: `${githubExpression("github.workflow")}-${githubExpression("github.event.pull_request.number || github.run_id")}`,
      "cancel-in-progress": githubExpression("github.event_name == 'pull_request'"),
    };

    expect(ci.concurrency).toEqual(expectedConcurrency);
    expect(ci.jobs?.selected_tests?.["continue-on-error"]).toBeUndefined();
    expect(ci.jobs?.selected_tests?.needs).toBe("classify");
    expect(ci.jobs?.selected_tests?.env?.NODE_OPTIONS).toBe("--max-old-space-size=4096");
    expect(ci.jobs?.full_verify?.if).toContain("needs.classify.outputs.full_suite == 'true'");
    expect(ci.jobs?.windows_full_tests?.if).toContain(
      "needs.classify.outputs.full_suite == 'true'",
    );
    const qualitySteps = JSON.stringify(ci.jobs?.quality?.steps);
    expect(qualitySteps).toContain("npm run docs:lint");
    expect(qualitySteps).toContain("npm run check:packed-doc-links");
    expect(qualitySteps).toContain("npm run baseline:check");
    const qualityCheckout = ci.jobs?.quality?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(qualityCheckout?.with?.["fetch-depth"]).toBe(0);
    expect(ci.jobs?.required_verify?.name).toBe(`verify (${githubExpression("matrix.os")})`);
    expect(ci.jobs?.required_verify?.if).toBe(githubExpression("always()"));
    expect(ci.jobs?.required_verify?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "macos-latest",
      "windows-latest",
    ]);
    expect(ci.jobs?.required_verify?.needs).toEqual([
      "classify",
      "release_prep_guard",
      "quality",
      "selected_tests",
      "full_verify",
      "windows_full_tests",
    ]);
    const requiredSteps = JSON.stringify(ci.jobs?.required_verify?.steps);
    expect(requiredSteps).toContain("node .github/scripts/require-ci-lane.mjs");
    for (const result of [
      "CLASSIFY_RESULT",
      "QUALITY_RESULT",
      "SELECTED_RESULT",
      "FULL_RESULT",
      "WINDOWS_RESULT",
    ]) {
      expect(requiredSteps).toContain(result);
    }
    expect(ci.jobs?.pr_gate?.needs).toEqual(["classify", "release_prep_guard", "required_verify"]);
    expect(JSON.stringify(ci.jobs?.pr_gate?.steps)).toContain("VERIFY_RESULT");

    expect(existsSync(join(root, ".github", "workflows", "baseline-evidence.yml"))).toBe(false);
    for (const path of [".github/workflows/codeql.yml"]) {
      const workflow = parseDocument(read(path)).toJSON() as {
        concurrency?: { group?: string; "cancel-in-progress"?: string };
      };
      expect(workflow.concurrency, path).toEqual(expectedConcurrency);
    }
  });

  it("does not rerun OpenSSF Scorecard after every protected-main merge", () => {
    const scorecard = parseDocument(read(".github/workflows/scorecard.yml")).toJSON() as {
      on?: Record<string, unknown>;
    };

    expect(scorecard.on).toHaveProperty("branch_protection_rule");
    expect(scorecard.on).toHaveProperty("schedule");
    expect(scorecard.on).not.toHaveProperty("push");
  });

  it("binds every release tracker lookup to the executing repository", () => {
    const release = read(".github/workflows/release.yml");
    const acceptance = read(".github/workflows/installed-acceptance.yml");
    const promotion = read(".github/workflows/promotion-authorization.yml");

    expect(release).toContain(
      'release:governance -- manifest release/enterprise-change.json "$GITHUB_REPOSITORY"',
    );
    expect(release).toContain(
      'release:governance -- resolve-publication authorized/qualification.json "$GITHUB_REPOSITORY"',
    );
    expect(release).toContain(
      'release:governance -- assert-active authorized/qualification.json "$GITHUB_REPOSITORY"',
    );
    expect(acceptance).toContain(
      'release:governance -- qualification qualification/qualification.json "$GITHUB_REPOSITORY"',
    );
    expect(promotion).toContain(
      'release:governance -- assert-active "$qualification" "$GITHUB_REPOSITORY"',
    );
  });

  it("names release SBOM artifacts by their actual format", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("SPDX SBOM");
    expect(release).not.toContain("CycloneDX SBOM");
    expect(release).toContain("format: spdx-json");
  });

  it("uses tokenless npm Trusted Publishing after the first Core publication", () => {
    const release = read(".github/workflows/release.yml");
    expect(parseDocument(release).errors).toEqual([]);
    expect(release).toContain("environment:");
    expect(release).toContain("name: npm-publish");
    expect(release).toMatch(/id-token:\s*write/);
    expect(release).toContain('registry-url: "https://registry.npmjs.org"');
    expect(release).not.toContain("v-core-0.1.1");
    expect(release).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(release).not.toContain("REGISTRY_OBSERVATION");
    expect(release).not.toContain('npm view "@aihq/core"');
    expect(release).not.toContain("npm whoami");
    expect(release).toContain("Publish exact tarball through npm Trusted Publishing");
    expect(release).toContain(
      ['if [ -n "$', '{NODE_AUTH_TOKEN:-}" ] || [ -n "$', '{NPM_TOKEN:-}" ]; then'].join(""),
    );
    expect(release).toContain(
      'npm publish "$tarball" --ignore-scripts --provenance --access public --registry "https://registry.npmjs.org/"',
    );

    const verificationStart = release.indexOf("  verify-and-pack:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    const verification = release.slice(verificationStart, publishStart);
    expect(verification).not.toContain("NODE_AUTH_TOKEN");
    expect(verification).not.toContain("NPM_TOKEN");

    const releasing = read("RELEASING.md");
    expect(releasing).toContain(
      "npm trust github @aihq/core --file release.yml --repo samartomar/ai-harness --env npm-publish --allow-publish",
    );
    expect(releasing).toContain("npm trust list @aihq/core");
    expect(releasing).toContain("GitHub bootstrap secret is absent");
    expect(releasing).toContain("revoke the short-lived npm token");
    expect(releasing).toContain("Future Core tags remain blocked");
    expect(releasing).not.toContain("**Bypass 2FA** enabled");
    expect(releasing).not.toContain("NPM_BOOTSTRAP_TOKEN");

    const actions = [...release.matchAll(/^\s*(?:-\s*)?uses:\s*([^@\s]+)@([^\s#]+).*$/gmu)];
    expect(actions.length).toBeGreaterThanOrEqual(7);
    for (const [, action, revision] of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+$/u);
      expect(revision).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it("accepts only a stable unambiguous npm CLI version at the Trusted Publishing boundary", () => {
    const release = read(".github/workflows/release.yml");
    const validator = inlineModuleFollowing(release, 'npm_version="$(npm --version)"');
    const validate = (version: string) =>
      spawnSync(process.execPath, ["--input-type=module", "-", version], {
        input: validator,
        encoding: "utf8",
      });

    for (const accepted of ["11.5.1", "11.5.2", "11.6.0", "12.0.0"]) {
      expect(validate(accepted).status, accepted).toBe(0);
    }
    for (const rejected of [
      "11.5.0",
      "10.99.99",
      "11.5.1-beta.0",
      "11.5.1+build.1",
      "v11.5.1",
      "11.5",
      "011.5.1",
      "999999999999999999999999.5.1",
      "",
    ]) {
      expect(validate(rejected).status, rejected).not.toBe(0);
    }
  });

  it("rejects a packed manifest that tries to redirect npm publication", () => {
    const release = read(".github/workflows/release.yml");
    const validator = inlineModuleFollowing(release, "Validate packed manifest identity");
    const fixtureRoot = mkdtempSync(join(tmpdir(), "aih-release-manifest-"));
    try {
      const packageRoot = join(fixtureRoot, "package");
      mkdirSync(packageRoot);
      const candidateRoot = join(fixtureRoot, "sealed", "candidate");
      mkdirSync(candidateRoot, { recursive: true });
      const validate = (publishConfig: Record<string, unknown>) => {
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "@aihq/core", version: "0.1.1", publishConfig }),
        );
        execFileSync("tar", ["-czf", "sealed/candidate/candidate.tgz", "package"], {
          cwd: fixtureRoot,
        });
        return spawnSync(process.execPath, ["--input-type=module", "-"], {
          cwd: fixtureRoot,
          input: validator,
          encoding: "utf8",
          env: { ...process.env, TAG: "v-core-0.1.1", TARBALL: "candidate.tgz" },
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
    const authorizationStart = release.indexOf("  authorize-publication:\n");
    const sealingStart = release.indexOf("  seal-publication-evidence:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    const releaseStart = release.indexOf("  github-release:\n");
    expect(authorizationStart).toBeGreaterThan(verificationStart);
    expect(sealingStart).toBeGreaterThan(authorizationStart);
    expect(publishStart).toBeGreaterThan(sealingStart);

    const verification = release.slice(verificationStart, authorizationStart);
    const sealing = release.slice(sealingStart, publishStart);
    const publication = release.slice(publishStart, releaseStart);

    expect(verification).toMatch(/permissions:\n(?:\s+[a-z-]+:\s*\w+\n)*\s+contents:\s*read/);
    expect(verification).not.toMatch(/(?:id-token|attestations):\s*write/);
    expect(verification).not.toMatch(/contents:\s*write/);
    expect(verification).toContain("npm run verify:release-candidate");
    expect(verification).not.toMatch(/run:\s*npm run verify\s*$/mu);
    expect(verification).not.toContain("test:cov");
    expect(verification).toContain("npm pack --ignore-scripts");
    expect(verification).toContain("Install and execute only the exact packed artifact");
    expect(verification).toContain("Upload digest-bound candidate packet");

    expect(sealing).toMatch(/attestations:\s*write/u);
    expect(sealing).not.toContain("environment:\n      name: npm-publish");
    expect(publication).toContain("needs: [authorize-publication, seal-publication-evidence]");
    expect(publication).toMatch(/id-token:\s*write/);
    expect(publication).not.toMatch(/attestations:\s*write/);
    expect(publication).not.toMatch(/contents:\s*write/);
    expect(publication).not.toMatch(/npm (?:ci|run|install|pack)/);
    expect(publication).not.toContain("actions/checkout");
    expect(publication).toContain('node-version: "24"');
    expect(publication).toContain("package-manager-cache: false");
  });

  it("consumes successful exact-SHA CI before package-specific release verification", () => {
    const release = read(".github/workflows/release.yml");
    const verificationStart = release.indexOf("  verify-and-pack:\n");
    const publishStart = release.indexOf("  npm-publish:\n");
    const verification = release.slice(verificationStart, publishStart);
    const tagGateIndex = verification.indexOf("Assert annotated tag is a protected-main candidate");
    const ciReceiptIndex = verification.indexOf("Require successful exact protected-main checks");
    const setupNodeIndex = verification.indexOf("actions/setup-node");
    const npmCiIndex = verification.indexOf("npm ci --ignore-scripts");

    expect(verification).toContain(
      "git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main",
    );
    expect(verification).toContain(
      'git merge-base --is-ancestor "$tag_sha" refs/remotes/origin/main',
    );
    expect(verification).toContain(
      'test "$(git cat-file -t "refs/tags/$GITHUB_REF_NAME")" = "tag"',
    );
    expect(verification).not.toContain('test "$GITHUB_SHA" = "$(git rev-parse origin/main)"');
    expect(verification).toContain("actions: read");
    expect(verification).toContain("Require successful exact protected-main checks");
    expect(verification).toContain("npm run verify:release-candidate");
    expect(verification).not.toMatch(/run:\s*npm run verify\s*$/mu);
    expect(verification).not.toContain("npx vitest run --coverage");
    expect(tagGateIndex).toBeGreaterThan(-1);
    expect(ciReceiptIndex).toBeGreaterThan(tagGateIndex);
    expect(setupNodeIndex).toBeGreaterThan(tagGateIndex);
    expect(npmCiIndex).toBeGreaterThan(tagGateIndex);
  });

  it("records required protected-main checks and a completed successful exact-SHA main push", () => {
    const release = read(".github/workflows/release.yml");
    for (const name of [
      "analyze",
      "verify (ubuntu-latest)",
      "verify (macos-latest)",
      "verify (windows-latest)",
    ]) {
      expect(release).toContain(`"${name}"`);
    }
    expect(release).toContain("run?.head_sha === process.env.GITHUB_SHA");
    expect(release).toContain('run?.head_branch === "main"');
    expect(release).toContain('run?.event === "push"');
    expect(release).toContain('run?.status === "completed"');
    expect(release).toContain('run?.conclusion === "success"');
    expect(release).toContain('writeFileSync("protected-main-ci.json"');
  });

  it("carries immutable artifact identity and rechecks exact custody before every effect", () => {
    const release = read(".github/workflows/release.yml");
    expect(release.match(/npm pack --ignore-scripts/gmu)).toHaveLength(1);
    expect(release).toContain("tarball_sha256");
    expect(release).toContain("artifact-id");
    expect(release).toContain("artifact-digest");
    expect(release).toContain("artifact-ids:");
    expect(release).toContain("publication_authorization_comment");
    expect(release).toContain("resolve-publication");
    expect(release).toContain("assert-active");
    expect(release).toContain(
      "publication must dispatch the workflow from the qualified tag revision",
    );
    expect(release).toContain("Upload recovery evidence before npm effect");
    expect(release).toContain(
      'test "$(git -C "$observation" cat-file -t "refs/tags/$TAG")" = "tag"',
    );
    expect(release).toContain('git -C "$observation" merge-base --is-ancestor');
    expect(release).toContain('manifest.name !== "@aihq/core"');
    expect(release).toContain("upload-artifact: false");
    expect(release).toContain("upload-release-assets: false");

    const publication = release.slice(release.indexOf("  npm-publish:\n"));
    expect(publication).toContain(
      "Revalidate custody, candidate state, tag, and ancestry immediately before effect",
    );
    expect(publication).toContain("publication authorization identity changed before effect");
    expect(publication).not.toContain("current main or tag no longer matches");
    expect(publication).toContain('--repo "$GITHUB_REPOSITORY"');

    const sealIndex = release.indexOf("Upload recovery evidence before npm effect");
    const publishIndex = publication.indexOf(
      "Publish exact tarball through npm Trusted Publishing",
    );
    expect(sealIndex).toBeLessThan(release.indexOf("  npm-publish:\n"));
    expect(publishIndex).toBeGreaterThan(0);
    expect(publication).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(publication).not.toContain("secrets.");
    expect(publication).not.toContain('npm view "@aihq/core"');
  });

  it("publishes every candidate to next and requires separate installed-evidence promotion", () => {
    const releasing = read("RELEASING.md");
    const workflow = read(".github/workflows/release.yml");
    const promotion = read(".github/workflows/promotion-authorization.yml");

    expect(releasing).toContain("Candidate-first is mandatory");
    expect(releasing).toContain("Authorize and publish exact qualified bytes");
    expect(releasing).toContain("Run public installed acceptance");
    expect(releasing).toContain("promote the same\nimmutable version");
    expect(releasing).toContain("Authorize promotion separately");
    expect(releasing).toContain("A tag push cannot publish");
    expect(workflow).toContain("dist_tag=next");
    expect(workflow).not.toContain("dist_tag=latest");
    expect(workflow).toContain("--prerelease");
    expect(promotion).toContain("no registry or GitHub state changed");
    expect(promotion).toContain("npm dist-tag add @aihq/core@%s latest");
  });

  it("makes exact-version public installed acceptance a retained promotion prerequisite", () => {
    const workflow = read(".github/workflows/installed-acceptance.yml");
    expect(parseDocument(workflow).errors).toEqual([]);
    expect(workflow).toContain("@aihq/core@$CORE_VERSION");
    expect(workflow).toContain("@aihq/scan@$SCANNER_VERSION");
    expect(workflow).toContain("@aihq/catalog@$CATALOG_VERSION");
    expect(workflow).not.toContain("@aihq/core@next");
    expect(workflow).not.toContain("@aihq/core@latest");
    expect(workflow).toContain("aih verify-release");
    expect(workflow).toContain("skippedLegs: 0");
    expect(workflow).toContain("aih-installed-acceptance-v1");
    expect(workflow).toContain("promotion-token");
    expect(workflow).toContain(
      "acceptance must dispatch the workflow from the qualified tag revision",
    );
    expect(workflow).toContain("retention-days: 90");
    for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
      expect(workflow).toContain(os);
    }
    for (const node of ['node: "20"', 'node: "22"', 'node: "24"']) {
      expect(workflow).toContain(node);
    }
    expect(read(".github/workflows/promotion-authorization.yml")).toContain(
      "promotion authorization must dispatch the workflow from the qualified tag revision",
    );
  });

  it("scopes the SLSA Build L2 claim to the Core tarball and documents the Build L3 gap", () => {
    const doc = read("docs/security/release-slsa.md");
    expect(doc).toContain("SLSA v1.2");
    expect(doc).toContain("SLSA Build L2");
    expect(doc).toContain("Immutable `v-core-0.1.0` remains failed audit evidence");
    expect(doc).toContain("`v-core-0.1.1`\n> published the npm package");
    expect(doc).not.toContain("Core has not yet produced a tagged release");
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
      ).filter((block) => block.includes("npm install -g") && block.includes("@aihq/core@"));
      expect(installBlocks.length).toBeGreaterThan(0);
      for (const block of installBlocks) {
        expect(block).toContain("npm view @aihq/core dist-tags.latest");
        expect(block).toMatch(/@aihq\/core@\$(?:CORE_VERSION|CoreVersion)/u);
        expect(block).toMatch(/aih verify-release ["']?\$(?:CORE_VERSION|CoreVersion)/u);
        expect(block).not.toContain("npm audit signatures");
      }
      expect(text).not.toContain(`@aihq/core@${JSON.parse(read("package.json")).version}`);
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
    const onboarding = read("docs/ENTERPRISE_ONBOARDING.md");
    expect(onboarding).toContain("approved explicit promoted version");
    for (const path of [
      "guides/enterprise-developer-guide.md",
      "guides/enterprise-admin-guide.md",
    ]) {
      const text = read(path);
      expect(text).toContain("promoted");
      expect(text).toContain("resolve and approve the explicit promoted version");
    }
    const postures = read("guides/postures.md");
    expect(postures).toContain("promoted `@aihq/core` stable train");
    const readme = read("README.md");
    expect(readme).toContain(
      `published \`@aihq/harness@${legacyVersion}\` package is frozen and npm-deprecated`,
    );
    expect(readme).toContain("npm view @aihq/core dist-tags.latest");

    for (const path of [
      "README.md",
      "RELEASING.md",
      "STABILITY.md",
      "VERSIONING.md",
      "docs/commands.md",
      "docs/security/release-slsa.md",
      "guides/README.md",
      "guides/enterprise-admin-guide.md",
    ]) {
      const text = read(path);
      expect(text, path).toContain("npm-deprecated");
      expect(text, path).toContain("@aihq/core");
    }

    const adminGuide = read("guides/enterprise-admin-guide.md");
    const commands = read("docs/commands.md");
    for (const [path, text] of [
      ["guides/enterprise-admin-guide.md", adminGuide],
      ["docs/commands.md", commands],
    ] as const) {
      expect(text, path).not.toContain("pending `0.1.1` Core package");
    }
    expect(adminGuide).toContain("promoted `@aihq/scan` stable train");

    for (const path of ["SUPPORT.md", "docs/commands.md", "guides/README.md"]) {
      const installDoc = read(path);
      expect(installDoc, path).toContain("promoted");
      expect(installDoc, path).not.toContain("@aihq/core@0.3.0");
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
