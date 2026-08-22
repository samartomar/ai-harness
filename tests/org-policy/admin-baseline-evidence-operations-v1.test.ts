import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vendorBaselineLockBytes } from "../../src/baseline-evidence/vendor.js";
import { buildVendorBaselineEvidenceArtifactV1 } from "../../src/baseline-evidence/vendor-artifact-v1.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  type AdminBaselineEvidenceBootstrapV1,
  adminBaselineEvidenceBootstrapPathV1,
  vibeAdminBaselineEvidenceRootV1,
} from "../../src/org-policy/admin-baseline-evidence-bootstrap-v1.js";
import {
  ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1,
  collectBoundedAdminBaselineEvidenceResponseV1,
  createAdminBaselineEvidenceHttpsFetchV1,
  defaultAdminBaselineEvidenceHttpsFetchV1,
  fetchAdminBaselineEvidenceArtifactV1,
  parseGithubBaselineEvidenceAttestationV1,
  resolveAdminBaselineEvidenceV1,
  resolveOperationalAdminBaselineEvidenceV1,
  verifyGithubBaselineEvidenceAttestationLiveV1,
} from "../../src/org-policy/admin-baseline-evidence-operations-v1.js";

const sources = [
  {
    id: "ecc",
    owner: "affaan-m",
    repo: "ecc",
    pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b",
  },
  {
    id: "superpowers",
    owner: "obra",
    repo: "Superpowers",
    pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
  },
];
const bootstrap: AdminBaselineEvidenceBootstrapV1 = {
  protocol: "AdminBaselineEvidenceBootstrapV1",
  artifactUrl: "https://evidence.example.test/artifact",
  attestationUrl: "https://evidence.example.test/attestation",
  cacheMaxAgeSeconds: 3600,
  expectedEnvironment: "baseline-evidence-publish",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedRepository: "samartomar/ai-harness",
  expectedWorkflow: "samartomar/ai-harness/.github/workflows/vendor-baseline-evidence.yml",
  minSchemaVersion: 1,
  maxSchemaVersion: 1,
  sources,
};
const artifact = buildVendorBaselineEvidenceArtifactV1({
  lockBytes: vendorBaselineLockBytes(),
  publisher: {
    environment: bootstrap.expectedEnvironment,
    repository: bootstrap.expectedRepository,
  },
});
const verify = async ({
  policy,
  subjectSha256,
}: {
  policy: {
    environment: string;
    issuer: string;
    ref: string;
    repository: string;
    workflow: string;
  };
  subjectSha256: string;
}) => ({ ...policy, subjectSha256, verified: true as const });

function malformedUnavailable(kind: "extra" | "nonplain" | "accessor"): unknown {
  if (kind === "extra") return { extra: true, kind: "unavailable" };
  if (kind === "nonplain") return Object.assign(Object.create(null), { kind: "unavailable" });
  return Object.defineProperty({}, "kind", {
    enumerable: true,
    get: () => "unavailable",
  });
}

describe("admin baseline evidence resolution v1", () => {
  it("classifies only absent first artifacts as unavailable and keeps transport failures terminal", async () => {
    const response = (statusCode: number | undefined) => {
      const listeners = new Map<string, ((...values: unknown[]) => void)[]>();
      let resumed = 0;
      return {
        emit(event: string, ...values: unknown[]) {
          for (const listener of listeners.get(event) ?? []) listener(...values);
        },
        response: {
          on(event: string, listener: (...values: unknown[]) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            return this;
          },
          resume() {
            resumed += 1;
            return this;
          },
          statusCode,
        },
        resumed: () => resumed,
      };
    };
    let statusAborts = 0;
    const missing = response(404);
    await expect(
      collectBoundedAdminBaselineEvidenceResponseV1(missing.response, 8, () => {
        statusAborts += 1;
      }),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(statusAborts).toBe(1);
    expect(missing.resumed()).toBe(0);

    const gone = response(410);
    await expect(
      collectBoundedAdminBaselineEvidenceResponseV1(gone.response, 8, () => {
        throw new Error("abort cleanup failed");
      }),
    ).resolves.toEqual({ kind: "unavailable" });

    const forbidden = response(403);
    await expect(
      collectBoundedAdminBaselineEvidenceResponseV1(forbidden.response, 8, () => undefined),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });

    const empty = response(200);
    const emptyResult = collectBoundedAdminBaselineEvidenceResponseV1(
      empty.response,
      8,
      () => undefined,
    );
    empty.emit("end");
    await expect(emptyResult).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });

    let aborted = 0;
    const tooLarge = response(200);
    const tooLargeResult = collectBoundedAdminBaselineEvidenceResponseV1(
      tooLarge.response,
      4,
      () => {
        aborted += 1;
      },
    );
    tooLarge.emit("data", Buffer.from("abcde"));
    await expect(tooLargeResult).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(aborted).toBe(1);

    const broken = response(200);
    const brokenResult = collectBoundedAdminBaselineEvidenceResponseV1(
      broken.response,
      8,
      () => undefined,
    );
    broken.emit("data", Buffer.from("abc"));
    broken.emit("aborted");
    await expect(brokenResult).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });

    let terminalAborts = 0;
    const terminal = response(200);
    const terminalResult = collectBoundedAdminBaselineEvidenceResponseV1(
      terminal.response,
      8,
      () => {
        terminalAborts += 1;
        throw new Error("abort cleanup failed");
      },
    );
    terminal.emit("data", "not bytes");
    terminal.emit("data", Buffer.from("later bytes"));
    terminal.emit("end");
    terminal.emit("error");
    terminal.emit("close");
    await expect(terminalResult).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(terminalAborts).toBe(1);

    await expect(
      defaultAdminBaselineEvidenceHttpsFetchV1({
        maxBytes: 8,
        timeoutMs: 10,
        url: "not a locator",
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });

    let timedOutRequestDestroyed = 0;
    const fetchWithTotalDeadline = createAdminBaselineEvidenceHttpsFetchV1(() => ({
      destroy() {
        timedOutRequestDestroyed += 1;
      },
      end() {
        return undefined;
      },
      on() {
        return this;
      },
    }));
    await expect(
      fetchWithTotalDeadline({
        maxBytes: 8,
        timeoutMs: 1,
        url: "https://evidence.example.test/artifact",
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(timedOutRequestDestroyed).toBe(1);

    let idleTimeout: (() => void) | undefined;
    const fetchWithThrowingIdleTeardown = createAdminBaselineEvidenceHttpsFetchV1(() => ({
      destroy() {
        throw new Error("teardown failed");
      },
      end() {
        return undefined;
      },
      on(event, listener) {
        if (event === "timeout") idleTimeout = listener;
        return this;
      },
    }));
    const idleTimeoutResult = fetchWithThrowingIdleTeardown({
      maxBytes: 8,
      timeoutMs: 1,
      url: "https://evidence.example.test/artifact",
    });
    void idleTimeoutResult.catch(() => undefined);
    expect(idleTimeout).toBeTypeOf("function");
    expect(() => idleTimeout?.()).not.toThrow();
    await expect(idleTimeoutResult).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });

    let cacheReads = 0;
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: () =>
          fetchAdminBaselineEvidenceArtifactV1({
            artifactUrl: "https://evidence.example.test/artifact/",
            attestationUrl: bootstrap.attestationUrl,
            fetchHttps: async () =>
              collectBoundedAdminBaselineEvidenceResponseV1(
                response(500).response,
                8,
                () => undefined,
              ),
          }),
        readLastDownloaded: () => {
          cacheReads += 1;
          return undefined;
        },
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(cacheReads).toBe(0);
  });

  it("stages an offline bundle under custody and pins the gh verifier argv", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-gh-"));
    const argv: string[][] = [];
    try {
      await expect(
        verifyGithubBaselineEvidenceAttestationLiveV1({
          bootstrap,
          subjectBytes: Buffer.from("sum"),
          subjectSha256: createHash("sha256").update("sum").digest("hex"),
          attestationBytes: Buffer.from("bundle"),
          gh: "/tools/gh",
          tempRoot: root,
          run: async (args) => {
            argv.push(args);
            return { code: 1, stdout: "", stderr: "" };
          },
          now: "2026-08-21T00:00:00Z",
        }),
      ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
      expect(argv[0]).toEqual(
        expect.arrayContaining([
          "attestation",
          "verify",
          "--bundle",
          "--format",
          "json",
          "--repo",
          bootstrap.expectedRepository,
          "--predicate-type",
          "https://slsa.dev/provenance/v1",
          "--cert-identity",
          `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
          "--cert-oidc-issuer",
          bootstrap.expectedIssuer,
          "--source-ref",
          bootstrap.expectedRef,
          "--deny-self-hosted-runners",
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("accepts only one real nested gh JSON SLSA result, never an echoed policy", () => {
    const subjectSha256 = "a".repeat(64);
    const realShape = [
      {
        attestation: { bundle: {} },
        verificationResult: {
          mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
          signature: {
            certificate: {
              subjectAlternativeName: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
              issuer: bootstrap.expectedIssuer,
              buildSignerURI: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
              buildConfigURI: `https://github.com/${bootstrap.expectedWorkflow}@${bootstrap.expectedRef}`,
              runnerEnvironment: "github-hosted",
              sourceRepositoryURI: `https://github.com/${bootstrap.expectedRepository}`,
              sourceRepositoryRef: bootstrap.expectedRef,
            },
          },
          verifiedTimestamps: [
            {
              type: "signed",
              uri: "https://rekor.sigstore.dev",
              timestamp: "2026-08-20T18:59:00-05:00",
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
    ];
    expect(
      parseGithubBaselineEvidenceAttestationV1(Buffer.from(JSON.stringify(realShape)), {
        ...bootstrap,
        subjectSha256,
        now: "2026-08-21T00:00:00Z",
      }),
    ).toMatchObject({ verified: true, signedAt: "2026-08-20T23:59:00Z" });
    const stale = structuredClone(realShape);
    stale[0]?.verificationResult.verifiedTimestamps.splice(0, 1, {
      timestamp: "2025-01-01T00:00:00Z",
      type: "signed",
      uri: "https://rekor.sigstore.dev",
    });
    expect(
      parseGithubBaselineEvidenceAttestationV1(Buffer.from(JSON.stringify(stale)), {
        ...bootstrap,
        subjectSha256,
        now: "2026-08-21T00:00:00Z",
      }),
    ).toMatchObject({ verified: true, signedAt: "2025-01-01T00:00:00Z" });
    const future = structuredClone(realShape);
    future[0]?.verificationResult.verifiedTimestamps.splice(0, 1, {
      timestamp: "2026-08-21T00:00:01Z",
      type: "signed",
      uri: "https://rekor.sigstore.dev",
    });
    expect(() =>
      parseGithubBaselineEvidenceAttestationV1(Buffer.from(JSON.stringify(future)), {
        ...bootstrap,
        subjectSha256,
        now: "2026-08-21T00:00:00Z",
      }),
    ).toThrow(/admin baseline evidence/);
    const verification = (claim: typeof realShape) => {
      const result = claim[0]?.verificationResult;
      if (result === undefined) throw new Error("expected verification result");
      return result;
    };
    for (const [label, mutate] of [
      [
        "SAN",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.subjectAlternativeName =
            "https://wrong.example";
        },
      ],
      [
        "build signer",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.buildSignerURI = "https://wrong.example";
        },
      ],
      [
        "build config",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.buildConfigURI = "https://wrong.example";
        },
      ],
      [
        "issuer",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.issuer = "https://wrong.example";
        },
      ],
      [
        "source URI",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.sourceRepositoryURI =
            "https://github.com/wrong/repo";
        },
      ],
      [
        "source ref",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.sourceRepositoryRef = "refs/heads/wrong";
        },
      ],
      [
        "self-hosted runner",
        (claim: typeof realShape) => {
          verification(claim).signature.certificate.runnerEnvironment = "self-hosted";
        },
      ],
      [
        "predicate",
        (claim: typeof realShape) => {
          verification(claim).statement.predicateType = "wrong";
        },
      ],
      [
        "subject digest",
        (claim: typeof realShape) => {
          const subject = verification(claim).statement.subject[0];
          if (subject === undefined) throw new Error("expected attestation subject");
          subject.digest.sha256 = "b".repeat(64);
        },
      ],
    ]) {
      const mutated = structuredClone(realShape);
      mutate(mutated);
      expect(
        () =>
          parseGithubBaselineEvidenceAttestationV1(Buffer.from(JSON.stringify(mutated)), {
            ...bootstrap,
            subjectSha256,
            now: "2026-08-21T00:00:00Z",
          }),
        label,
      ).toThrow(/admin baseline evidence/);
    }
    expect(() =>
      parseGithubBaselineEvidenceAttestationV1(Buffer.from(JSON.stringify({ subjectSha256 })), {
        ...bootstrap,
        subjectSha256,
        now: "2026-08-21T00:00:00Z",
      }),
    ).toThrow(/admin baseline evidence/);
    expect(() =>
      parseGithubBaselineEvidenceAttestationV1(
        Buffer.from(
          JSON.stringify([
            {
              ...realShape[0],
              verificationResult: {
                ...realShape[0]?.verificationResult,
                verifiedTimestamps: [
                  {
                    type: "signed",
                    uri: "https://rekor.sigstore.dev",
                    timestamp: "2026-02-31T18:59:00-05:00",
                  },
                ],
              },
            },
          ]),
        ),
        { ...bootstrap, subjectSha256, now: "2026-08-21T00:00:00Z" },
      ),
    ).toThrow(/admin baseline evidence/);
  });
  it("uses fresh evidence before cache and only falls through on literal unavailable", async () => {
    const calls: string[] = [];
    const result = await resolveAdminBaselineEvidenceV1({
      bootstrap,
      now: "2026-08-21T00:00:00Z",
      fetchFresh: async () => {
        calls.push("fresh");
        return { kind: "available", artifact, attestationBytes: Buffer.from("attestation") };
      },
      readLastDownloaded: () => {
        calls.push("cache");
        return undefined;
      },
      commitLastDownloaded: () => {
        calls.push("commit");
        return true;
      },
      verifyGithubAttestation: verify,
    });
    expect(result.provenance.tier).toBe("fresh");
    expect(calls).toEqual(["fresh", "commit"]);
  });

  it("awaits the live attestation before the synchronous artifact claim and cache custody", async () => {
    const calls: string[] = [];
    const result = await resolveAdminBaselineEvidenceV1({
      bootstrap,
      now: "2026-08-21T00:00:00Z",
      fetchFresh: async () => {
        calls.push("fresh");
        return {
          kind: "available" as const,
          artifact,
          attestationBytes: Buffer.from("attestation"),
        };
      },
      readLastDownloaded: () => {
        calls.push("cache");
        return undefined;
      },
      commitLastDownloaded: () => {
        calls.push("commit");
        return true;
      },
      verifyGithubAttestation: async (request) => {
        calls.push("verify");
        await Promise.resolve();
        return { ...request.policy, subjectSha256: request.subjectSha256, verified: true as const };
      },
    });
    expect(result.provenance.tier).toBe("fresh");
    expect(calls).toEqual(["fresh", "verify", "commit"]);
  });

  it.each([false, undefined])("treats cache commit %j as terminal", async (commit) => {
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({
          kind: "available",
          artifact,
          attestationBytes: Buffer.from("attestation"),
        }),
        readLastDownloaded: () => undefined,
        commitLastDownloaded: () => commit as never,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it("never commits fresh bytes when live attestation verification fails", async () => {
    let committed = 0;
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({
          kind: "available",
          artifact,
          attestationBytes: Buffer.from("attestation"),
        }),
        readLastDownloaded: () => undefined,
        commitLastDownloaded: () => {
          committed += 1;
          return true;
        },
        verifyGithubAttestation: async () => {
          throw new Error("unverified");
        },
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(committed).toBe(0);
  });

  it("reverifies cache after literal unavailable and never masks malformed fresh input", async () => {
    const cached = {
      artifact,
      attestationBytes: Buffer.from("attestation"),
      downloadedAt: "2026-08-20T23:59:00Z",
    };
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({ kind: "unavailable" }),
        readLastDownloaded: () => cached,
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).resolves.toMatchObject({ provenance: { tier: "last-downloaded", ageSeconds: 60 } });
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({
          kind: "available",
          artifact: {} as never,
          attestationBytes: Buffer.from("x"),
        }),
        readLastDownloaded: () => cached,
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it("rejects an impossible Gregorian input clock before cache-age authority", async () => {
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-02-31T00:00:00Z",
        fetchFresh: async () => ({ kind: "unavailable" }),
        readLastDownloaded: () => ({
          artifact,
          attestationBytes: Buffer.from("attestation"),
          downloadedAt: "2026-03-03T00:00:00Z",
        }),
        commitLastDownloaded: () => true,
        verifyGithubAttestation: verify,
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it("uses packaged evidence only after unavailable fresh and absent cache", async () => {
    const result = await resolveAdminBaselineEvidenceV1({
      bootstrap,
      now: "2026-08-21T00:00:00Z",
      fetchFresh: async () => ({ kind: "unavailable" }),
      readLastDownloaded: () => undefined,
      commitLastDownloaded: () => true,
      verifyGithubAttestation: verify,
    });
    expect(result.provenance).toMatchObject({
      tier: "packaged",
      ageSeconds: null,
      sourceIds: ["ecc", "superpowers"],
      schemaVersion: 1,
      digest: createHash("sha256").update(vendorBaselineLockBytes()).digest("hex"),
    });
  });

  it("treats stale cache custody and bootstrap identity incompatibility as terminal before verification", async () => {
    let verifierCalls = 0;
    await expect(
      resolveAdminBaselineEvidenceV1({
        bootstrap,
        now: "2026-08-21T00:00:00Z",
        fetchFresh: async () => ({ kind: "unavailable" }),
        readLastDownloaded: () => ({
          artifact,
          attestationBytes: Buffer.from("attestation"),
          downloadedAt: "2026-08-20T22:59:59Z",
        }),
        commitLastDownloaded: () => true,
        verifyGithubAttestation: async () => {
          verifierCalls += 1;
          throw new Error("verifier must not run for stale cache");
        },
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    expect(verifierCalls).toBe(0);

    for (const incompatible of [
      { ...bootstrap, maxSchemaVersion: 2, minSchemaVersion: 2 },
      {
        ...bootstrap,
        sources: [{ ...bootstrap.sources[0], pinnedSha: "a".repeat(40) }, bootstrap.sources[1]],
      },
    ]) {
      await expect(
        resolveAdminBaselineEvidenceV1({
          bootstrap: incompatible,
          now: "2026-08-21T00:00:00Z",
          fetchFresh: async () => ({ kind: "unavailable" }),
          readLastDownloaded: () => undefined,
          commitLastDownloaded: () => true,
          verifyGithubAttestation: verify,
        }),
      ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    }
  });

  it.each(["extra", "nonplain", "accessor"] as const)(
    "rejects %s unavailable fresh results before cache or packaged authority",
    async (kind) => {
      let cacheReads = 0;
      await expect(
        resolveAdminBaselineEvidenceV1({
          bootstrap,
          now: "2026-08-21T00:00:00Z",
          fetchFresh: async () => malformedUnavailable(kind) as never,
          readLastDownloaded: () => {
            cacheReads += 1;
            return undefined;
          },
          commitLastDownloaded: () => true,
          verifyGithubAttestation: verify,
        }),
      ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
      expect(cacheReads).toBe(0);
    },
  );

  it("treats a partially available fresh artifact as terminal instead of falling through", async () => {
    let calls = 0;
    await expect(
      fetchAdminBaselineEvidenceArtifactV1({
        artifactUrl: "https://evidence.example.test/artifact/",
        attestationUrl: bootstrap.attestationUrl,
        fetchHttps: async () => {
          calls += 1;
          return calls === 1
            ? { kind: "available" as const, bytes: artifact.files[0]?.bytes ?? Buffer.from("x") }
            : { kind: "unavailable" as const };
        },
      }),
    ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
  });

  it.each(["extra", "nonplain", "accessor"] as const)(
    "rejects %s unavailable first-file acquisition results",
    async (kind) => {
      await expect(
        fetchAdminBaselineEvidenceArtifactV1({
          artifactUrl: "https://evidence.example.test/artifact/",
          attestationUrl: bootstrap.attestationUrl,
          fetchHttps: async () => malformedUnavailable(kind) as never,
        }),
      ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    },
  );

  it.each(["extra", "nonplain", "accessor"] as const)(
    "rejects %s unavailable attestation acquisition results",
    async (kind) => {
      await expect(
        fetchAdminBaselineEvidenceArtifactV1({
          artifactUrl: "https://evidence.example.test/artifact/",
          attestationUrl: bootstrap.attestationUrl,
          fetchHttps: async ({ url }) => {
            const path = ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.find((candidate) =>
              url.endsWith(`/${candidate}`),
            );
            if (path === undefined) return malformedUnavailable(kind) as never;
            return {
              kind: "available" as const,
              bytes:
                artifact.files.find((file) => file.path === path)?.bytes ?? Buffer.from("missing"),
            };
          },
        }),
      ).rejects.toMatchObject({ code: "AIH_ADMIN_BASELINE_EVIDENCE" });
    },
  );

  it("composes bootstrap, five raw files, live gh verification, and reverified custody cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-operational-"));
    const toolchain = join(root, "toolchain");
    const operationalBootstrap = {
      ...bootstrap,
      artifactUrl: "https://evidence.example.test/artifact/",
    };
    const urls: string[] = [];
    const argv: string[][] = [];
    try {
      mkdirSync(toolchain, { recursive: true });
      const gh = join(toolchain, process.platform === "win32" ? "gh.exe" : "gh");
      writeFileSync(gh, "test gh");
      if (process.platform !== "win32") chmodSync(gh, 0o700);
      const evidenceRoot = vibeAdminBaselineEvidenceRootV1(root);
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(
        adminBaselineEvidenceBootstrapPathV1(evidenceRoot),
        canonicalStrictJsonBytesV1(operationalBootstrap),
      );
      const fresh = await resolveOperationalAdminBaselineEvidenceV1({
        adminRoot: root,
        env: { PATH: toolchain },
        fetchHttps: async ({ url }) => {
          urls.push(url);
          const path = ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.find((candidate) =>
            url.endsWith(`/${candidate}`),
          );
          if (path === undefined)
            return url === operationalBootstrap.attestationUrl
              ? { kind: "available" as const, bytes: Buffer.from("bundle") }
              : { kind: "unavailable" as const };
          return {
            kind: "available" as const,
            bytes:
              artifact.files.find((file) => file.path === path)?.bytes ?? Buffer.from("missing"),
          };
        },
        now: "2026-08-21T00:00:00Z",
        posture: "vibe",
        run: async (args) => {
          argv.push(args);
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                attestation: { bundle: {} },
                verificationResult: {
                  mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
                  signature: {
                    certificate: {
                      buildConfigURI: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                      buildSignerURI: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                      issuer: operationalBootstrap.expectedIssuer,
                      runnerEnvironment: "github-hosted",
                      sourceRepositoryRef: operationalBootstrap.expectedRef,
                      sourceRepositoryURI: `https://github.com/${operationalBootstrap.expectedRepository}`,
                      subjectAlternativeName: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                    },
                  },
                  statement: {
                    _type: "https://in-toto.io/Statement/v1",
                    predicate: {},
                    predicateType: "https://slsa.dev/provenance/v1",
                    subject: [{ digest: { sha256: artifact.subject.sha256 }, name: "SHA256SUMS" }],
                  },
                  verifiedTimestamps: [
                    {
                      timestamp: "2026-08-20T23:59:00Z",
                      type: "signed",
                      uri: "https://rekor.sigstore.dev",
                    },
                  ],
                },
              },
            ]),
          };
        },
        tempRoot: root,
      });
      expect(fresh.provenance.tier).toBe("fresh");
      expect(urls).toHaveLength(6);
      expect(argv).toHaveLength(1);
      const cached = await resolveOperationalAdminBaselineEvidenceV1({
        adminRoot: root,
        env: { PATH: toolchain },
        fetchHttps: async ({ url }) => {
          urls.push(url);
          return { kind: "unavailable" as const };
        },
        now: "2026-08-21T00:00:00Z",
        posture: "vibe",
        run: async (args) => {
          argv.push(args);
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                attestation: { bundle: {} },
                verificationResult: {
                  mediaType: "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
                  signature: {
                    certificate: {
                      buildConfigURI: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                      buildSignerURI: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                      issuer: operationalBootstrap.expectedIssuer,
                      runnerEnvironment: "github-hosted",
                      sourceRepositoryRef: operationalBootstrap.expectedRef,
                      sourceRepositoryURI: `https://github.com/${operationalBootstrap.expectedRepository}`,
                      subjectAlternativeName: `https://github.com/${operationalBootstrap.expectedWorkflow}@${operationalBootstrap.expectedRef}`,
                    },
                  },
                  statement: {
                    _type: "https://in-toto.io/Statement/v1",
                    predicate: {},
                    predicateType: "https://slsa.dev/provenance/v1",
                    subject: [{ digest: { sha256: artifact.subject.sha256 }, name: "SHA256SUMS" }],
                  },
                  verifiedTimestamps: [
                    {
                      timestamp: "2026-08-20T23:59:00Z",
                      type: "signed",
                      uri: "https://rekor.sigstore.dev",
                    },
                  ],
                },
              },
            ]),
          };
        },
        tempRoot: root,
      });
      expect(cached.provenance.tier).toBe("last-downloaded");
      expect(argv).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
