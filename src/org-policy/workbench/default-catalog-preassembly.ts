import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  readVendorBaselineLock,
  vendorBaselineLockSha256,
} from "../../baseline-evidence/vendor.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../contract/strict-json-v1.js";
import { VERSION } from "../../version.js";
import { policyAuthoringCatalog } from "../catalog.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "./catalog-bundle.js";
import { compileBuiltInCatalogV1 } from "./compilers/built-in.js";
import { compilerFormatRegistrationsV1 } from "./compilers/formats.js";
import { packagedWorkbenchSourceDataInputV1 } from "./core/packaged-source-data-data.js";
import type { PreparedWorkbenchCatalogV1 } from "./prepared-catalog.js";
import { registeredCatalogProvidersV1 } from "./providers/registry.js";

const requireFromPreassembly = createRequire(import.meta.url);
const GENERATED_COMPANION = "./default-catalog-preassembly.generated.cjs";
const PREASSEMBLY_VERSION = "default-catalog-preassembly/v1";
const hex = /^[a-f0-9]{64}$/;
const qualifiedDigest = /^sha256:[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;
type PackageInput = Readonly<{ bytes: string; sha256: string }>;
type PreassemblyInput = Readonly<{ bytes: string; sha256: string }>;

type RuntimeAdmissionV1 = ReturnType<typeof defaultCatalogPreassemblyAdmissionV1>;
type ProviderAdmissionV1 = {
  providerId: string;
  providerVersion: string;
  inputDigest: string;
  compilerInputsDigest: string;
};
type PreassemblyPayloadV1 = {
  version: typeof PREASSEMBLY_VERSION;
  admission: RuntimeAdmissionV1 & { providerAdmissions: ProviderAdmissionV1[] };
  prepared: PreparedWorkbenchCatalogV1;
  output: {
    bundleDigest: string;
    preparedDigest: string;
    bindingsDigest: string;
    sourceInputsDigest: string;
  };
};

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function digest(value: unknown): string {
  return `sha256:${canonicalStrictJsonSha256V1(value)}`;
}

function object(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Default catalog preassembly ${label} is malformed`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[], label: string): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`Default catalog preassembly ${label} is malformed`);
}

/** Canonical equality rejects duplicate keys and alternate spellings after JSON.parse. */
function parseCanonicalObject(bytes: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError(`Default catalog preassembly ${label} is not JSON`);
  }
  const parsed = object(value, label);
  if (canonical(parsed) !== bytes)
    throw new TypeError(`Default catalog preassembly ${label} is not canonical`);
  return parsed;
}

function sealedPayload(value: PreassemblyPayloadV1): PreassemblyInput {
  const payloadBytes = canonical(value);
  const bytes = canonical({
    version: PREASSEMBLY_VERSION,
    bytes: payloadBytes,
    sha256: sha256(payloadBytes),
  });
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}

function inputSeals(input: readonly PackageInput[]) {
  return input.map(({ bytes, sha256: expected }) => {
    const actual = sha256(bytes);
    if (
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(expected) ||
      (expected !== actual && expected !== `sha256:${actual}`)
    )
      throw new TypeError("Default catalog preassembly package input seal mismatch");
    return { bytes: Buffer.byteLength(bytes, "utf8"), sha256: expected };
  });
}

function providerAdmissionsV1() {
  const catalog = policyAuthoringCatalog();
  const sources = readVendorBaselineLock().sources;
  return registeredCatalogProvidersV1.flatMap((provider) => {
    const compiled = provider.prepareBaseline?.(catalog, sources);
    return compiled === undefined
      ? []
      : [
          {
            providerId: compiled.providerId,
            providerVersion: compiled.providerVersion,
            inputDigest: compiled.inputDigest,
            compilerInputsDigest: digest(compiled.inputs),
          },
        ];
  });
}

/** Stable package inputs that the catalog preassembly validates at runtime. */
export function defaultCatalogPreassemblyAdmissionV1() {
  const catalog = policyAuthoringCatalog();
  return {
    coreVersion: VERSION,
    catalogDigest: digest(catalog),
    vendorLockDigest: `sha256:${vendorBaselineLockSha256()}`,
    providerRegistrations: registeredCatalogProvidersV1
      .filter((provider) => provider.prepareBaseline !== undefined)
      .map(({ providerId, providerVersion }) => ({ providerId, providerVersion })),
    compilerRegistrationsDigest: digest(compilerFormatRegistrationsV1),
    coreCapabilitiesDigest: digest(compileBuiltInCatalogV1(catalog).coreCapabilities),
    sourceRecordSeals: inputSeals(packagedWorkbenchSourceDataInputV1()),
  };
}

function validProviderAdmissions(value: unknown): value is ProviderAdmissionV1[] {
  if (!Array.isArray(value)) return false;
  const providerIds = new Set<string>();
  return value.every((admission) => {
    if (admission === null || typeof admission !== "object" || Array.isArray(admission))
      return false;
    const record = admission as JsonRecord;
    const providerId = record.providerId;
    if (typeof providerId !== "string") return false;
    const valid =
      Object.keys(record).length === 4 &&
      ["providerId", "providerVersion", "inputDigest", "compilerInputsDigest"].every((key) =>
        Object.hasOwn(record, key),
      ) &&
      providerId.length > 0 &&
      typeof record.providerVersion === "string" &&
      record.providerVersion.length > 0 &&
      typeof record.inputDigest === "string" &&
      qualifiedDigest.test(record.inputDigest) &&
      typeof record.compilerInputsDigest === "string" &&
      qualifiedDigest.test(record.compilerInputsDigest);
    if (!valid || providerIds.has(providerId)) return false;
    providerIds.add(providerId);
    return true;
  });
}

function providerAdmissionsMatchRegistrations(
  admissions: readonly ProviderAdmissionV1[],
  registrations: readonly Readonly<{ providerId: string; providerVersion: string }>[],
): boolean {
  return (
    admissions.length === registrations.length &&
    admissions.every(
      (admission, index) =>
        admission.providerId === registrations[index]?.providerId &&
        admission.providerVersion === registrations[index]?.providerVersion,
    )
  );
}

function parsePayloadV1(input: PreassemblyInput): PreassemblyPayloadV1 {
  if (!hex.test(input.sha256) || sha256(input.bytes) !== input.sha256)
    throw new TypeError("Default catalog preassembly companion seal mismatch");
  const envelope = parseCanonicalObject(input.bytes, "envelope");
  exactKeys(envelope, ["version", "bytes", "sha256"], "envelope");
  if (
    envelope.version !== PREASSEMBLY_VERSION ||
    typeof envelope.bytes !== "string" ||
    typeof envelope.sha256 !== "string"
  )
    throw new TypeError("Default catalog preassembly envelope is malformed");
  if (!hex.test(envelope.sha256) || sha256(envelope.bytes) !== envelope.sha256)
    throw new TypeError("Default catalog preassembly envelope seal mismatch");
  const payload = parseCanonicalObject(envelope.bytes, "payload");
  exactKeys(payload, ["version", "admission", "prepared", "output"], "payload");
  if (payload.version !== PREASSEMBLY_VERSION)
    throw new TypeError("Default catalog preassembly payload version is invalid");
  return payload as unknown as PreassemblyPayloadV1;
}

/** Build-only helper: caller supplies the fresh uncached compiler output. */
export function createDefaultCatalogPreassemblyV1(
  prepared: PreparedWorkbenchCatalogV1,
): PreassemblyInput {
  return sealedPayload({
    version: PREASSEMBLY_VERSION,
    admission: {
      ...defaultCatalogPreassemblyAdmissionV1(),
      providerAdmissions: providerAdmissionsV1(),
    },
    prepared,
    output: {
      bundleDigest: prepared.bundle.provenance.bundleDigest,
      preparedDigest: digest(prepared),
      bindingsDigest: digest(prepared.bindings),
      sourceInputsDigest: digest(prepared.sourceInputs),
    },
  });
}

/** Returns undefined for a stale but well-formed package companion; malformed bytes fail closed. */
export function admitDefaultCatalogPreassemblyV1(
  input: PreassemblyInput,
): PreparedWorkbenchCatalogV1 | undefined {
  const payload = parsePayloadV1(input);
  const admission = object(payload.admission, "admission");
  const live = defaultCatalogPreassemblyAdmissionV1();
  if (!validProviderAdmissions(admission.providerAdmissions))
    throw new TypeError("Default catalog preassembly provider admission is malformed");
  if (
    !providerAdmissionsMatchRegistrations(admission.providerAdmissions, live.providerRegistrations)
  )
    return undefined;
  if (
    canonical(admission) !==
    canonical({ ...live, providerAdmissions: admission.providerAdmissions })
  )
    return undefined;
  const output = object(payload.output, "output");
  exactKeys(
    output,
    ["bundleDigest", "preparedDigest", "bindingsDigest", "sourceInputsDigest"],
    "output",
  );
  const candidate = payload.prepared;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    throw new TypeError("Default catalog preassembly prepared output is malformed");
  if (
    canonical(candidate.catalog) !== canonical(policyAuthoringCatalog()) ||
    candidate.bundle.provenance.bundleDigest !== output.bundleDigest ||
    digest(candidate) !== output.preparedDigest ||
    digest(candidate.bindings) !== output.bindingsDigest ||
    digest(candidate.sourceInputs) !== output.sourceInputsDigest ||
    canonical(candidate.sourceInputs) !== canonical({})
  )
    throw new TypeError("Default catalog preassembly output integrity mismatch");
  verifyAuthoringCatalogBundleIntegrityV1(candidate.bundle);
  return structuredClone(deepFreezeStrictJsonV1(structuredClone(candidate)));
}

export function packagedDefaultCatalogPreassemblyCompanionV1():
  | Readonly<{ catalog: PreassemblyInput; studio: PreassemblyInput }>
  | undefined {
  let path: string;
  try {
    path = requireFromPreassembly.resolve(GENERATED_COMPANION);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "MODULE_NOT_FOUND")
      return undefined;
    throw error;
  }
  const generated = requireFromPreassembly(path) as unknown;
  const value = object(generated, "generated companion");
  if (
    Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === "bytes" || key === "sha256")
  )
    return undefined;
  exactKeys(value, ["catalog", "studio"], "generated companion");
  const catalog = object(value.catalog, "generated catalog companion");
  exactKeys(catalog, ["bytes", "sha256"], "generated catalog companion");
  const studio = object(value.studio, "generated Studio companion");
  exactKeys(studio, ["bytes", "sha256"], "generated Studio companion");
  if (
    typeof catalog.bytes !== "string" ||
    typeof catalog.sha256 !== "string" ||
    typeof studio.bytes !== "string" ||
    typeof studio.sha256 !== "string"
  )
    throw new TypeError("Default catalog preassembly generated companion is malformed");
  return Object.freeze({
    catalog: Object.freeze({ bytes: catalog.bytes, sha256: catalog.sha256 }),
    studio: Object.freeze({ bytes: studio.bytes, sha256: studio.sha256 }),
  });
}

function generatedInputV1(): PreassemblyInput | undefined {
  return packagedDefaultCatalogPreassemblyCompanionV1()?.catalog;
}

/** Package-owned preassembly only; missing development companion preserves compiler fallback. */
export function packagedDefaultCatalogPreassemblyV1(): PreparedWorkbenchCatalogV1 | undefined {
  const input = generatedInputV1();
  return input === undefined ? undefined : admitDefaultCatalogPreassemblyV1(input);
}
