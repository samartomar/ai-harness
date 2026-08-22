import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import type { Posture } from "../config/posture.js";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";

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
export const ADMIN_BASELINE_EVIDENCE_BOOTSTRAP_FILE_V1 = "bootstrap.json";
export const ADMIN_BASELINE_EVIDENCE_CACHE_DIR_V1 = "cache";

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
export interface ResolvedAdminBaselineEvidenceBootstrapV1 {
  readonly bootstrap: AdminBaselineEvidenceBootstrapV1;
  readonly root: string;
  readonly provenance: "os-admin-managed" | "local-admin-file";
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
    (label === "artifact locator" && !parsed.pathname.endsWith("/")) ||
    (label !== "artifact locator" && parsed.pathname.endsWith("/")) ||
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
  if (isProxy(value) || (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))) fail("bytes");
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

function absoluteRoot(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value))
    fail(label);
  return resolve(value);
}
function contained(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
    fail("path containment");
  return target;
}
function hasLinkedAuthorityPath(boundary: string, target: string): boolean {
  const root = absoluteRoot(boundary, "authority boundary");
  const targetPath = resolve(target);
  const rel = relative(root, targetPath);
  if (
    rel.length !== 0 &&
    (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
  )
    return true;
  for (let current = targetPath; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      /* absence fails at bootstrap read */
    }
    if (current === root) return false;
  }
}
export function enterpriseAdminBaselineEvidenceRootV1(platform: NodeJS.Platform): string {
  if (platform === "win32") return "C:\\ProgramData\\aih\\admin-baseline-evidence";
  if (platform === "darwin") return "/Library/Application Support/aih/admin-baseline-evidence";
  return "/etc/aih/admin-baseline-evidence";
}
export function vibeAdminBaselineEvidenceRootV1(adminRoot: string): string {
  return join(absoluteRoot(adminRoot, "admin root"), ".aih", "admin-baseline-evidence");
}
export function adminBaselineEvidenceBootstrapPathV1(root: string): string {
  const checked = absoluteRoot(root, "baseline root");
  return contained(checked, join(checked, ADMIN_BASELINE_EVIDENCE_BOOTSTRAP_FILE_V1));
}
export function resolveAdminBaselineEvidenceBootstrapV1(input: {
  readonly adminRoot: string;
  readonly platformAdminRoot: string;
  readonly posture: Posture;
}): ResolvedAdminBaselineEvidenceBootstrapV1 {
  const enterprise = input.posture === "enterprise";
  const root = enterprise
    ? absoluteRoot(input.platformAdminRoot, "platform admin root")
    : vibeAdminBaselineEvidenceRootV1(input.adminRoot);
  const boundary = enterprise ? root : absoluteRoot(input.adminRoot, "admin root");
  if (hasLinkedAuthorityPath(boundary, root)) fail("baseline root links");
  const bytes = readRegularFile(adminBaselineEvidenceBootstrapPathV1(root), {
    maxBytes: 256 * 1024,
  });
  if (bytes === undefined) {
    fail(
      enterprise
        ? "enterprise posture requires the OS/admin-managed canonical bootstrap file"
        : "vibe posture requires the canonical bootstrap file under the admin root",
    );
  }
  return {
    bootstrap: parseAdminBaselineEvidenceBootstrapV1Json(bytes),
    root,
    provenance: enterprise ? "os-admin-managed" : "local-admin-file",
  };
}
