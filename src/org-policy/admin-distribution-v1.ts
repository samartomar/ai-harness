import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import {
  type AdminSeatDistributionV1,
  createAdminSeatDistributionV1,
  createResolvedCatalogBindingV1,
  verifyAdminSeatDistributionV1,
} from "./catalog-binding-v1.js";
import {
  bindingInputFromVerifiedCatalogMaterialV1,
  resolveVerifiedCatalogMaterialV1,
} from "./catalog-resolution-v1.js";

type Json = Record<string, unknown>;

const FIELDS = [
  "adminSignerRootSha256",
  "cachedVerified",
  "expectedAdminSignerIdentity",
  "expectedCatalogSha256",
  "expectedCatalogSignerIdentity",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedPackageRootSha256",
  "expectedPackageSha256",
  "expectedPromotionDecisionSha256",
  "expectedRef",
  "expectedRepository",
  "expectedWorkflowIdentity",
  "fresh",
  "headSignerRootSha256",
  "lastGood",
  "now",
  "packaged",
  "signCanonicalPae",
  "verifyCatalogHeadPae",
  "verifyCanonicalPae",
] as const;

function fail(label: string): never {
  throw new TypeError(`invalid AdminSeatDistributionV1: ${label}`);
}

function record(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(label);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail(label);
  }
  return value as Json;
}

function exact(value: Json, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((field, index) => field !== required[index]))
    fail("fields");
}

function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.length)} `,
      "utf8",
    ),
    payload,
  ]);
}

function resolutionInput(value: Json): Json {
  const {
    expectedAdminSignerIdentity: _expectedAdminSignerIdentity,
    signCanonicalPae: _signCanonicalPae,
    verifyCatalogHeadPae,
    verifyCanonicalPae: _verifyCanonicalPae,
    ...input
  } = value;
  if (typeof verifyCatalogHeadPae !== "function") fail("catalog head verifier");
  const verified = new Set<string>();
  return {
    ...input,
    verifyCanonicalPae: (request: { paeBytes: Buffer; signatures: unknown }) => {
      const key = `${request.paeBytes.toString("base64")}:${JSON.stringify(request.signatures)}`;
      if (verified.has(key)) return true;
      if (verifyCatalogHeadPae(request) !== true) return false;
      verified.add(key);
      return true;
    },
  };
}

export function composeAdminSeatDistributionV1(input: unknown): AdminSeatDistributionV1 {
  const value = record(input, "admin seat composition");
  exact(value, FIELDS);
  const signerIdentity = value.expectedAdminSignerIdentity;
  if (
    typeof signerIdentity !== "string" ||
    signerIdentity.length === 0 ||
    signerIdentity.length > 256
  )
    fail("admin signer identity");
  const material = resolveVerifiedCatalogMaterialV1(resolutionInput(value));
  const binding = createResolvedCatalogBindingV1(
    bindingInputFromVerifiedCatalogMaterialV1(material, {
      adminSignerRootSha256: value.adminSignerRootSha256 as string,
      headSignerRootSha256: value.headSignerRootSha256 as string,
      resolvedAt: value.now as string,
    }),
  );
  const payloadType = "application/vnd.in-toto+json";
  const sign = value.signCanonicalPae;
  if (typeof sign !== "function") fail("signer");
  const payload = canonicalStrictJsonBytesV1({
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      protocol: "AdminSeatDistributionV1",
      recordType: "ResolvedCatalogBindingV1",
      signerIdentity,
    },
    predicateType: "https://aih.dev/AdminSeatDistributionV1",
    subject: [
      {
        digest: { sha256: binding.resolvedCatalogBindingSha256 },
        name: "aih/ResolvedCatalogBindingV1",
      },
    ],
  });
  const signed = sign({
    bindingSha256: binding.resolvedCatalogBindingSha256,
    expectedAdminSignerIdentity: signerIdentity,
    expectedAdminSignerRootSha256: value.adminSignerRootSha256,
    paeBytes: pae(payloadType, payload),
    protocol: "AdminSeatDistributionV1",
  });
  const distribution = createAdminSeatDistributionV1({
    binding,
    signerIdentity,
    signatures: [signed],
  });
  const verify = value.verifyCanonicalPae;
  if (typeof verify !== "function") fail("verifier");
  verifyAdminSeatDistributionV1({
    distribution,
    expectedAdminSignerIdentity: signerIdentity,
    expectedAdminSignerRootSha256: value.adminSignerRootSha256,
    expectedHeadSignerRootSha256: value.headSignerRootSha256,
    verifyCanonicalPae: verify,
  });
  return distribution;
}
