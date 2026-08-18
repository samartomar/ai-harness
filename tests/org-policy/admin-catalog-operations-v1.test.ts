import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import type { RunResult } from "../../src/internals/proc.js";
import {
  adminCatalogBootstrapPathV1,
  adminCatalogCacheSlotPathV1,
  parseAdminCatalogBootstrapV1Json,
  vibeAdminCatalogRootV1,
} from "../../src/org-policy/admin-catalog-bootstrap-v1.js";
import {
  type AdminCatalogHttpsResponseV1,
  collectBoundedAdminCatalogResponseV1,
  defaultAdminCatalogHttpsFetchV1,
  resolveOperationalAdminCatalogV1,
} from "../../src/org-policy/admin-catalog-operations-v1.js";
import {
  adminSignerIdentity,
  adminWorkflowIdentity,
  artifactBytes,
  attestationBytes,
  bootstrapBytes,
  bootstrapRecord,
  cacheRecordBytes,
  catalogArtifactUrl,
  catalogAttestationUrl,
  channel,
  distributionAttestationBytes,
  expectedCatalogSha256,
  headRoot,
  persistedState,
  presignedDistributionBytes,
  resolvedAt,
  sha,
  signedDistributionAttestationUrl,
  signedDistributionUrl,
  sourceId,
  workflowIdentity,
} from "./admin-catalog-fixtures.js";

let workspace: string;
let adminRoot: string;
let platformAdminRoot: string;
let tempRoot: string;
let toolchain: string;

const WALL_CLOCK = "2026-08-17T12:00:10Z";

interface Recorded {
  attestations: { artifact: Buffer; signerWorkflow: string | undefined }[];
  urls: { url: string; maxBytes: number; timeoutMs: number }[];
  argv: string[][];
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-admin-catalog-ops-"));
  adminRoot = join(workspace, "admin");
  platformAdminRoot = join(workspace, "platform");
  tempRoot = join(workspace, "staging");
  toolchain = join(workspace, "toolchain");
  mkdirSync(adminRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(toolchain, { recursive: true });
  const gh = join(toolchain, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "test gh");
  if (process.platform !== "win32") chmodSync(gh, 0o700);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function seedBootstrap(
  overrides: Record<string, unknown> = {},
  posture: "vibe" | "enterprise" = "vibe",
): string {
  const root = posture === "enterprise" ? platformAdminRoot : vibeAdminCatalogRootV1(adminRoot);
  mkdirSync(root, { recursive: true });
  writeFileSync(adminCatalogBootstrapPathV1(root), bootstrapBytes(overrides));
  return root;
}

function cacheSlot(root: string): string {
  return adminCatalogCacheSlotPathV1(root, parseAdminCatalogBootstrapV1Json(bootstrapBytes()));
}

function seedCache(root: string, bytes: Buffer = cacheRecordBytes()): string {
  const slot = cacheSlot(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  writeFileSync(slot, bytes);
  return slot;
}

interface HarnessOptions {
  artifact?: AdminCatalogHttpsResponseV1;
  attestation?: AdminCatalogHttpsResponseV1;
  distribution?: AdminCatalogHttpsResponseV1;
  distributionAttestation?: AdminCatalogHttpsResponseV1;
  gh?: Partial<RunResult>;
}

function harness(options: HarnessOptions = {}) {
  const recorded: Recorded = { argv: [], attestations: [], urls: [] };
  const responses: Record<string, AdminCatalogHttpsResponseV1> = {
    [catalogArtifactUrl]: options.artifact ?? { kind: "available", bytes: artifactBytes() },
    [catalogAttestationUrl]: options.attestation ?? { kind: "available", bytes: attestationBytes },
    [signedDistributionUrl]: options.distribution ?? {
      kind: "available",
      bytes: presignedDistributionBytes(),
    },
    [signedDistributionAttestationUrl]: options.distributionAttestation ?? {
      kind: "available",
      bytes: distributionAttestationBytes,
    },
  };
  return {
    recorded,
    fetchHttps: async (request: { url: string; maxBytes: number; timeoutMs: number }) => {
      recorded.urls.push(request);
      return responses[request.url] ?? { kind: "unavailable" as const };
    },
    run: async (argv: string[]): Promise<RunResult> => {
      recorded.argv.push(argv);
      const artifact = readFileSync(argv[3] ?? "");
      const bundle = readFileSync(argv[argv.indexOf("--bundle") + 1] ?? "");
      recorded.attestations.push({
        artifact: Buffer.from(artifact),
        signerWorkflow: argv[argv.indexOf("--signer-workflow") + 1],
      });
      const isCatalog =
        artifact.compare(artifactBytes()) === 0 && bundle.compare(attestationBytes) === 0;
      const isDistribution =
        ["fresh", "cached-verified", "packaged"].some(
          (tier) =>
            artifact.compare(
              presignedDistributionBytes({
                tier: tier as "fresh" | "cached-verified" | "packaged",
              }),
            ) === 0,
        ) && bundle.compare(distributionAttestationBytes) === 0;
      return { code: isCatalog || isDistribution ? 0 : 1, stdout: "", stderr: "", ...options.gh };
    },
  };
}

function replaceDistributionSignature(bytes: Buffer): Buffer {
  const distribution = JSON.parse(bytes.toString("utf8")) as {
    envelope: { signatures: { keyid: string; sig: string }[] };
  };
  distribution.envelope.signatures[0] = { keyid: "admin-key-1", sig: "Zm9yZ2Vk" };
  return canonicalStrictJsonBytesV1(distribution);
}

function replaceCatalogHeadSignature(bytes: Buffer): Buffer {
  const artifact = JSON.parse(bytes.toString("utf8")) as Record<string, string>;
  const state = JSON.parse(
    Buffer.from(artifact.catalogStateBytes ?? "", "base64").toString("utf8"),
  ) as Record<string, string>;
  const envelope = JSON.parse(
    Buffer.from(state.catalogHeadEnvelopeBytes ?? "", "base64").toString("utf8"),
  ) as { signatures: { keyid: string; sig: string }[] };
  envelope.signatures[0] = { keyid: "head-key-1", sig: "Zm9yZ2Vk" };
  const envelopeBytes = canonicalStrictJsonBytesV1(envelope);
  state.catalogHeadEnvelopeBytes = envelopeBytes.toString("base64");
  state.catalogHeadEnvelopeSha256 = sha(envelopeBytes);
  const stateBytes = canonicalStrictJsonBytesV1(state);
  artifact.catalogStateBytes = stateBytes.toString("base64");
  artifact.catalogStateSha256 = sha(stateBytes);
  return canonicalStrictJsonBytesV1(artifact);
}

function resolveWith(options: HarnessOptions = {}, over: Record<string, unknown> = {}) {
  const seams = harness(options);
  return {
    seams,
    result: resolveOperationalAdminCatalogV1({
      adminRoot,
      fetchHttps: seams.fetchHttps,
      env: { PATH: toolchain },
      now: WALL_CLOCK,
      platformAdminRoot,
      posture: "vibe",
      run: seams.run,
      tempRoot,
      ...over,
    }),
  };
}

describe("operational admin catalog integration V1", () => {
  it("resolves fresh material through a completed gh attestation verify before any workbench provenance", async () => {
    seedBootstrap();
    const { seams, result } = resolveWith();
    const provenance = await result;

    expect(provenance.tier).toBe("fresh");
    expect(provenance.ageSeconds).toBe(0);
    expect(provenance.sequence).toBe(42);
    expect(provenance.memberCount).toBe(1);
    expect(provenance.sourceId).toBe(sourceId);
    expect(provenance.channel).toBe(channel);
    expect(provenance.resolvedAt).toBe(resolvedAt);
    expect(provenance.catalogSha256).toBe(expectedCatalogSha256());
    expect(provenance.headDigestSha256).toBe(persistedState().catalogHeadSha256);
    expect(provenance.bootstrapProvenance).toBe("local-admin-file");
    expect(provenance.posture).toBe("vibe");

    // Two exact attestation verifications, fully completed before the
    // synchronous foundation callbacks, against the derived repository identity.
    expect(seams.recorded.argv).toHaveLength(2);
    const argv = seams.recorded.argv.find((candidate) => candidate.includes("--bundle")) ?? [];
    expect(argv.slice(1, 3)).toEqual(["attestation", "verify"]);
    expect(argv).toContain("--repo");
    expect(argv[argv.indexOf("--repo") + 1]).toBe("aih/supported-catalog");
    expect(argv).toContain("--bundle");
    for (const path of [argv[3], argv[argv.indexOf("--bundle") + 1]]) {
      expect(path?.startsWith(tempRoot)).toBe(true);
      expect(existsSync(path ?? "")).toBe(false); // staging is removed after verification
    }
    expect(
      seams.recorded.attestations.find(
        (entry) => entry.artifact.compare(presignedDistributionBytes()) === 0,
      )?.signerWorkflow,
    ).toBe(adminWorkflowIdentity);
    expect(
      seams.recorded.attestations.find((entry) => entry.artifact.compare(artifactBytes()) === 0)
        ?.signerWorkflow,
    ).toBe(workflowIdentity);

    // Bounded acquisition for every locator.
    expect(seams.recorded.urls.map((entry) => entry.url).sort()).toEqual(
      [
        catalogArtifactUrl,
        catalogAttestationUrl,
        signedDistributionUrl,
        signedDistributionAttestationUrl,
      ].sort(),
    );
    for (const entry of seams.recorded.urls) {
      expect(entry.maxBytes).toBeGreaterThan(0);
      expect(entry.maxBytes).toBeLessThanOrEqual(96 * 1024);
      expect(entry.timeoutMs).toBeGreaterThan(0);
      expect(entry.timeoutMs).toBeLessThanOrEqual(30_000);
    }

    // The verified fresh material is committed into the contained cache slot.
    const root = vibeAdminCatalogRootV1(adminRoot);
    expect(existsSync(cacheSlot(root))).toBe(true);
    expect(cacheSlot(root).startsWith(root)).toBe(true);
  });

  it("shows only safe provenance: no locator, path, token, signature, attestation, or machine detail", async () => {
    seedBootstrap();
    const provenance = await resolveWith().result;
    expect(Object.keys(provenance).sort()).toEqual([
      "ageSeconds",
      "bootstrapProvenance",
      "catalogSha256",
      "channel",
      "headDigestSha256",
      "memberCount",
      "posture",
      "resolvedAt",
      "sequence",
      "sourceId",
      "tier",
      "verifiedAt",
    ]);
    const rendered = JSON.stringify(provenance);
    for (const secret of [
      "https://",
      workspace,
      "keyid",
      "attestation",
      "signer",
      adminSignerIdentity,
      headRoot,
      attestationBytes.toString("base64"),
    ]) {
      expect(rendered.includes(secret), secret).toBe(false);
    }
    expect(Object.isFrozen(provenance)).toBe(true);
  });

  it("revalidates the verified cache only when fresh acquisition is literally unavailable", async () => {
    const root = seedBootstrap();
    seedCache(root);
    const { seams, result } = resolveWith({
      artifact: { kind: "unavailable" },
      distribution: {
        kind: "available",
        bytes: presignedDistributionBytes({ tier: "cached-verified" }),
      },
    });
    const provenance = await result;
    expect(provenance.tier).toBe("cached-verified");
    expect(provenance.ageSeconds).toBe(40);
    // The cached artifact is reattested; the cache is never trusted on its face.
    expect(seams.recorded.argv).toHaveLength(2);
  });

  it("falls back to packaged state only when fresh and cache are both literally unavailable", async () => {
    seedBootstrap();
    const { seams, result } = resolveWith({
      artifact: { kind: "unavailable" },
      distribution: {
        kind: "available",
        bytes: presignedDistributionBytes({ tier: "packaged" }),
      },
    });
    const provenance = await result;
    expect(provenance.tier).toBe("packaged");
    expect(provenance.ageSeconds).toBeNull();
    // Packaged state is bootstrap-carried, but its pre-signed distribution is
    // independently provenance-verified before rendering.
    expect(seams.recorded.argv).toHaveLength(1);
  });

  it("treats an oversize or failed acquisition as unavailable and never as trusted material", async () => {
    const root = seedBootstrap();
    seedCache(root);
    const { result } = resolveWith({
      artifact: { kind: "available", bytes: Buffer.alloc(64 * 1024 + 1, 0x61) },
      distribution: {
        kind: "available",
        bytes: presignedDistributionBytes({ tier: "cached-verified" }),
      },
    });
    expect((await result).tier).toBe("cached-verified");
  });

  it("treats every non-verified gh attestation outcome as fatal instead of a quiet fallback", async () => {
    const root = seedBootstrap();
    seedCache(root);
    for (const gh of [
      { code: 1, stderr: "HOSTILE-SECRET-abcdef verification failed" },
      { code: 0, truncated: true },
      { code: 127, spawnError: true, stderr: "gh not found" },
      { code: null as number | null },
    ]) {
      const { result } = resolveWith({ gh });
      const failure = await result.then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure, JSON.stringify(gh)).toBeInstanceOf(Error);
      expect(failure?.message).not.toContain("HOSTILE-SECRET");
    }
  });

  it("never signs: absent, mismatched, or wrong-tier pre-signed material is fatal before the workbench", async () => {
    seedBootstrap();
    for (const distribution of [
      { kind: "unavailable" as const },
      { kind: "available" as const, bytes: Buffer.from("{}", "utf8") },
      { kind: "available" as const, bytes: presignedDistributionBytes({ tier: "packaged" }) },
      {
        kind: "available" as const,
        bytes: presignedDistributionBytes({ tier: "cached-verified" }),
      },
      { kind: "available" as const, bytes: presignedDistributionBytes().subarray(0, 40) },
    ]) {
      await expect(resolveWith({ distribution }).result).rejects.toThrow();
    }
  });

  it("rejects a forged pre-signed distribution signature even when its pinned binding facts remain canonical", async () => {
    seedBootstrap();
    const forged = replaceDistributionSignature(presignedDistributionBytes());
    const seams = harness({ distribution: { kind: "available", bytes: forged } });
    await expect(
      resolveOperationalAdminCatalogV1({
        adminRoot,
        env: { PATH: toolchain },
        fetchHttps: seams.fetchHttps,
        now: WALL_CLOCK,
        platformAdminRoot,
        posture: "vibe",
        run: async (argv) => {
          const stagedArtifact = readFileSync(argv[3] ?? "");
          return stagedArtifact.compare(forged) === 0
            ? { code: 1, stdout: "", stderr: "" }
            : { code: 0, stdout: "", stderr: "" };
        },
        tempRoot,
      }),
    ).rejects.toThrow();
  });

  it("treats a missing or mismatched distribution attestation bundle as fatal before catalog fallback", async () => {
    seedBootstrap();
    await expect(
      resolveWith({ distributionAttestation: { kind: "unavailable" } }).result,
    ).rejects.toThrow();
    await expect(
      resolveWith({ distributionAttestation: { kind: "available", bytes: attestationBytes } })
        .result,
    ).rejects.toThrow();
  });

  it("rejects a forged inner catalog-head signature even when a gh artifact attestation accepts the recomputed artifact", async () => {
    seedBootstrap();
    await expect(
      resolveWith(
        {
          artifact: { kind: "available", bytes: replaceCatalogHeadSignature(artifactBytes()) },
        },
        {
          // Model an outer provenance verifier accepting the replacement artifact:
          // CatalogHead trust must still bind its exact DSSE signatures to the
          // bootstrap-carried state rather than dynamically allowlisting them.
          run: async (): Promise<RunResult> => ({ code: 0, stdout: "", stderr: "" }),
        },
      ).result,
    ).rejects.toThrow();
  });

  it("binds the pre-signed material to the bootstrap admin identity, roots, and catalog pin", async () => {
    seedBootstrap({ expectedAdminSignerIdentity: "signer:someone-else" });
    await expect(resolveWith().result).rejects.toThrow();
    seedBootstrap({ expectedCatalogSha256: headRoot });
    await expect(resolveWith().result).rejects.toThrow();
  });

  it("rejects cache corruption, substitution, replay, and symlinked slots without downgrading", async () => {
    const root = seedBootstrap();
    const cachedTier = {
      artifact: { kind: "unavailable" as const },
      distribution: {
        kind: "available" as const,
        bytes: presignedDistributionBytes({ tier: "cached-verified" }),
      },
    };
    for (const bytes of [
      Buffer.from("{}", "utf8"),
      Buffer.concat([cacheRecordBytes(), Buffer.from([0x20])]),
      cacheRecordBytes({ downloadedAt: "2026-08-17T23:00:00Z" }),
      cacheRecordBytes({ authorityCacheKeySha256: headRoot }),
    ]) {
      seedCache(root, bytes);
      await expect(
        resolveWith(cachedTier).result,
        bytes.subarray(0, 24).toString("utf8"),
      ).rejects.toThrow();
    }

    rmSync(cacheSlot(root), { force: true });
    const outside = join(workspace, "outside-cache.json");
    writeFileSync(outside, cacheRecordBytes());
    try {
      symlinkSync(outside, cacheSlot(root));
    } catch {
      return; // unprivileged Windows sessions cannot symlink
    }
    // A symlinked slot is not read; resolution degrades to packaged, never to the link target.
    const packaged = await resolveWith({
      artifact: { kind: "unavailable" },
      distribution: { kind: "available", bytes: presignedDistributionBytes({ tier: "packaged" }) },
    }).result;
    expect(packaged.tier).toBe("packaged");
  });

  it("bounds staleness against the wall clock and refuses future-dated resolved material", async () => {
    seedBootstrap({ cacheMaxAgeSeconds: 60 });
    await expect(resolveWith({}, { now: "2026-08-18T12:00:00Z" }).result).rejects.toThrow();
    await expect(resolveWith({}, { now: "2026-08-17T11:00:00Z" }).result).rejects.toThrow();
    const { seams, result } = resolveWith({}, { now: "2026-02-31T12:00:00Z" });
    await expect(result).rejects.toThrow(/clock/);
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
  });

  it("uses the wall clock for head validity and workbench age while reproducing the pre-signed binding instant", async () => {
    seedBootstrap();
    const nearExpiry = await resolveWith({}, { now: "2026-08-17T23:59:59Z" }).result;
    expect(nearExpiry.ageSeconds).toBe(0);
    await expect(resolveWith({}, { now: "2026-08-18T11:59:59Z" }).result).rejects.toThrow();
  });

  it("requires the enterprise OS-managed bootstrap and never reads the target repository copy", async () => {
    seedBootstrap({}, "vibe");
    await expect(resolveWith({}, { posture: "enterprise" }).result).rejects.toThrow(/enterprise/i);
    seedBootstrap({}, "enterprise");
    const provenance = await resolveWith({}, { posture: "enterprise" }).result;
    expect(provenance.bootstrapProvenance).toBe("os-admin-managed");
    expect(provenance.posture).toBe("enterprise");
  });

  it("excludes a gh executable under the posture-resolved enterprise authority root", async () => {
    seedBootstrap({}, "enterprise");
    const nestedGh = join(platformAdminRoot, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(nestedGh, "test gh");
    if (process.platform !== "win32") chmodSync(nestedGh, 0o700);
    const { seams, result } = resolveWith(
      {},
      { env: { PATH: platformAdminRoot }, posture: "enterprise" },
    );
    await expect(result).rejects.toThrow(/GitHub attestation verifier/);
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
  });

  it("continues excluding a gh executable anywhere under the vibe admin root", async () => {
    seedBootstrap();
    const nestedToolchain = join(adminRoot, "toolchain");
    mkdirSync(nestedToolchain, { recursive: true });
    const nestedGh = join(nestedToolchain, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(nestedGh, "test gh");
    if (process.platform !== "win32") chmodSync(nestedGh, 0o700);
    const { seams, result } = resolveWith({}, { env: { PATH: nestedToolchain } });
    await expect(result).rejects.toThrow(/GitHub attestation verifier/);
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
  });

  it("rejects an acquired artifact whose identity does not match the pinned bootstrap facts", async () => {
    seedBootstrap();
    await expect(
      resolveWith({ artifact: { kind: "available", bytes: artifactBytes({ channel: "beta" }) } })
        .result,
    ).rejects.toThrow();
  });

  it("does not resolve, fetch, spawn, or write when the canonical bootstrap is absent", async () => {
    const { seams, result } = resolveWith();
    await expect(result).rejects.toThrow();
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
    expect(existsSync(join(vibeAdminCatalogRootV1(adminRoot), "cache"))).toBe(false);
  });

  it("does not fall back to the ambient PATH when an explicit empty environment is supplied", async () => {
    seedBootstrap();
    const { seams, result } = resolveWith({}, { env: {} });
    await expect(result).rejects.toThrow(/GitHub attestation verifier/);
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
  });

  it("bounds the attestation subprocess by time and captured output", async () => {
    seedBootstrap();
    const recorded: { argv: string[]; opts?: Record<string, unknown> }[] = [];
    await resolveOperationalAdminCatalogV1({
      adminRoot,
      env: { PATH: toolchain },
      fetchHttps: harness().fetchHttps,
      now: WALL_CLOCK,
      platformAdminRoot,
      posture: "vibe",
      run: async (argv, opts) => {
        recorded.push({ argv, opts: opts as Record<string, unknown> });
        return { code: 0, stdout: "", stderr: "" };
      },
      tempRoot,
    });
    expect(recorded).toHaveLength(2);
    for (const call of recorded) {
      expect(call.opts?.timeoutMs).toBe(30_000);
      expect(call.opts?.maxBufferBytes).toBe(256 * 1024);
    }
  });

  it("uses an absolute gh binary outside the admin root and pins every available GitHub attestation identity fact", async () => {
    seedBootstrap();
    const toolchain = join(workspace, "toolchain");
    mkdirSync(toolchain, { recursive: true });
    const gh = join(toolchain, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(gh, "test gh");
    if (process.platform !== "win32") chmodSync(gh, 0o700);
    const recorded: string[][] = [];
    await resolveWith(
      {},
      {
        env: { PATH: toolchain },
        run: async (argv: string[]): Promise<RunResult> => {
          recorded.push(argv);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    ).result;
    expect(recorded).toHaveLength(2);
    expect(recorded.map((argv) => argv[argv.indexOf("--signer-workflow") + 1]).sort()).toEqual(
      [adminWorkflowIdentity, workflowIdentity].sort(),
    );
    for (const argv of recorded) {
      expect(isAbsolute(argv[0] ?? "")).toBe(true);
      expect(argv[0]).toContain("toolchain");
      expect(argv).toContain("--repo");
      expect(argv).toContain("aih/supported-catalog");
      expect(argv).toContain("--signer-workflow");
      expect(argv).toContain("--bundle");
      expect(argv).toContain("--cert-oidc-issuer");
      expect(argv).toContain("https://token.actions.githubusercontent.com");
      expect(argv).toContain("--source-ref");
      expect(argv).toContain("refs/heads/main");
      expect(argv).toContain("--predicate-type");
      expect(argv).toContain("https://slsa.dev/provenance/v1");
    }
  });

  it("refuses a symlinked catalog root before a fresh verified cache commit can escape it", async () => {
    const root = seedBootstrap();
    const outside = join(workspace, "outside-catalog-root");
    renameSync(root, outside);
    try {
      symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // unprivileged Windows sessions cannot create directory links
    }
    const { seams, result } = resolveWith();
    await expect(result).rejects.toThrow();
    expect(seams.recorded.urls).toHaveLength(0);
    expect(seams.recorded.argv).toHaveLength(0);
    expect(existsSync(join(outside, "cache"))).toBe(false);
  });

  it("refuses a symlinked cache parent before a fresh verified cache commit can escape it", async () => {
    const root = seedBootstrap();
    const outside = join(workspace, "outside-cache-parent");
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, join(root, "cache"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // unprivileged Windows sessions cannot create directory links
    }
    await expect(resolveWith().result).rejects.toThrow();
    expect(existsSync(join(outside, "cache"))).toBe(false);
  });

  it("fails the default acquisition adapter closed for unparseable and non-HTTPS locators", async () => {
    for (const url of ["not a url", "http://catalog.aih.dev/a.json", "file:///etc/passwd"]) {
      expect(
        await defaultAdminCatalogHttpsFetchV1({ maxBytes: 64, timeoutMs: 10, url }),
        url,
      ).toEqual({ kind: "unavailable" });
    }
  });

  it("collects only a bounded 200 body and refuses every other acquisition outcome", async () => {
    const listeners = new Map<string, ((chunk: Buffer) => void)[]>();
    const events: string[] = [];
    const response = {
      on(event: string, listener: (chunk: Buffer) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      resume() {
        events.push("resume");
        return this;
      },
      statusCode: 200 as number | undefined,
    };
    const emit = (event: string, chunk = Buffer.alloc(0)) => {
      for (const listener of listeners.get(event) ?? []) listener(chunk);
    };

    const ok = collectBoundedAdminCatalogResponseV1(response, 8, () => events.push("abort"));
    emit("data", Buffer.from("abcd", "utf8"));
    emit("data", Buffer.from("efgh", "utf8"));
    emit("end");
    expect(await ok).toEqual({ kind: "available", bytes: Buffer.from("abcdefgh", "utf8") });

    listeners.clear();
    const oversize = collectBoundedAdminCatalogResponseV1(response, 4, () => events.push("abort"));
    emit("data", Buffer.from("abcde", "utf8"));
    emit("end");
    expect(await oversize).toEqual({ kind: "unavailable" });
    expect(events).toContain("abort");

    listeners.clear();
    const empty = collectBoundedAdminCatalogResponseV1(response, 8, () => undefined);
    emit("end");
    expect(await empty).toEqual({ kind: "unavailable" });

    listeners.clear();
    const broken = collectBoundedAdminCatalogResponseV1(response, 8, () => undefined);
    emit("data", Buffer.from("ab", "utf8"));
    emit("error");
    expect(await broken).toEqual({ kind: "unavailable" });

    listeners.clear();
    response.statusCode = 404;
    expect(await collectBoundedAdminCatalogResponseV1(response, 8, () => undefined)).toEqual({
      kind: "unavailable",
    });
    expect(events).toContain("resume");
  });

  it("keeps the operational route out of every developer-seat and public surface", () => {
    const source = readFileSync("src/org-policy/admin-catalog-operations-v1.ts", "utf8");
    // The admin route may reach the network; it must never reach seat runtime,
    // provider, scanner, or target-repository mutation surfaces.
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:\/runtime|\/seat|trust\/scan|capability\/index|workspace\/|guardrails\/)[^"']*["']/,
    );
    expect(readFileSync("src/index.ts", "utf8")).not.toContain("admin-catalog");
    expect(bootstrapRecord().protocol).toBe("AdminCatalogBootstrapV1");
  });
});
