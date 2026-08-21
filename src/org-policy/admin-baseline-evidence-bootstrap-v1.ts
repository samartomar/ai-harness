import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;
const ISSUER = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/;
const FIELDS = [
  "artifactUrl",
  "attestationUrl",
  "cacheMaxAgeSeconds",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedRef",
  "expectedRepository",
  "expectedWorkflow",
  "maxSchemaVersion",
  "minSchemaVersion",
  "protocol",
  "sources",
] as const;

const REQUIRED_SOURCES = [
  {
    id: "ecc",
    owner: "affaan-m",
    pinnedSha: "623f2c020f052319657674e4e6c29ab5d0ad566b",
    repo: "ecc",
  },
  {
    id: "superpowers",
    owner: "obra",
    pinnedSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
    repo: "Superpowers",
  },
] as const;

export interface AdminBaselineEvidenceBootstrapV1 {
  readonly artifactUrl: string;
  readonly attestationUrl: string;
  readonly cacheMaxAgeSeconds: number;
  readonly expectedEnvironment: string;
  readonly expectedIssuer: string;
  readonly expectedRef: string;
  readonly expectedRepository: string;
  readonly expectedWorkflow: string;
  readonly maxSchemaVersion: number;
  readonly minSchemaVersion: number;
  readonly protocol: "AdminBaselineEvidenceBootstrapV1";
  readonly sources: readonly Readonly<{
    id: string;
    owner: string;
    pinnedSha: string;
    repo: string;
  }>[];
}

function fail(label: string): never {
  throw new AihError(`admin baseline evidence bootstrap: ${label}`, "AIH_ADMIN_BASELINE_EVIDENCE");
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label);
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  return value;
}

function locator(value: unknown, label: string): string {
  const raw = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail(label);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.href !== raw ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.hostname.includes(".") ||
    !parsed.pathname.startsWith("/") ||
    parsed.pathname.endsWith("/") ||
    parsed.pathname.split("/").some((part) => part === "." || part === "..")
  )
    fail(label);
  return raw;
}

function validRef(value: string): boolean {
  const match = /^refs\/(?:heads|tags)\/(.+)$/.exec(value);
  if (match?.[1] === undefined || value.endsWith(".") || value.length > 512) return false;
  return (
    !match[1].includes("..") &&
    match[1]
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith(".lock"))
  );
}

export function parseAdminBaselineEvidenceBootstrapV1Json(
  value: unknown,
): AdminBaselineEvidenceBootstrapV1 {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail("bytes");
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > 256 * 1024) fail("bytes");
  let raw: Record<string, unknown>;
  try {
    raw = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "bootstrap",
    );
  } catch {
    fail("bytes");
  }
  exact(raw, FIELDS, "fields");
  if (raw.protocol !== "AdminBaselineEvidenceBootstrapV1") fail("protocol");
  const repository = text(raw.expectedRepository, "repository", 256);
  const workflow = text(raw.expectedWorkflow, "workflow", 512);
  const issuer = text(raw.expectedIssuer, "issuer", 512);
  const ref = text(raw.expectedRef, "ref", 512);
  const environment = text(raw.expectedEnvironment, "environment", 128);
  if (
    !REPOSITORY.test(repository) ||
    !WORKFLOW.test(workflow) ||
    !workflow.startsWith(`${repository}/.github/workflows/`) ||
    !ISSUER.test(issuer) ||
    !validRef(ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)
  )
    fail("identity");
  if (
    !Number.isSafeInteger(raw.minSchemaVersion) ||
    !Number.isSafeInteger(raw.maxSchemaVersion) ||
    (raw.minSchemaVersion as number) < 1 ||
    (raw.maxSchemaVersion as number) < (raw.minSchemaVersion as number)
  )
    fail("schema range");
  if (
    !Number.isSafeInteger(raw.cacheMaxAgeSeconds) ||
    (raw.cacheMaxAgeSeconds as number) < 60 ||
    (raw.cacheMaxAgeSeconds as number) > 31_536_000
  )
    fail("cache policy");
  if (!Array.isArray(raw.sources) || raw.sources.length !== REQUIRED_SOURCES.length)
    fail("sources");
  const sources = raw.sources.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) fail("sources");
    const source = item as Record<string, unknown>;
    exact(source, ["id", "owner", "pinnedSha", "repo"], "sources");
    return {
      id: text(source.id, "sources", 128),
      owner: text(source.owner, "sources", 128),
      pinnedSha: text(source.pinnedSha, "sources", 40),
      repo: text(source.repo, "sources", 128),
    };
  });
  const result: AdminBaselineEvidenceBootstrapV1 = {
    artifactUrl: locator(raw.artifactUrl, "artifact locator"),
    attestationUrl: locator(raw.attestationUrl, "attestation locator"),
    cacheMaxAgeSeconds: raw.cacheMaxAgeSeconds as number,
    expectedEnvironment: environment,
    expectedIssuer: issuer,
    expectedRef: ref,
    expectedRepository: repository,
    expectedWorkflow: workflow,
    maxSchemaVersion: raw.maxSchemaVersion as number,
    minSchemaVersion: raw.minSchemaVersion as number,
    protocol: "AdminBaselineEvidenceBootstrapV1",
    sources,
  };
  if (JSON.stringify(result.sources) !== JSON.stringify(REQUIRED_SOURCES)) fail("source");
  if (canonicalStrictJsonBytesV1(result).compare(bytes) !== 0) fail("noncanonical bytes");
  return deepFreezeStrictJsonV1(structuredClone(result)) as AdminBaselineEvidenceBootstrapV1;
}
