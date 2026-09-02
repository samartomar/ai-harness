import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCandidateActive,
  buildCumulativeEnterpriseDelta,
  candidateStateToken,
  evidenceSha256,
  promotionAuthorizationToken,
  publicationAuthorizationToken,
  RELEASE_SURFACES,
  resolveReleaseAuthorizationComment,
  validateCandidateManifest,
  validateCandidateManifestForRepository,
  validateInstalledAcceptanceReceipt,
  validatePromotionAuthorization,
  validatePublicationAuthorization,
  validateQualificationReceipt,
  validateQualificationReceiptForRepository,
  validateReleasePreparation,
} from "../../src/internals/delivery-governance.js";
import { runDeliveryGovernanceCommand } from "../../src/internals/delivery-governance-command.js";
import { fakeRunner } from "../../src/internals/proc.js";

const sha = "a".repeat(40);
const digest = (character: string) => character.repeat(64);

function surface(status: "changed" | "unchanged" | "not-applicable" = "unchanged") {
  if (status === "changed") {
    return {
      status,
      previous: "old behavior",
      next: "new behavior",
      affectedCohort: "administrators approving Core upgrades",
      operatorAction: "review and approve the recorded delta",
      compatibility: "backward-compatible",
      risk: "incorrect approval if evidence is ignored",
      documentation: ["RELEASING.md"],
      migration: "No state migration; adopt the exact promoted version.",
      owner: "samartomar",
      evidenceDigests: [`sha256:${digest("1")}`],
    };
  }
  return {
    status,
    rationale:
      status === "unchanged"
        ? "Verified unchanged for this decision unit."
        : "This surface does not apply to repository-only delivery controls.",
    evidenceDigests: status === "unchanged" ? [`sha256:${digest("2")}`] : [],
  };
}

function candidate() {
  return {
    schemaVersion: "aih-enterprise-change-manifest-v1",
    package: { name: "@aihq/core", fromVersion: "0.5.0", version: "0.6.0" },
    tracker: { repository: "samartomar/ai-harness", issueNumber: 950 },
    decisionUnit: {
      id: "hosted-mcp-administrator-policy",
      cohort: "organizations governing hosted MCP for Claude or Copilot",
      outcome: "Administrators can authorize a hosted MCP endpoint without ECC.",
      includedChanges: ["hosted MCP identity and policy projection"],
      adoption: "recommended",
      adoptionRationale: "Required only for organizations selecting hosted MCP controls.",
      prerequisites: ["approved endpoint identity"],
      rollout: "pilot, observe, then expand",
      rollback: "revoke the hosted endpoint decision and restore the prior policy",
      supportImpact: "The promoted stable train remains the supported line.",
      accountableOwner: "samartomar",
    },
    surfaces: Object.fromEntries(
      RELEASE_SURFACES.map((name, index) => [name, surface(index === 5 ? "changed" : "unchanged")]),
    ),
    knownIssues: [],
    waivers: [],
  };
}

function qualification() {
  return {
    schemaVersion: "aih-release-qualification-v1",
    package: { name: "@aihq/core", version: "0.6.0" },
    source: { sha, tag: "v-core-0.6.0", tagObject: digest("3").slice(0, 40) },
    tracker: { repository: "samartomar/ai-harness", issueNumber: 950 },
    protectedMainCi: {
      runId: 1234,
      runUrl: "https://github.com/samartomar/ai-harness/actions/runs/1234",
      requiredChecks: [
        { name: "analyze", conclusion: "success" },
        { name: "verify (ubuntu-latest)", conclusion: "success" },
        { name: "verify (macos-latest)", conclusion: "success" },
        { name: "verify (windows-latest)", conclusion: "success" },
      ],
    },
    artifact: {
      id: 5678,
      digest: `sha256:${digest("4")}`,
      tarball: "aihq-core-0.6.0.tgz",
      tarballSha256: digest("5"),
    },
    manifests: {
      enterpriseChangeSha256: digest("6"),
      sbomSha256: digest("7"),
    },
    workflow: {
      path: ".github/workflows/release.yml",
      revision: digest("8").slice(0, 40),
      runId: 9012,
      runAttempt: 1,
    },
    matrix: [
      { os: "ubuntu-latest", node: "22", scope: "full-source", conclusion: "success" },
      { os: "macos-latest", node: "22", scope: "full-source", conclusion: "success" },
      { os: "windows-latest", node: "22", scope: "full-source", conclusion: "success" },
      { os: "ubuntu-latest", node: "20", scope: "installed-artifact", conclusion: "success" },
      { os: "ubuntu-latest", node: "22", scope: "installed-artifact", conclusion: "success" },
      { os: "ubuntu-latest", node: "24", scope: "installed-artifact", conclusion: "success" },
      { os: "macos-latest", node: "22", scope: "installed-artifact", conclusion: "success" },
      { os: "windows-latest", node: "22", scope: "installed-artifact", conclusion: "success" },
    ],
    createdAt: "2026-09-02T12:00:00Z",
  };
}

function acceptance() {
  return {
    schemaVersion: "aih-installed-acceptance-v1",
    qualificationDigest: `sha256:${digest("9")}`,
    package: { name: "@aihq/core", version: "0.6.0", integrity: "sha512-ZXhhY3Q=" },
    companions: { scanner: "0.2.5", catalog: "0.1.3" },
    registryBytesSha256: digest("a"),
    provenanceVerified: true,
    releaseVerification: { passed: true, skippedLegs: 0 },
    matrix: [
      { os: "ubuntu-latest", node: "20", conclusion: "success" },
      { os: "ubuntu-latest", node: "22", conclusion: "success" },
      { os: "ubuntu-latest", node: "24", conclusion: "success" },
      { os: "macos-latest", node: "22", conclusion: "success" },
      { os: "windows-latest", node: "22", conclusion: "success" },
    ],
    evidenceUrl: "https://github.com/samartomar/ai-harness/actions/runs/2222",
    createdAt: "2026-09-02T13:00:00Z",
  };
}

describe("enterprise release decision manifest", () => {
  it("validates repository-bound manifests through the command boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-delivery-governance-command-"));
    const manifestPath = join(root, "enterprise-change.json");
    const qualificationPath = join(root, "qualification.json");
    const acceptancePath = join(root, "acceptance.json");
    const cumulativePath = join(root, "cumulative.json");
    const receipt = qualification();
    const installed = acceptance();
    installed.qualificationDigest = `sha256:${evidenceSha256(receipt)}`;
    writeFileSync(manifestPath, `${JSON.stringify(candidate())}\n`, "utf8");
    writeFileSync(qualificationPath, `${JSON.stringify(receipt)}\n`, "utf8");
    writeFileSync(acceptancePath, `${JSON.stringify(installed)}\n`, "utf8");
    const stdout: string[] = [];
    const options = { writeStdout: (value: string) => stdout.push(value) };

    try {
      await runDeliveryGovernanceCommand(
        ["manifest", manifestPath, "samartomar/ai-harness"],
        options,
      );
      await runDeliveryGovernanceCommand(
        ["qualification", qualificationPath, "samartomar/ai-harness"],
        options,
      );
      await runDeliveryGovernanceCommand(["acceptance", acceptancePath], options);
      await runDeliveryGovernanceCommand(["digest", manifestPath], options);
      await runDeliveryGovernanceCommand(["publication-token", qualificationPath], options);
      await runDeliveryGovernanceCommand(
        ["promotion-token", qualificationPath, acceptancePath],
        options,
      );
      await runDeliveryGovernanceCommand(
        ["cumulative", "0.5.0", "0.6.0", cumulativePath, manifestPath],
        options,
      );

      expect(stdout).toHaveLength(3);
      expect(stdout[0]).toMatch(/^sha256:[0-9a-f]{64}\n$/u);
      expect(stdout[1]).toContain("AIH-PUBLISH-V1");
      expect(stdout[2]).toContain("AIH-PROMOTE-V1");
      expect(JSON.parse(readFileSync(cumulativePath, "utf8"))).toMatchObject({
        fromVersion: "0.5.0",
        toVersion: "0.6.0",
      });
      await expect(
        runDeliveryGovernanceCommand(
          ["manifest", manifestPath, "attacker/quiet-repository"],
          options,
        ),
      ).rejects.toThrow(/tracker repository/u);
      await expect(runDeliveryGovernanceCommand([], options)).rejects.toThrow(/usage/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes release preparation, candidate state, and owner authorization through one runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-delivery-governance-runner-"));
    const qualificationPath = join(root, "qualification.json");
    const publicationPath = join(root, "publication.json");
    const receipt = qualification();
    writeFileSync(qualificationPath, `${JSON.stringify(receipt)}\n`, "utf8");
    const commentUrl = "https://github.com/samartomar/ai-harness/issues/950#issuecomment-42";
    const comment = {
      id: 42,
      html_url: commentUrl,
      issue_url: "https://api.github.com/repos/samartomar/ai-harness/issues/950",
      body: publicationAuthorizationToken(receipt),
      user: { login: "samartomar" },
      author_association: "OWNER",
      created_at: "2026-09-02T12:30:00Z",
    };
    const run = fakeRunner((argv, options) => {
      if (argv[0] === "gh" && argv.includes("--slurp")) return { stdout: "[[]]" };
      if (argv[0] === "gh") return { stdout: JSON.stringify(comment) };
      expect(options?.cwd).toBe(root);
      if (argv[1] === "diff") return { stdout: "src/version.ts\0" };
      if (argv[1] === "show" && argv[2]?.startsWith(`${sha}:`)) {
        return { stdout: 'export const VERSION = "0.5.0";\n' };
      }
      if (argv[1] === "show") return { stdout: 'export const VERSION = "0.6.0";\n' };
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    try {
      await runDeliveryGovernanceCommand(["release-prep", sha, "b".repeat(40)], { cwd: root, run });
      await runDeliveryGovernanceCommand(
        ["assert-active", qualificationPath, "samartomar/ai-harness"],
        { run },
      );
      await runDeliveryGovernanceCommand(
        [
          "resolve-publication",
          qualificationPath,
          "samartomar/ai-harness",
          commentUrl,
          publicationPath,
        ],
        { run },
      );
      expect(existsSync(publicationPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires one complete decision unit and an explicit disposition for every surface", () => {
    const value = candidate();
    expect(validateCandidateManifest(value)).toEqual(value);

    const missing = candidate();
    delete (missing.surfaces as Record<string, unknown>)[RELEASE_SURFACES[0]];
    expect(() => validateCandidateManifest(missing)).toThrow(/surface/u);

    const noOutcome = candidate();
    noOutcome.decisionUnit.outcome = "";
    expect(() => validateCandidateManifest(noOutcome)).toThrow(/outcome/u);

    const rollback = candidate();
    rollback.package.fromVersion = "0.7.0";
    expect(() => validateCandidateManifest(rollback)).toThrow(/advance/u);
  });

  it("rejects changed surfaces without migration, ownership, and digest evidence", () => {
    const value = candidate();
    (value.surfaces[RELEASE_SURFACES[5]] as Record<string, unknown>).evidenceDigests = [];
    expect(() => validateCandidateManifest(value)).toThrow(/evidence/u);
  });

  it("binds the manifest tracker to the repository running qualification", () => {
    const value = candidate();
    expect(validateCandidateManifestForRepository(value, "samartomar/ai-harness")).toEqual(value);
    expect(() =>
      validateCandidateManifestForRepository(value, "attacker/quiet-repository"),
    ).toThrow(/tracker repository/u);
  });

  it("builds an ordered cumulative delta from an organization's approved version", () => {
    const first = candidate();
    const second = candidate();
    second.package.fromVersion = "0.6.0";
    second.package.version = "0.7.0";
    second.decisionUnit.id = "second-enterprise-outcome";

    const delta = buildCumulativeEnterpriseDelta([second, first], "0.5.0", "0.7.0");
    expect(delta).toMatchObject({
      schemaVersion: "aih-cumulative-enterprise-delta-v1",
      fromVersion: "0.5.0",
      toVersion: "0.7.0",
      releases: ["0.6.0", "0.7.0"],
      decisionUnits: ["hosted-mcp-administrator-policy", "second-enterprise-outcome"],
    });
    expect(delta.surfaces["administrator-controls"].changes).toHaveLength(2);
    expect(() => buildCumulativeEnterpriseDelta([second], "0.5.0", "0.7.0")).toThrow(/chain/u);
    expect(() => buildCumulativeEnterpriseDelta([first], "0.6.0", "0.5.0")).toThrow(/advance/u);
  });
});

describe("release-preparation allowlist", () => {
  it("accepts only mechanical version, changelog, release docs, and manifest edits", () => {
    expect(
      validateReleasePreparation({
        changedPaths: [
          "package.json",
          "package-lock.json",
          "src/version.ts",
          "CHANGELOG.md",
          "RELEASING.md",
          "release/enterprise-change.json",
        ],
        packageBefore: { name: "@aihq/core", version: "0.5.0", dependencies: { zod: "4.4.3" } },
        packageAfter: { name: "@aihq/core", version: "0.6.0", dependencies: { zod: "4.4.3" } },
        lockBefore: { version: "0.5.0", packages: { "": { version: "0.5.0" } } },
        lockAfter: { version: "0.6.0", packages: { "": { version: "0.6.0" } } },
        versionBefore: 'export const VERSION = "0.5.0";\n',
        versionAfter: 'export const VERSION = "0.6.0";\n',
      }),
    ).toEqual([]);
  });

  it.each([
    ["runtime", ["src/org-policy/catalog.ts"]],
    ["test", ["tests/release-readiness.test.ts"]],
    ["workflow", [".github/workflows/release.yml"]],
  ])("rejects %s changes", (_name, changedPaths) => {
    expect(validateReleasePreparation({ changedPaths })).toContainEqual(
      expect.objectContaining({ code: "release-prep-path" }),
    );
  });

  it("rejects a dependency change hidden in package metadata", () => {
    const findings = validateReleasePreparation({
      changedPaths: ["package.json"],
      packageBefore: { name: "@aihq/core", version: "0.5.0", dependencies: { zod: "4.4.3" } },
      packageAfter: { name: "@aihq/core", version: "0.6.0", dependencies: { zod: "4.5.0" } },
    });
    expect(findings).toContainEqual(expect.objectContaining({ code: "release-prep-package" }));
  });
});

describe("artifact-bound release authority", () => {
  it("validates qualification only when every required check and matrix leg succeeded", () => {
    const value = qualification();
    expect(validateQualificationReceipt(value)).toEqual(value);

    const failed = qualification();
    const failedLeg = failed.matrix[1];
    if (failedLeg === undefined) throw new Error("test fixture is missing its macOS leg");
    failedLeg.conclusion = "skipped";
    expect(() => validateQualificationReceipt(failed)).toThrow(/matrix/u);
  });

  it("binds qualification state and authorization lookups to the executing repository", () => {
    const receipt = qualification();
    expect(validateQualificationReceiptForRepository(receipt, "samartomar/ai-harness")).toEqual(
      receipt,
    );
    expect(() =>
      validateQualificationReceiptForRepository(receipt, "attacker/quiet-repository"),
    ).toThrow(/tracker repository/u);
  });

  it("binds publication authorization to the complete qualification receipt", () => {
    const receipt = qualification();
    const authorization = {
      schemaVersion: "aih-publication-authorization-v1",
      repository: "samartomar/ai-harness",
      issueNumber: 950,
      commentId: 42,
      commentUrl: "https://github.com/samartomar/ai-harness/issues/950#issuecomment-42",
      author: "samartomar",
      authorAssociation: "OWNER",
      createdAt: "2026-09-02T12:30:00Z",
      token: publicationAuthorizationToken(receipt),
    };
    expect(validatePublicationAuthorization(receipt, authorization)).toEqual(authorization);

    expect(() =>
      validatePublicationAuthorization(receipt, {
        ...authorization,
        authorAssociation: "MEMBER",
      }),
    ).toThrow(/authorAssociation/u);

    const changed = qualification();
    changed.artifact.tarballSha256 = digest("f");
    expect(() => validatePublicationAuthorization(changed, authorization)).toThrow(/token/u);
  });

  it("resolves the exact authorization comment and rejects a later invalidation", async () => {
    const receipt = qualification();
    const token = publicationAuthorizationToken(receipt);
    const commentUrl = "https://github.com/samartomar/ai-harness/issues/950#issuecomment-42";
    const comment = {
      id: 42,
      html_url: commentUrl,
      issue_url: "https://api.github.com/repos/samartomar/ai-harness/issues/950",
      body: `Publication decision\n\n${token}`,
      user: { login: "samartomar" },
      author_association: "OWNER",
      created_at: "2026-09-02T12:30:00Z",
    };
    const run = fakeRunner((argv) => {
      expect(argv).toEqual(["gh", "api", "repos/samartomar/ai-harness/issues/comments/42"]);
      return { stdout: JSON.stringify(comment) };
    });

    const authorization = await resolveReleaseAuthorizationComment(
      "publication",
      receipt,
      undefined,
      "samartomar/ai-harness",
      commentUrl,
      run,
    );
    expect(authorization.token).toBe(token);

    expect(() => assertCandidateActive(receipt, "samartomar/ai-harness", [comment])).not.toThrow();
    expect(() =>
      assertCandidateActive(receipt, "samartomar/ai-harness", [
        comment,
        {
          ...comment,
          id: 44,
          html_url: "https://github.com/samartomar/ai-harness/issues/950#issuecomment-44",
          body: candidateStateToken(receipt, "rejected"),
          created_at: "2026-09-02T12:40:00Z",
        },
      ]),
    ).toThrow(/rejected/u);

    expect(() =>
      assertCandidateActive(receipt, "samartomar/ai-harness", [
        {
          ...comment,
          author_association: "MEMBER",
          body: candidateStateToken(receipt, "rejected"),
        },
      ]),
    ).not.toThrow();

    expect(() => assertCandidateActive(receipt, "attacker/quiet-repository", [comment])).toThrow(
      /tracker repository/u,
    );
  });

  it("rejects a foreign tracker before resolving an authorization comment", async () => {
    const receipt = qualification();
    receipt.tracker.repository = "attacker/quiet-repository";
    const run = fakeRunner(() => {
      throw new Error("GitHub must not be queried for a foreign tracker");
    });

    await expect(
      resolveReleaseAuthorizationComment(
        "publication",
        receipt,
        undefined,
        "samartomar/ai-harness",
        "https://github.com/attacker/quiet-repository/issues/950#issuecomment-42",
        run,
      ),
    ).rejects.toThrow(/tracker repository/u);
  });

  it("requires exact installed bytes and zero skipped verification legs", () => {
    expect(validateInstalledAcceptanceReceipt(acceptance())).toEqual(acceptance());
    const skipped = acceptance();
    skipped.releaseVerification.skippedLegs = 1;
    expect(() => validateInstalledAcceptanceReceipt(skipped)).toThrow(/skipped/u);
  });

  it("binds promotion separately to qualification and installed acceptance", () => {
    const receipt = qualification();
    const installed = acceptance();
    installed.qualificationDigest = `sha256:${evidenceSha256(receipt)}`;
    const authorization = {
      schemaVersion: "aih-promotion-authorization-v1",
      repository: "samartomar/ai-harness",
      issueNumber: 950,
      commentId: 43,
      commentUrl: "https://github.com/samartomar/ai-harness/issues/950#issuecomment-43",
      author: "samartomar",
      authorAssociation: "OWNER",
      createdAt: "2026-09-02T13:30:00Z",
      token: promotionAuthorizationToken(receipt, installed),
    };
    expect(validatePromotionAuthorization(receipt, installed, authorization)).toEqual(
      authorization,
    );

    const wrongBytes = acceptance();
    wrongBytes.qualificationDigest = `sha256:${evidenceSha256(receipt)}`;
    wrongBytes.registryBytesSha256 = digest("b");
    expect(() => validatePromotionAuthorization(receipt, wrongBytes, authorization)).toThrow(
      /token/u,
    );
  });
});
