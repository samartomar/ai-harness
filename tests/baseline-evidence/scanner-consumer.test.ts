import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BaselineVetBatchResultV1,
  type BaselineVetRequestV1,
  canonicalBaselineVetAttestationEnvelopeV1Bytes,
  ed25519KeyIdV2,
  parseBaselineVetAttestationEnvelopeV1Json,
  signBaselineVetBundleV1,
} from "@aihq/scan";
import { afterEach, describe, expect, it } from "vitest";
import { defineBaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import {
  consumeVerifiedScannerBaseline,
  consumeVerifiedScannerBaselineBatches,
  createCoreBaselineVetRequest,
  createCoreBaselineVetRequests,
  SCANNER_BASELINE_COMPONENT_BATCH_LIMIT,
} from "../../src/baseline-evidence/scanner-consumer.js";
import {
  SCANNER_BASELINE_ANALYZER_VERSIONS,
  SCANNER_TO_CORE_BASELINE_ANALYZER,
  type ScannerBaselineAnalyzer,
} from "../../src/baseline-evidence/scanner-profile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("fixture contains unsupported JSON");
  return `{${Object.keys(value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-core-scanner-consumer-"));
  roots.push(root);
  mkdirSync(join(root, "rules"), { recursive: true });
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "rules", "base.md"), "# Base rule\n", "utf8");
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
  const catalog = defineBaselineCatalog({
    id: "fixture",
    owner: "example",
    repo: "fixture",
    pinnedSha: "a".repeat(40),
    components: [
      { id: "rules", paths: ["rules"] },
      { id: "skill:demo", paths: ["skills/demo"], skillContent: true },
    ],
  });
  return { root, catalog };
}

function largeSourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-core-scanner-batches-"));
  roots.push(root);
  const components = Array.from(
    { length: SCANNER_BASELINE_COMPONENT_BATCH_LIMIT + 1 },
    (_, index) => {
      const id = `component-${String(index + 1).padStart(3, "0")}`;
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, "README.md"), `# ${id}\n`, "utf8");
      return { id, paths: [id] };
    },
  );
  const catalog = defineBaselineCatalog({
    id: "large-fixture",
    owner: "example",
    repo: "large-fixture",
    pinnedSha: "b".repeat(40),
    components,
  });
  return { root, catalog };
}

function buildResult(
  request: BaselineVetRequestV1,
  overrides: Partial<Record<ScannerBaselineAnalyzer, string>> = {},
): BaselineVetBatchResultV1 {
  const analyzers = [
    ...new Set(request.components.flatMap((component) => component.analyzers)),
  ] as ScannerBaselineAnalyzer[];
  const annexArtifacts = analyzers.map((analyzer) => {
    const bytes = Buffer.from(
      canonical(
        analyzer === "aih-native"
          ? {
              protocol: "BaselineNativeObservationV1",
              sourceTreeSha256: request.source.treeSha256,
              files: [],
            }
          : {
              version: "2.1.0",
              runs: [{ tool: { driver: { name: analyzer } }, results: [] }],
            },
      ),
      "utf8",
    );
    return { path: `annex/${analyzer}.json`, bytes };
  });
  const byAnalyzer = new Map(
    annexArtifacts.map((artifact) => [artifact.path.slice(6, -5), artifact]),
  );
  const observations = analyzers.map((analyzer) => {
    const artifact = byAnalyzer.get(analyzer);
    if (artifact === undefined) throw new Error(`fixture annex missing ${analyzer}`);
    const coreName = SCANNER_TO_CORE_BASELINE_ANALYZER[analyzer];
    return {
      analyzer,
      analyzerVersion: overrides[analyzer] ?? SCANNER_BASELINE_ANALYZER_VERSIONS[coreName],
      annex: {
        path: artifact.path,
        mediaType:
          analyzer === "aih-native"
            ? ("application/vnd.aih.baseline-native+json" as const)
            : ("application/sarif+json" as const),
        sha256: sha256(artifact.bytes),
        byteLength: artifact.bytes.byteLength,
      },
    };
  });
  const observationByAnalyzer = new Map(observations.map((item) => [item.analyzer, item]));
  const authoring = {
    protocol: "BaselineVetReceiptV1" as const,
    profile: request.profile,
    requestSha256: request.requestSha256,
    source: request.source,
    observations,
    components: request.components.map((component) => ({
      id: component.id,
      content: component.content,
      paths: component.paths,
      treeSha256: component.treeSha256,
      observations: component.analyzers.map((analyzer) => ({
        analyzer,
        annexSha256: observationByAnalyzer.get(analyzer)?.annex.sha256 ?? "",
      })),
    })),
  };
  return {
    receipt: {
      ...authoring,
      receiptSha256: sha256(
        canonical({ domain: "aih.baseline-vet-receipt-v1", receipt: authoring }),
      ),
    },
    annexArtifacts,
  } as BaselineVetBatchResultV1;
}

function signedFixture(request: BaselineVetRequestV1, result: BaselineVetBatchResultV1) {
  const keys = generateKeyPairSync("ed25519");
  const keyId = ed25519KeyIdV2(keys.publicKey);
  const signer = { identity: "fixture-scanner", class: "test-ephemeral" as const, keyId };
  const evidence = signBaselineVetBundleV1({
    request,
    result,
    signer: { ...signer, privateKey: keys.privateKey },
    claims: {
      signedAt: "2026-08-31T05:00:00.000Z",
      expiresAt: "2026-08-31T06:00:00.000Z",
    },
  });
  return {
    envelope: parseBaselineVetAttestationEnvelopeV1Json(
      canonicalBaselineVetAttestationEnvelopeV1Bytes(evidence).toString("utf8"),
    ),
    roots: [{ ...signer, publicKey: keys.publicKey }],
    expected: { now: "2026-08-31T05:30:00.000Z", signer },
    evidenceDigestSha256: evidence.evidenceDigestSha256,
  };
}

describe("Core Scanner baseline consumer", () => {
  it("batches more than 100 components and requires every signed batch", async () => {
    const { root, catalog } = largeSourceFixture();
    const requests = createCoreBaselineVetRequests(root, catalog);
    expect(requests.map((request) => request.components.length)).toEqual([100, 1]);
    expect(requests[0]?.source).toEqual(requests[1]?.source);
    expect(() => createCoreBaselineVetRequest(root, catalog)).toThrow(/requires 2 bounded/);

    const keys = generateKeyPairSync("ed25519");
    const keyId = ed25519KeyIdV2(keys.publicKey);
    const signer = { identity: "fixture-batch-scanner", class: "test-ephemeral" as const, keyId };
    const expected = { now: "2026-08-31T05:30:00.000Z", signer };
    const batches = requests.map((request) => {
      const result = buildResult(request);
      const signed = signBaselineVetBundleV1({
        request,
        result,
        signer: { ...signer, privateKey: keys.privateKey },
        claims: {
          signedAt: "2026-08-31T05:00:00.000Z",
          expiresAt: "2026-08-31T06:00:00.000Z",
        },
      });
      return {
        request,
        result,
        envelope: parseBaselineVetAttestationEnvelopeV1Json(
          canonicalBaselineVetAttestationEnvelopeV1Bytes(signed).toString("utf8"),
        ),
      };
    });

    await expect(
      consumeVerifiedScannerBaselineBatches({
        sourceRoot: root,
        catalog,
        batches: batches.slice(0, 1),
        roots: [{ ...signer, publicKey: keys.publicKey }],
        expected,
      }),
    ).rejects.toThrow(/batch count 1 does not match Core catalog 2/);

    const evidence = await consumeVerifiedScannerBaselineBatches({
      sourceRoot: root,
      catalog,
      batches,
      roots: [{ ...signer, publicKey: keys.publicKey }],
      expected,
    });
    expect(evidence.components).toHaveLength(SCANNER_BASELINE_COMPONENT_BATCH_LIMIT + 1);
  }, 15_000);

  it("authors the exact fixed Scanner profile and consumes signed annexes without executing analyzers", async () => {
    const { root, catalog } = sourceFixture();
    const request = createCoreBaselineVetRequest(root, catalog);
    expect(request.components.map((component) => component.analyzers)).toEqual([
      ["aih-native", "skillspector", "semgrep"],
      ["aih-native", "skillspector", "semgrep", "cisco"],
    ]);
    const result = buildResult(request);
    const signed = signedFixture(request, result);

    const evidence = await consumeVerifiedScannerBaseline({
      sourceRoot: root,
      catalog,
      request,
      result,
      envelope: signed.envelope,
      roots: signed.roots,
      expected: signed.expected,
    });

    expect(evidence.components.map((component) => component.verdict)).toEqual(["pass", "pass"]);
    expect(evidence.components[0]?.analyzers).toEqual([
      {
        name: "aih-native",
        version: SCANNER_BASELINE_ANALYZER_VERSIONS["aih-native"],
      },
      {
        name: "semgrep@uv:1.173.0",
        version: SCANNER_BASELINE_ANALYZER_VERSIONS["semgrep@uv:1.173.0"],
      },
      {
        name: "skillspector@docker",
        version: SCANNER_BASELINE_ANALYZER_VERSIONS["skillspector@docker"],
      },
    ]);
    expect(evidence.components[1]?.analyzers.map((entry) => entry.name)).toEqual([
      "aih-native",
      "cisco@uvx",
      "semgrep@uv:1.173.0",
      "skillspector@docker",
    ]);
  });

  it("rejects source drift, replay, and a signed but unpinned analyzer identity", async () => {
    const { root, catalog } = sourceFixture();
    const request = createCoreBaselineVetRequest(root, catalog);
    const result = buildResult(request);
    const signed = signedFixture(request, result);
    writeFileSync(join(root, "rules", "base.md"), "# Changed after request\n", "utf8");
    await expect(
      consumeVerifiedScannerBaseline({
        sourceRoot: root,
        catalog,
        request,
        result,
        envelope: signed.envelope,
        roots: signed.roots,
        expected: signed.expected,
      }),
    ).rejects.toThrow(/does not match Core catalog/);

    const fresh = sourceFixture();
    const freshRequest = createCoreBaselineVetRequest(fresh.root, fresh.catalog);
    const freshResult = buildResult(freshRequest);
    const freshSigned = signedFixture(freshRequest, freshResult);
    await expect(
      consumeVerifiedScannerBaseline({
        sourceRoot: fresh.root,
        catalog: fresh.catalog,
        request: freshRequest,
        result: freshResult,
        envelope: freshSigned.envelope,
        roots: freshSigned.roots,
        expected: freshSigned.expected,
        seenEvidenceDigests: [freshSigned.evidenceDigestSha256],
      }),
    ).rejects.toThrow(/replayed evidence/);

    const wrongResult = buildResult(freshRequest, { semgrep: "1.173.0+uvlock.wrong" });
    const wrongSigned = signedFixture(freshRequest, wrongResult);
    await expect(
      consumeVerifiedScannerBaseline({
        sourceRoot: fresh.root,
        catalog: fresh.catalog,
        request: freshRequest,
        result: wrongResult,
        envelope: wrongSigned.envelope,
        roots: wrongSigned.roots,
        expected: wrongSigned.expected,
      }),
    ).rejects.toThrow(/does not match pinned/);
  });
});
