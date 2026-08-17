import { z } from "zod";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256 digest");
const observation = z
  .object({
    detectorId: z.string().regex(/^detector\.[a-z0-9][a-z0-9.-]*$/),
    observationKeySha256: sha256,
    observationSetSha256: sha256,
  })
  .strict();
const cleanup = z.object({ outcome: z.enum(["completed", "failed"]) }).strict();
const brokerEnforcement = z
  .object({
    protocol: z.literal("BrokerEnforcementBindingV1"),
    brokerIdentity: z.string().regex(/^broker\.[0-9a-f]{12}$/),
    policyDigestSha256: sha256,
    appliedFactsSha256: sha256,
    enforcementState: z.literal("unverified"),
  })
  .strict();
const annexDescriptor = z
  .object({
    descriptorId: z.string().regex(/^annex\.[a-z0-9][a-z0-9.-]*$/),
    mediaType: z.enum(["application/json", "application/spdx+json"]),
    sha256,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    uri: z.string(),
  })
  .strict();
const inputSchema = z
  .object({
    protocol: z.literal("ScanAttestationV1"),
    sourceTarget: z.object({ name: z.literal("source-tree"), sha256 }).strict(),
    scannerManifestSha256: sha256,
    observations: z.array(observation).min(1).max(128),
    brokerEnforcement,
    cleanup,
    annexDescriptors: z.array(annexDescriptor).max(128),
  })
  .strict();

const subject = z
  .object({ name: z.literal("source-tree"), digest: z.object({ sha256 }).strict() })
  .strict();
const predicate = z
  .object({
    protocol: z.literal("ScanAttestationV1"),
    scannerManifestSha256: sha256,
    observations: z.array(observation).min(1).max(128),
    brokerEnforcement,
    cleanup,
    annexDescriptors: z.array(annexDescriptor).max(128),
  })
  .strict();
const statement = z
  .object({
    _type: z.literal("https://in-toto.io/Statement/v1"),
    subject: z.array(subject).length(1),
    predicateType: z.literal("https://aih.dev/ScanAttestationV1"),
    predicate,
  })
  .strict();
const envelope = z
  .object({
    payloadType: z.literal("application/vnd.in-toto+json"),
    payload: z.string(),
    signatures: z.array(z.never()).length(0),
  })
  .strict();
const outputSchema = z
  .object({
    protocol: z.literal("ScanAttestationV1"),
    validationState: z.literal("cryptographically-unverified"),
    statement,
    envelope,
    scanAttestationSha256: sha256,
  })
  .strict();

export interface ScanAttestationV1 extends Readonly<z.infer<typeof outputSchema>> {}

const attestations = new WeakMap<object, Buffer>();

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`duplicate or ambiguous ${label}: ${value}`);
    seen.add(value);
  }
}

function sortObservations(
  values: readonly z.infer<typeof observation>[],
): z.infer<typeof observation>[] {
  assertUnique(
    values.map((value) => value.detectorId),
    "detector ID",
  );
  return [...values].sort((left, right) => codeUnitCompare(left.detectorId, right.detectorId));
}

function sortAnnex(
  values: readonly z.infer<typeof annexDescriptor>[],
): z.infer<typeof annexDescriptor>[] {
  for (const descriptor of values) assertSafeRelativePosixPathV1(descriptor.uri, "annex URI");
  assertUnique(
    values.map((value) => value.descriptorId),
    "annex descriptor ID",
  );
  return [...values].sort((left, right) => codeUnitCompare(left.descriptorId, right.descriptorId));
}

export function canonicalScanAttestationStatementBytesV1(
  value: ScanAttestationV1["statement"],
): Buffer {
  assertStrictJsonValueV1(value, "scan attestation statement");
  return canonicalStrictJsonBytesV1(value);
}

function create(parsed: z.infer<typeof inputSchema>): ScanAttestationV1 {
  const observations = sortObservations(parsed.observations);
  const annexDescriptors = sortAnnex(parsed.annexDescriptors);
  const statementValue = {
    _type: "https://in-toto.io/Statement/v1" as const,
    subject: [{ name: parsed.sourceTarget.name, digest: { sha256: parsed.sourceTarget.sha256 } }],
    predicateType: "https://aih.dev/ScanAttestationV1" as const,
    predicate: {
      protocol: parsed.protocol,
      scannerManifestSha256: parsed.scannerManifestSha256,
      observations,
      brokerEnforcement: parsed.brokerEnforcement,
      cleanup: parsed.cleanup,
      annexDescriptors,
    },
  };
  const statementParsed = statement.parse(statementValue);
  const envelopeValue = {
    payloadType: "application/vnd.in-toto+json" as const,
    payload: canonicalScanAttestationStatementBytesV1(statementParsed).toString("base64"),
    signatures: [],
  };
  const envelopeParsed = envelope.parse(envelopeValue);
  const result = deepFreezeStrictJsonV1({
    protocol: parsed.protocol,
    validationState: "cryptographically-unverified" as const,
    statement: statementParsed,
    envelope: envelopeParsed,
    scanAttestationSha256: canonicalStrictJsonSha256V1({
      domain: "aih.scan-attestation-v1",
      statement: statementParsed,
      envelope: envelopeParsed,
    }),
  });
  attestations.set(result, canonicalStrictJsonBytesV1(result));
  return result;
}

export function createScanAttestationV1(input: unknown): ScanAttestationV1 {
  assertStrictJsonValueV1(input, "scan attestation");
  return create(inputSchema.parse(structuredClone(input)));
}

export function parseScanAttestationV1Json(text: string): ScanAttestationV1 {
  const value = parseStrictJsonObjectV1(text, "scan attestation");
  const parsed = outputSchema.parse(value);
  const payloadBytes = Buffer.from(parsed.envelope.payload, "base64");
  if (payloadBytes.toString("base64") !== parsed.envelope.payload) {
    throw new TypeError("scan attestation payload must be canonical standard base64");
  }
  const subjectValue = parsed.statement.subject[0];
  if (subjectValue === undefined) throw new TypeError("scan attestation requires one subject");
  const expected = create({
    protocol: parsed.protocol,
    sourceTarget: {
      name: subjectValue.name,
      sha256: subjectValue.digest.sha256,
    },
    scannerManifestSha256: parsed.statement.predicate.scannerManifestSha256,
    observations: parsed.statement.predicate.observations,
    brokerEnforcement: parsed.statement.predicate.brokerEnforcement,
    cleanup: parsed.statement.predicate.cleanup,
    annexDescriptors: parsed.statement.predicate.annexDescriptors,
  });
  if (
    JSON.stringify(parsed.statement) !== JSON.stringify(expected.statement) ||
    parsed.envelope.payload !== expected.envelope.payload ||
    parsed.envelope.payloadType !== expected.envelope.payloadType ||
    parsed.envelope.signatures.length !== 0 ||
    parsed.scanAttestationSha256 !== expected.scanAttestationSha256
  ) {
    throw new TypeError("scan attestation statement and DSSE payload mismatch");
  }
  return expected;
}

export function canonicalScanAttestationBytesV1(value: ScanAttestationV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? attestations.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("scan attestation canonical bytes require a validated branded attestation");
  return Buffer.from(bytes);
}

export function canonicalScanAttestationSha256V1(value: ScanAttestationV1): string {
  return canonicalStrictJsonSha256V1(
    JSON.parse(canonicalScanAttestationBytesV1(value).toString("utf8")),
  );
}
