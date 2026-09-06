import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../../../src/contract/strict-json-v1.js";
import { defaultRunner, type Runner } from "../../../../src/internals/proc.js";

// Interpose the process implementation in this test module only. The product
// API exposes no witness/factory; runtime-injected verifiers remain untrusted.
vi.mock("../../../../src/internals/proc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/internals/proc.js")>()),
  defaultRunner: vi.fn(),
}));

import { parseBaselineEvidenceLock } from "../../../../src/baseline-evidence/schema.js";
import { vendorBaselineLockBytes } from "../../../../src/baseline-evidence/vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "../../../../src/baseline-evidence/vendor-artifact-v1.js";
import {
  type AdminBaselineEvidenceBootstrapV1,
  adminBaselineEvidenceBootstrapPathV1,
  vibeAdminBaselineEvidenceRootV1,
} from "../../../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";
import {
  parseGithubBaselineEvidenceAttestationV1,
  type ResolveAdminBaselineEvidenceV1Input,
  resolveAdminBaselineEvidenceV1,
  resolveOperationalAdminBaselineEvidenceV1,
  verifyGithubBaselineEvidenceAttestationLiveV1,
  workbenchEvidenceFromVerifiedBaselineV1,
} from "../../../../src/org-policy/admin-baseline-evidence-operations-v1.js";
import { policyStudioModel } from "../../../../src/org-policy/studio-model.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../../../src/org-policy/workbench/catalog-bundle.js";
import { defaultPreparedWorkbenchCatalog } from "../../../../src/org-policy/workbench/prepared-catalog.js";

const now = "2026-09-04T12:00:00Z";
const lock = parseBaselineEvidenceLock(JSON.parse(vendorBaselineLockBytes().toString("utf8")));
const bootstrap: AdminBaselineEvidenceBootstrapV1 = {
  protocol: "AdminBaselineEvidenceBootstrapV1",
  artifactUrl: "https://evidence.example.test/artifact/",
  attestationUrl: "https://evidence.example.test/attestation",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  minSchemaVersion: 1,
  maxSchemaVersion: 1,
  sources: lock.sources.map(({ id, owner, repo, pinnedSha }) => ({ id, owner, repo, pinnedSha })),
};

function verifierBytes(subjectSha256: string): Buffer {
  const identity = "https://github.com/" + bootstrap.expectedWorkflow + "@" + bootstrap.expectedRef;
  return Buffer.from(
    JSON.stringify([
      {
        attestation: { bundle: {} },
        verificationResult: {
          mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
          signature: {
            certificate: {
              subjectAlternativeName: identity,
              issuer: bootstrap.expectedIssuer,
              buildSignerURI: identity,
              buildConfigURI: identity,
              runnerEnvironment: "github-hosted",
              sourceRepositoryURI: "https://github.com/" + bootstrap.expectedRepository,
              sourceRepositoryRef: bootstrap.expectedRef,
            },
          },
          verifiedTimestamps: [
            {
              type: "signed",
              uri: "https://rekor.sigstore.dev",
              timestamp: "2026-09-04T11:00:00Z",
            },
          ],
          statement: {
            _type: "https://in-toto.io/Statement/v1",
            subject: [{ name: "SHA256SUMS", digest: { sha256: subjectSha256 } }],
            predicateType: "https://slsa.dev/provenance/v1",
            predicate: {},
          },
        },
      },
    ]),
  );
}
const liveVerify: ResolveAdminBaselineEvidenceV1Input["verifyGithubAttestation"] = (request) =>
  verifyGithubBaselineEvidenceAttestationLiveV1({
    bootstrap,
    now,
    gh: "fixture-gh",
    tempRoot: tmpdir(),
    subjectBytes: request.subjectBytes,
    subjectSha256: request.subjectSha256,
    attestationBytes: request.attestationBytes!,
    run: async (argv) => {
      expect(argv).toContain("verify");
      expect(argv).toContain("--deny-self-hosted-runners");
      return { code: 0, stdout: verifierBytes(request.subjectSha256).toString("utf8"), stderr: "" };
    },
  });

function input(
  overrides: Partial<ResolveAdminBaselineEvidenceV1Input> = {},
): ResolveAdminBaselineEvidenceV1Input {
  return {
    bootstrap,
    now,
    fetchFresh: async () => ({
      kind: "available",
      artifact: buildVendorBaselineEvidenceArtifactV1({
        lockBytes: vendorBaselineLockBytes(),
        publisher: {
          environment: bootstrap.expectedEnvironment,
          repository: bootstrap.expectedRepository,
        },
      }),
      attestationBytes: Buffer.from("verified through the injected live-verifier boundary"),
    }),
    readLastDownloaded: () => undefined,
    commitLastDownloaded: () => true,
    verifyGithubAttestation: liveVerify,
    ...overrides,
  };
}

async function withOperational<T>(
  use: (
    run: (
      clock?: string,
      cached?: boolean,
      runner?: Runner,
    ) => ReturnType<typeof resolveOperationalAdminBaselineEvidenceV1>,
  ) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "aih-workbench-evidence-"));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("unsafe fixture cleanup");
  const toolchain = join(root, "toolchain");
  const evidenceRoot = vibeAdminBaselineEvidenceRootV1(root);
  const artifact = buildVendorBaselineEvidenceArtifactV1({
    lockBytes: vendorBaselineLockBytes(),
    publisher: {
      environment: bootstrap.expectedEnvironment,
      repository: bootstrap.expectedRepository,
    },
  });
  try {
    mkdirSync(toolchain, { recursive: true });
    mkdirSync(evidenceRoot, { recursive: true });
    const gh = join(toolchain, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(gh, "test process boundary");
    if (process.platform !== "win32") chmodSync(gh, 0o700);
    writeFileSync(
      adminBaselineEvidenceBootstrapPathV1(evidenceRoot),
      canonicalStrictJsonBytesV1(bootstrap),
    );
    vi.mocked(defaultRunner).mockImplementation(async (argv) => {
      if (!argv.includes("--deny-self-hosted-runners"))
        throw new Error("fixture requires hardened verifier");
      return {
        code: 0,
        stderr: "",
        stdout: verifierBytes(artifact.subject.sha256).toString("utf8"),
      };
    });
    return await use((clock = now, cached = false, runner) =>
      resolveOperationalAdminBaselineEvidenceV1({
        adminRoot: root,
        env: { PATH: toolchain },
        now: clock,
        posture: "vibe",
        run: runner,
        fetchHttps: async ({ url }) => {
          if (cached) return { kind: "unavailable" };
          if (url === bootstrap.attestationUrl)
            return { kind: "available", bytes: Buffer.from("attestation bundle") };
          const file = artifact.files.find((item) => url === bootstrap.artifactUrl + item.path);
          return file ? { kind: "available", bytes: file.bytes } : { kind: "unavailable" };
        },
      }),
    );
  } finally {
    vi.mocked(defaultRunner).mockReset();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Core verified baseline evidence projection", () => {
  it("derives bounded scan facts from checked artifacts, with no qualification or organization permission", async () => {
    const resolved = await withOperational((run) => run());
    const { bundle } = defaultPreparedWorkbenchCatalog();
    const summaries = workbenchEvidenceFromVerifiedBaselineV1(resolved, bundle, now);
    expect(Object.keys(summaries).length).toBeGreaterThan(100);
    for (const summary of Object.values(summaries)) {
      const subject = summary.subjects[0]!;
      const source = lock.sources.find((item) => "source:" + item.id === subject.sourceId)!;
      const component = source.components.find(
        (item) => source.id + "/" + item.id === subject.assetId,
      )!;
      expect(summary.verification).toMatchObject({
        state: "verified",
        verifiedAt: now,
        validUntil: "2026-09-04T13:00:00Z",
      });
      expect(summary.subjects).toEqual([
        {
          assetId: subject.assetId,
          sourceId: subject.sourceId,
          sourceRevisionId: source.pinnedSha,
          contentDigest: "sha256:" + component.treeSha256,
        },
      ]);
      expect(summary.coveredPaths).toEqual([...component.paths].sort());
      expect(summary.scan).toEqual({
        outcome: component.verdict === "blocked" ? "failed" : "pass",
        coverage: "complete",
      });
      expect(summary.qualification).toEqual({ state: "unknown" });
    }
    const model = policyStudioModel(undefined, resolved.provenance, {
      verifiedBaseline: { resolved, now },
    });
    expect(model.workbenchBundle.evidence).toMatchObject(summaries);
    expect(model.initialPolicy.governance?.authority?.approvals).toEqual([]);
    expect(() => verifyAuthoringCatalogBundleIntegrityV1(model.workbenchBundle)).not.toThrow();
    expect(
      Object.values(defaultPreparedWorkbenchCatalog().bundle.evidence).every(
        (value) => value.verification.state !== "verified",
      ),
    ).toBe(true);
  });

  it("does not accept serialized custody, packaged provenance, or a verifier without bounded signing facts", async () => {
    const resolved = await withOperational((run) => run());
    const { bundle } = defaultPreparedWorkbenchCatalog();
    expect(workbenchEvidenceFromVerifiedBaselineV1(structuredClone(resolved), bundle, now)).toEqual(
      {},
    );
    const packaged = await resolveAdminBaselineEvidenceV1(
      input({ fetchFresh: async () => ({ kind: "unavailable" }) }),
    );
    expect(workbenchEvidenceFromVerifiedBaselineV1(packaged, bundle, now)).toEqual({});
    const oldSeam = await resolveAdminBaselineEvidenceV1(
      input({
        verifyGithubAttestation: async ({ policy, subjectSha256 }) => ({
          ...policy,
          subjectSha256,
          verified: true,
        }),
      }),
    );
    expect(workbenchEvidenceFromVerifiedBaselineV1(oldSeam, bundle, now)).toEqual({});
    const injectedOperational = await withOperational((run) =>
      run(now, false, async (args) => defaultRunner(args)),
    );
    expect(workbenchEvidenceFromVerifiedBaselineV1(injectedOperational, bundle, now)).toEqual({});
    for (const verifyGithubAttestation of [
      liveVerify,
      async ({ policy, subjectSha256 }: Parameters<typeof liveVerify>[0]) => ({
        ...policy,
        subjectSha256,
        verified: true as const,
        signedAt: "2026-09-04T11:00:00Z",
      }),
      async (request: Parameters<typeof liveVerify>[0]) =>
        parseGithubBaselineEvidenceAttestationV1(verifierBytes(request.subjectSha256), {
          ...bootstrap,
          now,
          subjectSha256: request.subjectSha256,
        }),
      async (request: Parameters<typeof liveVerify>[0]) =>
        structuredClone(await liveVerify(request)),
    ]) {
      const fake = await resolveAdminBaselineEvidenceV1(input({ verifyGithubAttestation }));
      expect(workbenchEvidenceFromVerifiedBaselineV1(fake, bundle, now)).toEqual({});
    }
  });

  it("fails closed on source, revision and content pin drift and never lends upstream scans to derived assets", async () => {
    const resolved = await withOperational((run) => run());
    const { bundle } = defaultPreparedWorkbenchCatalog();
    const first = Object.values(workbenchEvidenceFromVerifiedBaselineV1(resolved, bundle, now))[0]!;
    const subject = first.subjects[0]!;
    for (const mutate of [
      () => {
        bundle.assets[subject.assetId]!.contentDigest = "sha256:" + "0".repeat(64);
      },
      () => {
        bundle.assets[subject.assetId]!.sourceRevisionId = "changed";
      },
      () => {
        bundle.assets[subject.assetId]!.derivation = "organization-declaration";
      },
      () => {
        bundle.sources[subject.sourceId]!.revision.contentDigest = "sha256:" + "0".repeat(64);
      },
    ]) {
      const asset = structuredClone(bundle.assets[subject.assetId]!);
      const source = structuredClone(bundle.sources[subject.sourceId]!);
      mutate();
      expect(
        workbenchEvidenceFromVerifiedBaselineV1(resolved, bundle, now)[first.id],
      ).toBeUndefined();
      bundle.assets[subject.assetId] = asset;
      bundle.sources[subject.sourceId] = source;
    }
  });

  it("expires fresh/cache summaries at the original download deadline without promoting old pass or qualification", async () => {
    const cached = await withOperational(async (run) => {
      await run();
      return run("2026-09-04T12:30:00Z", true);
    });
    const { bundle } = defaultPreparedWorkbenchCatalog();
    expect(
      Object.values(
        workbenchEvidenceFromVerifiedBaselineV1(cached, bundle, "2026-09-04T12:59:59Z"),
      ).every(
        (summary) =>
          summary.verification.state === "verified" &&
          summary.verification.validUntil === "2026-09-04T13:00:00Z",
      ),
    ).toBe(true);
    for (const clock of ["2026-09-04T12:29:59Z", "2026-09-04T13:00:00Z"]) {
      const expired = Object.values(workbenchEvidenceFromVerifiedBaselineV1(cached, bundle, clock));
      expect(expired.length).toBeGreaterThan(0);
      expect(
        expired.every(
          (summary) =>
            summary.verification.state === "stale" &&
            summary.scan.outcome !== "pass" &&
            summary.qualification.state === "unknown",
        ),
      ).toBe(true);
    }
  });
});
