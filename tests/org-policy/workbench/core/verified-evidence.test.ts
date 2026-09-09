import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../../../src/contract/strict-json-v1.js";
import { defaultRunner, type Runner } from "../../../../src/internals/proc.js";
import { verifyWorkbenchPublicPublicationV1 } from "../../../../src/internals/verify-workbench-publication.js";
import {
  inspectPackagedPublicBaselineBytesV1,
  packagedPublicBaselineOverlayV1,
} from "../../../../src/org-policy/packaged-public-baseline-v1.js";
import { evidenceDisplayFor } from "../../../../src/org-policy/workbench/ui/evidence-display.js";

// Interpose the process implementation in this test module only. The product
// API exposes no witness/factory; runtime-injected verifiers remain untrusted.
vi.mock("../../../../src/internals/proc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/internals/proc.js")>()),
  defaultRunner: vi.fn(),
}));
// Baseline-proof tests isolate their fixture from independent release collection records.
vi.mock("../../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  PACKAGED_WORKBENCH_SOURCE_DATA_V1: [],
}));
vi.mock("../../../../src/org-policy/packaged-collection-evidence-data.js", () => ({
  PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1: [],
}));
vi.mock("../../../../src/org-policy/workbench/core/catalog-qualification-data.js", () => ({
  CATALOG_QUALIFICATION_PACKAGE_INPUT_V1: {
    version: 1,
    records: [],
    bindings: [],
    projections: [],
  },
}));
const packageFixture = vi.hoisted(() => ({
  bytes: null as string | null,
  sha256: null as string | null,
}));
vi.mock("../../../../src/org-policy/packaged-public-baseline-data.js", () => ({
  get PACKAGED_PUBLIC_BASELINE_BYTES_V1() {
    return packageFixture.bytes;
  },
  get PACKAGED_PUBLIC_BASELINE_SHA256_V1() {
    return packageFixture.sha256;
  },
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
  preparePackagedPublicBaselineEvidenceV1,
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
  it("prepares bounded package proof only from operational custody and retains blocked outcomes", async () => {
    const resolved = await withOperational((run) => run());
    const { bundle } = defaultPreparedWorkbenchCatalog();
    expect(() =>
      preparePackagedPublicBaselineEvidenceV1(structuredClone(resolved), bundle, now),
    ).toThrow(/custody/);
    const prepared = preparePackagedPublicBaselineEvidenceV1(resolved, bundle, now);
    expect(preparePackagedPublicBaselineEvidenceV1(resolved, bundle, now)).toEqual(prepared);
    const parsed = inspectPackagedPublicBaselineBytesV1(prepared.bytes, prepared.sha256);
    expect(parsed.publisher.repository).toBe("samartomar/ai-harness");
    expect(parsed).not.toHaveProperty("evidence");
    expect(parsed.verifiedAt).toBe(now);
    expect(parsed.validUntil).toBe("2026-09-04T13:00:00Z");
    packageFixture.bytes = prepared.bytes;
    packageFixture.sha256 = prepared.sha256;
    try {
      await verifyWorkbenchPublicPublicationV1({
        now,
        gh: "fixture-gh",
        run: async (argv) => {
          expect(argv).toContain("--deny-self-hosted-runners");
          expect(argv[argv.indexOf("--repo") + 1]).toBe("samartomar/ai-harness");
          expect(argv[argv.indexOf("--source-ref") + 1]).toBe("refs/heads/main");
          expect(argv[argv.indexOf("--cert-oidc-issuer") + 1]).toBe(
            "https://token.actions.githubusercontent.com",
          );
          expect(argv).toContain(
            "https://github.com/samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml@refs/heads/main",
          );
          return {
            code: 0,
            stderr: "",
            stdout: verifierBytes(parsed.artifactSubjectDigest.slice(7)).toString("utf8"),
          };
        },
      });
      await expect(
        verifyWorkbenchPublicPublicationV1({
          now,
          gh: "fixture-gh",
          run: async () => ({ code: 1, stdout: "", stderr: "verification failed" }),
        }),
      ).rejects.toThrow(/attestation verification failed/);
      await expect(verifyWorkbenchPublicPublicationV1({ now: parsed.validUntil })).rejects.toThrow(
        /original verification interval/,
      );
      const shifted = structuredClone(parsed);
      shifted.signedAt = "2026-09-04T11:01:00Z";
      packageFixture.bytes = canonicalStrictJsonBytesV1(shifted).toString("utf8");
      packageFixture.sha256 = `sha256:${createHash("sha256").update(packageFixture.bytes).digest("hex")}`;
      await expect(
        verifyWorkbenchPublicPublicationV1({
          now,
          gh: "fixture-gh",
          run: async () => ({
            code: 0,
            stderr: "",
            stdout: verifierBytes(parsed.artifactSubjectDigest.slice(7)).toString("utf8"),
          }),
        }),
      ).rejects.toThrow(/signing time/);
      shifted.artifactSubjectDigest = `sha256:${"0".repeat(64)}`;
      packageFixture.bytes = canonicalStrictJsonBytesV1(shifted).toString("utf8");
      packageFixture.sha256 = `sha256:${createHash("sha256").update(packageFixture.bytes).digest("hex")}`;
      await expect(verifyWorkbenchPublicPublicationV1({ now })).rejects.toThrow(
        /different artifact subject/,
      );
      packageFixture.bytes = prepared.bytes;
      packageFixture.sha256 = prepared.sha256;
      const overlay = packagedPublicBaselineOverlayV1(bundle);
      expect(
        Object.values(overlay).filter((report) => report.scan.outcome === "failed"),
      ).toHaveLength(42);
      expect(
        Object.values(overlay).every((report) => report.qualification.state === "unknown"),
      ).toBe(true);
      const first = Object.values(overlay)[0]!;
      const asset = bundle.assets[first.subjects[0]!.assetId]!;
      expect(evidenceDisplayFor(asset, [first], Date.parse(parsed.validUntil)).state).toBe("stale");
      asset.contentDigest = `sha256:${"0".repeat(64)}`;
      expect(packagedPublicBaselineOverlayV1(bundle)[first.id]).toBeUndefined();
      bundle.sources[first.subjects[0]!.sourceId]!.revision.id = "wrong-pin";
      expect(
        Object.values(packagedPublicBaselineOverlayV1(bundle)).some((report) =>
          report.subjects.some((subject) => subject.sourceId === first.subjects[0]!.sourceId),
        ),
      ).toBe(false);
    } finally {
      packageFixture.bytes = null;
      packageFixture.sha256 = null;
    }
    expect(() =>
      inspectPackagedPublicBaselineBytesV1(prepared.bytes + " ", prepared.sha256),
    ).toThrow(/seal/);
    for (const mutate of [
      (value: typeof parsed) => {
        value.lockDigest = `sha256:${"0".repeat(64)}`;
      },
      (value: typeof parsed) => {
        value.expectedAnalyzerPolicy["aih-native"] = "wrong";
      },
      (value: typeof parsed) => {
        value.validUntil = value.verifiedAt;
      },
      (value: typeof parsed) => {
        Object.assign(value, { evidence: { forged: { scan: { outcome: "pass" } } } });
      },
    ]) {
      const mutated = structuredClone(parsed);
      mutate(mutated);
      const bytes = canonicalStrictJsonBytesV1(mutated).toString("utf8");
      const seal = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      expect(() => inspectPackagedPublicBaselineBytesV1(bytes, seal)).toThrow();
    }
    expect(() =>
      preparePackagedPublicBaselineEvidenceV1(resolved, bundle, "2026-09-04T13:00:00Z"),
    ).toThrow(/expired/);
  });
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
        analyzers: component.analyzers.map(({ name, version }) => ({ name, version })),
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
