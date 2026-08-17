import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import {
  canonicalScanAttestationBytesV1,
  canonicalScanAttestationSha256V1,
  canonicalScanAttestationStatementBytesV1,
  createScanAttestationV1,
  parseScanAttestationV1Json,
} from "../../src/observation/scan-attestation-v1.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attestationInput() {
  return {
    protocol: "ScanAttestationV1" as const,
    sourceTarget: { name: "source-tree", sha256: sha256("source tree") },
    scannerManifestSha256: sha256("scanner manifest"),
    observations: [
      {
        detectorId: "detector.dependency-audit",
        observationKeySha256: sha256("dependency key"),
        observationSetSha256: sha256("dependency set"),
      },
      {
        detectorId: "detector.secret-audit",
        observationKeySha256: sha256("secret key"),
        observationSetSha256: sha256("secret set"),
      },
    ],
    brokerEnforcement: {
      protocol: "BrokerEnforcementBindingV1" as const,
      brokerIdentity: "broker.0123456789ab",
      policyDigestSha256: sha256("broker policy"),
      appliedFactsSha256: sha256("broker applied facts"),
      enforcementState: "unverified" as const,
    },
    cleanup: { outcome: "completed" as const },
    annexDescriptors: [
      {
        descriptorId: "annex.native-log",
        mediaType: "application/json",
        sha256: sha256("native log"),
        byteLength: 128,
        uri: "annex/native-log.json",
      },
    ],
  };
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object test fixture");
  }
  return value as Record<string, unknown>;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sourceFiles(rel = "src"): string[] {
  const absolute = join(repoRoot(), ...rel.split("/"));
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (entry.isFile() && child.endsWith(".ts")) files.push(child);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function moduleSpecifiers(rel: string): string[] {
  const scan = tokenizer(readFileSync(join(repoRoot(), ...rel.split("/")), "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const tokens: Array<{ label: string; value: unknown }> = [];
  for (;;) {
    const token = scan.getToken();
    tokens.push({ label: token.type.label, value: (token as { value?: unknown }).value });
    if (token.type.label === "eof") break;
  }
  const literal = (index: number) => {
    const token = tokens[index];
    return token?.label === "string" && typeof token.value === "string" ? token.value : undefined;
  };
  const from = (start: number) => {
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || token.label === ";" || token.label === "eof") return undefined;
      if (token.label === "name" && token.value === "from") return literal(index + 1);
    }
    return undefined;
  };
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.label === "import") {
      for (const value of [
        literal(index + 1),
        tokens[index + 1]?.label === "(" ? literal(index + 2) : undefined,
        from(index + 1),
      ])
        if (value !== undefined) result.push(value);
    }
    if (token?.label === "export") {
      const value = from(index + 1);
      if (value !== undefined) result.push(value);
    }
    if (token?.label === "name" && token.value === "require" && tokens[index + 1]?.label === "(") {
      const value = literal(index + 2);
      if (value !== undefined) result.push(value);
    }
  }
  return result;
}

describe("ScanAttestationV1", () => {
  it("emits a deterministic closed DSSE/in-toto-shaped envelope and explicitly brands it cryptographically unverified", () => {
    const input = attestationInput();
    const forward = createScanAttestationV1(input);
    const reverse = createScanAttestationV1({
      ...input,
      observations: [...input.observations].reverse(),
    });
    const row = forward.statement.predicate.observations[0];
    const annex = forward.statement.predicate.annexDescriptors[0];
    if (row === undefined || annex === undefined)
      throw new Error("expected attestation descriptors");

    expectExactKeys(forward, [
      "protocol",
      "validationState",
      "statement",
      "envelope",
      "scanAttestationSha256",
    ]);
    expectExactKeys(forward.envelope, ["payloadType", "payload", "signatures"]);
    expectExactKeys(forward.statement, ["_type", "subject", "predicateType", "predicate"]);
    expectExactKeys(forward.statement.subject[0] as object, ["name", "digest"]);
    expectExactKeys((forward.statement.subject[0] as { digest: object }).digest, ["sha256"]);
    expectExactKeys(forward.statement.predicate, [
      "protocol",
      "scannerManifestSha256",
      "observations",
      "brokerEnforcement",
      "cleanup",
      "annexDescriptors",
    ]);
    expectExactKeys(row, ["detectorId", "observationKeySha256", "observationSetSha256"]);
    expectExactKeys(annex, ["descriptorId", "mediaType", "sha256", "byteLength", "uri"]);
    expectExactKeys(forward.statement.predicate.cleanup, ["outcome"]);
    expectExactKeys(forward.statement.predicate.brokerEnforcement, [
      "protocol",
      "brokerIdentity",
      "policyDigestSha256",
      "appliedFactsSha256",
      "enforcementState",
    ]);
    expect(forward.validationState).toBe("cryptographically-unverified");
    expect(forward.envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(forward.envelope.signatures).toEqual([]);
    expect(Buffer.from(forward.envelope.payload, "base64")).toEqual(
      canonicalScanAttestationStatementBytesV1(forward.statement),
    );
    expect(JSON.parse(Buffer.from(forward.envelope.payload, "base64").toString("utf8"))).toEqual(
      forward.statement,
    );
    expect(forward.statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(forward.statement.predicateType).toBe("https://aih.dev/ScanAttestationV1");
    expect(forward.scanAttestationSha256).toBe(reverse.scanAttestationSha256);
    expect(forward.statement.predicate.observations.map((entry) => entry.detectorId)).toEqual([
      "detector.dependency-audit",
      "detector.secret-audit",
    ]);
    const serialized = JSON.stringify(forward).toLowerCase();
    for (const forbidden of [
      "signer",
      "trusted",
      "portable",
      "pass",
      "policy",
      "verdict",
      "waiver",
      "acknowledgement",
      "timestamp",
      "runid",
      "message",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.statement)).toBe(true);
    expect(Object.isFrozen(forward.envelope)).toBe(true);
    expect(() => {
      (forward.statement.predicate.cleanup as { outcome: string }).outcome = "forged";
    }).toThrow();
  });

  it("rejects a DSSE payload that is arbitrary, noncanonical, mismatched, or typed for another statement", () => {
    const current = createScanAttestationV1(attestationInput());
    const parse = (value: unknown) => parseScanAttestationV1Json(JSON.stringify(value));
    const arbitrary = structuredClone(current);
    arbitrary.envelope.payload = Buffer.from('{"arbitrary":true}', "utf8").toString("base64");
    expect(() => parse(arbitrary)).toThrow(/payload|statement|DSSE|canonical/i);

    const different = structuredClone(current);
    different.envelope.payload = Buffer.from(
      JSON.stringify({
        ...current.statement,
        predicate: {
          ...current.statement.predicate,
          brokerEnforcement: {
            ...current.statement.predicate.brokerEnforcement,
            brokerIdentity: "broker.fedcba987654",
          },
        },
      }),
      "utf8",
    ).toString("base64");
    expect(() => parse(different)).toThrow(/payload|statement|canonical|mismatch/i);

    const noncanonical = structuredClone(current);
    noncanonical.envelope.payload = `${current.envelope.payload}=`;
    expect(() => parse(noncanonical)).toThrow(/base64|payload|canonical/i);

    const wrongType = structuredClone(current) as unknown as {
      envelope: { payloadType: string };
    };
    wrongType.envelope.payloadType = "application/json";
    expect(() => parse(wrongType)).toThrow(/payloadType|DSSE|in-toto/i);

    const mutatedStatement = structuredClone(current);
    mutatedStatement.statement.predicate.cleanup.outcome = "failed";
    expect(() => parse(mutatedStatement)).toThrow(/payload|statement|canonical|mismatch/i);
  });

  it("binds source target, manifest, detector keys/sets, broker cleanup, and annex descriptors in JCS bytes", () => {
    const input = attestationInput();
    const base = createScanAttestationV1(input);
    const changed = [
      createScanAttestationV1({
        ...input,
        sourceTarget: { ...input.sourceTarget, sha256: sha256("other source") },
      }),
      createScanAttestationV1({ ...input, scannerManifestSha256: sha256("other manifest") }),
      createScanAttestationV1({
        ...input,
        observations: [
          { ...input.observations[0], observationKeySha256: sha256("other key") },
          input.observations[1],
        ],
      }),
      createScanAttestationV1({
        ...input,
        observations: [
          { ...input.observations[0], observationSetSha256: sha256("other set") },
          input.observations[1],
        ],
      }),
      createScanAttestationV1({
        ...input,
        brokerEnforcement: { ...input.brokerEnforcement, brokerIdentity: "broker.fedcba987654" },
      }),
      createScanAttestationV1({
        ...input,
        brokerEnforcement: {
          ...input.brokerEnforcement,
          policyDigestSha256: sha256("other broker policy"),
        },
      }),
      createScanAttestationV1({
        ...input,
        brokerEnforcement: {
          ...input.brokerEnforcement,
          appliedFactsSha256: sha256("other broker facts"),
        },
      }),
      createScanAttestationV1({
        ...input,
        brokerEnforcement: { ...input.brokerEnforcement, enforcementState: "verified" },
      }),
      createScanAttestationV1({ ...input, cleanup: { outcome: "failed" } }),
      createScanAttestationV1({
        ...input,
        annexDescriptors: [{ ...input.annexDescriptors[0], sha256: sha256("other annex") }],
      }),
    ];
    for (const value of changed)
      expect(value.scanAttestationSha256).not.toBe(base.scanAttestationSha256);
    const bytes = canonicalScanAttestationBytesV1(base);
    expect(bytes.toString("utf8")).toContain('"protocol":"ScanAttestationV1"');
    expect(canonicalScanAttestationSha256V1(base)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(() => canonicalScanAttestationBytesV1(structuredClone(base) as never)).toThrow(
      /validated|branded|forged/i,
    );
  });

  it("rejects mismatches, ambiguous detector rows, forbidden authority fields, hostile locations, and malformed JSON", () => {
    const input = attestationInput();
    expect(() =>
      createScanAttestationV1({
        ...input,
        observations: [input.observations[0], input.observations[0]],
      }),
    ).toThrow(/duplicate|ambiguous/i);
    expect(() =>
      createScanAttestationV1({
        ...input,
        observations: [
          input.observations[0],
          { ...input.observations[0], observationKeySha256: sha256("conflicting key") },
        ],
      }),
    ).toThrow(/duplicate|ambiguous|conflict/i);
    expect(() =>
      createScanAttestationV1({
        ...input,
        observations: [
          { ...input.observations[0], detectorId: "detector.*" },
          input.observations[1],
        ],
      }),
    ).toThrow(/detector|identity|wildcard/i);
    expect(() =>
      createScanAttestationV1({ ...input, scannerManifestSha256: "A".repeat(64) }),
    ).toThrow(/digest|sha256/i);
    for (const brokerEnforcement of [
      {},
      { ...input.brokerEnforcement, protocol: "BrokerEnforcementBindingV2" },
      { ...input.brokerEnforcement, brokerIdentity: "broker.generic" },
      { ...input.brokerEnforcement, policyDigestSha256: "bad" },
      { ...input.brokerEnforcement, appliedFactsSha256: "A".repeat(64) },
      { ...input.brokerEnforcement, enforcementState: "verified" },
      { ...input.brokerEnforcement, extra: true },
    ]) {
      expect(() => createScanAttestationV1({ ...input, brokerEnforcement })).toThrow(
        /broker|enforcement|digest|unknown|unexpected|unrecognized/i,
      );
    }
    expect(() =>
      createScanAttestationV1({
        ...input,
        sourceTarget: { name: "/absolute", sha256: input.sourceTarget.sha256 },
      }),
    ).toThrow(/path|subject|target/i);
    expect(() =>
      createScanAttestationV1({
        ...input,
        annexDescriptors: [{ ...input.annexDescriptors[0], uri: "https://host.invalid/evidence" }],
      }),
    ).toThrow(/uri|path|absolute/i);
    for (const field of [
      "payloadType",
      "predicateType",
      "subject",
      "brokerIdentity",
      "policy",
      "verdict",
      "waiver",
      "acknowledgement",
      "signer",
      "timestamp",
      "runId",
      "message",
    ]) {
      expect(() => createScanAttestationV1({ ...input, [field]: "forbidden" })).toThrow(
        /unknown|unexpected|unrecognized/i,
      );
    }
    expect(() =>
      parseScanAttestationV1Json('{"protocol":"ScanAttestationV1","protocol":"ScanAttestationV1"}'),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseScanAttestationV1Json('{"protocol":"ScanAttestationV1","x":"e\\u0300"}'),
    ).toThrow(/NFC|Unicode/i);

    const current = createScanAttestationV1(input);
    for (const mutate of [
      (value: Record<string, unknown>) => (record(value.envelope).extra = true),
      (value: Record<string, unknown>) => (record(value.statement).extra = true),
      (value: Record<string, unknown>) => {
        const statement = record(value.statement);
        record((statement.subject as unknown[])[0]).extra = true;
      },
      (value: Record<string, unknown>) => {
        const statement = record(value.statement);
        record(record((statement.subject as unknown[])[0]).digest).extra = true;
      },
      (value: Record<string, unknown>) => (record(record(value.statement).predicate).extra = true),
      (value: Record<string, unknown>) => {
        const predicate = record(record(value.statement).predicate);
        record((predicate.observations as unknown[])[0]).extra = true;
      },
      (value: Record<string, unknown>) => {
        const predicate = record(record(value.statement).predicate);
        record(predicate.cleanup).extra = true;
      },
      (value: Record<string, unknown>) => {
        const predicate = record(record(value.statement).predicate);
        record(predicate.brokerEnforcement).extra = true;
      },
      (value: Record<string, unknown>) => {
        const predicate = record(record(value.statement).predicate);
        record((predicate.annexDescriptors as unknown[])[0]).extra = true;
      },
      (value: Record<string, unknown>) =>
        (record(value.envelope).signatures as unknown[]).push({
          extra: true,
        }),
    ]) {
      const forged = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
      mutate(forged);
      expect(() => parseScanAttestationV1Json(JSON.stringify(forged))).toThrow(
        /unknown|unexpected|unrecognized|signature/i,
      );
    }
  });

  it("remains an internal unverified contract with no static runtime consumer or public export", () => {
    const owner = "src/observation/scan-attestation-v1.ts";
    for (const file of sourceFiles().filter((candidate) => candidate !== owner)) {
      expect(
        moduleSpecifiers(file).filter((specifier) => specifier.includes("scan-attestation-v1")),
      ).toEqual([]);
    }
    expect(
      moduleSpecifiers("src/index.ts").filter((specifier) =>
        specifier.includes("scan-attestation-v1"),
      ),
    ).toEqual([]);
    const packageJson = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(JSON.stringify(packageJson.exports)).not.toContain("observation/scan-attestation-v1");
  });
});
