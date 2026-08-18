import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import type { Posture } from "../config/posture.js";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";

/**
 * The frozen bootstrap contract for operational administrator catalog
 * consumption. It is the ONLY authority an administrator seat starts from: it
 * binds the HTTPS locators, the exact artifact/catalog/promotion/package pins,
 * both signer identities and their distinct root digests, the schema/effect
 * versions, the source/channel/trust context, and the cache policy.
 *
 * Nothing here is derived from the environment, the governed target repository,
 * a browser, or any fetched or cache-derived value. The bootstrap is read from
 * exactly one canonical file whose location is fixed by posture.
 */

export const ADMIN_CATALOG_BOOTSTRAP_FILE = "admin-catalog-bootstrap.json";
export const ADMIN_CATALOG_CACHE_DIR = "cache";
const MAX_BOOTSTRAP_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_URL_LENGTH = 512;
const MIN_CACHE_MAX_AGE_SECONDS = 60;
const MAX_CACHE_MAX_AGE_SECONDS = 31_536_000;
const SHA256 = /^[a-f0-9]{64}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const BOOTSTRAP_FIELDS = [
  "adminSignerRootSha256",
  "cacheMaxAgeSeconds",
  "catalogArtifactUrl",
  "catalogAttestationUrl",
  "channel",
  "expectedAdminSignerIdentity",
  "expectedAdminWorkflowIdentity",
  "expectedCatalogSha256",
  "expectedCatalogSignerIdentity",
  "expectedEffectVersion",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedPackageRootSha256",
  "expectedPackageSha256",
  "expectedPromotionDecisionSha256",
  "expectedRef",
  "expectedRepository",
  "expectedSchemaVersion",
  "expectedWorkflowIdentity",
  "headSignerRootSha256",
  "lastGoodCatalogStateBytes",
  "packagedCatalogStateBytes",
  "protocol",
  "signedDistributionUrl",
  "signedDistributionAttestationUrl",
  "sourceId",
] as const;

export type AdminCatalogBootstrapProvenanceV1 = "os-admin-managed" | "local-admin-file";

export type AdminCatalogBootstrapV1 = Readonly<{
  adminSignerRootSha256: string;
  cacheMaxAgeSeconds: number;
  catalogArtifactUrl: string;
  catalogAttestationUrl: string;
  channel: string;
  expectedAdminSignerIdentity: string;
  expectedAdminWorkflowIdentity: string;
  expectedCatalogSha256: string;
  expectedCatalogSignerIdentity: string;
  expectedEffectVersion: string;
  expectedEnvironment: string;
  expectedIssuer: string;
  expectedPackageRootSha256: string;
  expectedPackageSha256: string;
  expectedPromotionDecisionSha256: string;
  expectedRef: string;
  expectedRepository: string;
  expectedSchemaVersion: string;
  expectedWorkflowIdentity: string;
  headSignerRootSha256: string;
  lastGoodCatalogStateBytes: string;
  packagedCatalogStateBytes: string;
  protocol: "AdminCatalogBootstrapV1";
  signedDistributionUrl: string;
  signedDistributionAttestationUrl: string;
  sourceId: string;
}>;

export interface ResolvedAdminCatalogBootstrapV1 {
  readonly bootstrap: AdminCatalogBootstrapV1;
  readonly catalogRoot: string;
  readonly provenance: AdminCatalogBootstrapProvenanceV1;
}

export interface ResolveAdminCatalogBootstrapV1Input {
  readonly adminRoot: string;
  /** The fixed OS/admin-managed root; production passes the platform constant. */
  readonly platformAdminRoot: string;
  readonly posture: Posture;
}

/** Fixed diagnostics only — a bootstrap failure never echoes a path or locator. */
function fail(label: string): never {
  throw new AihError(`admin catalog bootstrap: ${label}`, "AIH_ADMIN_CATALOG");
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    fail(label);
}

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(label);
  return result;
}

/**
 * An exact, canonical HTTPS locator: no other scheme, no credentials, no port,
 * no query, no fragment, and no path normalization. Requiring `href === value`
 * means a traversal or case trick cannot survive as a different pinned string.
 */
function locator(value: unknown, label: string): string {
  const raw = text(value, label, MAX_URL_LENGTH);
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
    !HOSTNAME.test(parsed.hostname) ||
    !parsed.pathname.startsWith("/") ||
    parsed.pathname.endsWith("/") ||
    parsed.pathname
      .slice(1)
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    fail(label);
  return raw;
}

function workflowIdentity(value: unknown, repository: string, label: string): string {
  const workflow = text(value, label);
  const githubRepository = repository.slice("github.com/".length);
  const prefix = `${githubRepository}/.github/workflows/`;
  const filename = workflow.startsWith(prefix) ? workflow.slice(prefix.length) : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/.test(filename)) fail(label);
  return workflow;
}

function stateBytes(value: unknown, label: string, protocol: string): string {
  const encoded = text(value, label, Math.ceil((MAX_STATE_BYTES * 4) / 3) + 4);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_STATE_BYTES || bytes.toString("base64") !== encoded)
    fail(label);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(label);
  }
  // Shape-only: the shipped foundation owns full catalog-state verification.
  try {
    if (parseStrictJsonObjectV1(decoded, label).protocol !== protocol) fail(label);
  } catch {
    fail(label);
  }
  return encoded;
}

export function parseAdminCatalogBootstrapV1Json(value: unknown): AdminCatalogBootstrapV1 {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail("bytes");
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > MAX_BOOTSTRAP_BYTES) fail("bytes");
  let raw: Record<string, unknown>;
  try {
    raw = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "bootstrap",
    );
  } catch {
    fail("bytes");
  }
  exact(raw, BOOTSTRAP_FIELDS, "fields");
  if (raw.protocol !== "AdminCatalogBootstrapV1") fail("protocol");
  if (raw.expectedSchemaVersion !== "1" || raw.expectedEffectVersion !== "1")
    fail("catalog compatibility");
  if (raw.expectedRef !== "refs/heads/main") fail("trust context");
  const channel = text(raw.channel, "channel", 64);
  const sourceId = text(raw.sourceId, "source ID");
  const repository = text(raw.expectedRepository, "repository");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(channel)) fail("channel");
  if (!/^[a-z0-9][a-z0-9./-]*$/.test(sourceId) || /(^|\/)\.\.?(\/|$)/.test(sourceId))
    fail("source ID");
  if (!/^github\.com\/[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/.test(repository))
    fail("repository");
  if (
    !Number.isSafeInteger(raw.cacheMaxAgeSeconds) ||
    (raw.cacheMaxAgeSeconds as number) < MIN_CACHE_MAX_AGE_SECONDS ||
    (raw.cacheMaxAgeSeconds as number) > MAX_CACHE_MAX_AGE_SECONDS
  )
    fail("cache policy");
  const headSignerRootSha256 = digest(raw.headSignerRootSha256, "head signer root");
  const adminSignerRootSha256 = digest(raw.adminSignerRootSha256, "admin signer root");
  if (headSignerRootSha256 === adminSignerRootSha256) fail("signer roots");
  const result: AdminCatalogBootstrapV1 = {
    adminSignerRootSha256,
    cacheMaxAgeSeconds: raw.cacheMaxAgeSeconds as number,
    catalogArtifactUrl: locator(raw.catalogArtifactUrl, "artifact locator"),
    catalogAttestationUrl: locator(raw.catalogAttestationUrl, "attestation locator"),
    channel,
    expectedAdminSignerIdentity: text(raw.expectedAdminSignerIdentity, "admin signer identity"),
    expectedAdminWorkflowIdentity: workflowIdentity(
      raw.expectedAdminWorkflowIdentity,
      repository,
      "admin workflow identity",
    ),
    expectedCatalogSha256: digest(raw.expectedCatalogSha256, "catalog pin"),
    expectedCatalogSignerIdentity: text(
      raw.expectedCatalogSignerIdentity,
      "catalog signer identity",
    ),
    expectedEffectVersion: "1",
    expectedEnvironment: text(raw.expectedEnvironment, "environment"),
    expectedIssuer: text(raw.expectedIssuer, "issuer"),
    expectedPackageRootSha256: digest(raw.expectedPackageRootSha256, "package root pin"),
    expectedPackageSha256: digest(raw.expectedPackageSha256, "package pin"),
    expectedPromotionDecisionSha256: digest(
      raw.expectedPromotionDecisionSha256,
      "promotion decision pin",
    ),
    expectedRef: "refs/heads/main",
    expectedRepository: repository,
    expectedSchemaVersion: "1",
    expectedWorkflowIdentity: workflowIdentity(
      raw.expectedWorkflowIdentity,
      repository,
      "workflow identity",
    ),
    headSignerRootSha256,
    lastGoodCatalogStateBytes: stateBytes(
      raw.lastGoodCatalogStateBytes,
      "last-good catalog state",
      "CachedCatalogStateV1",
    ),
    packagedCatalogStateBytes: stateBytes(
      raw.packagedCatalogStateBytes,
      "packaged catalog state",
      "PackagedCatalogStateV1",
    ),
    protocol: "AdminCatalogBootstrapV1",
    signedDistributionUrl: locator(raw.signedDistributionUrl, "distribution locator"),
    signedDistributionAttestationUrl: locator(
      raw.signedDistributionAttestationUrl,
      "distribution attestation locator",
    ),
    sourceId,
  };
  if (canonicalStrictJsonBytesV1(result).compare(bytes) !== 0) fail("noncanonical bytes");
  return deepFreezeStrictJsonV1(structuredClone(result)) as AdminCatalogBootstrapV1;
}

/**
 * The `gh attestation verify --repo` identity is DERIVED from the pinned
 * repository, so the bootstrap carries no second, independently settable
 * repository authority that could disagree with the signed head predicate.
 */
export function adminCatalogAttestationRepositoryV1(bootstrap: AdminCatalogBootstrapV1): string {
  return bootstrap.expectedRepository.slice("github.com/".length);
}

/**
 * The fixed OS/admin-managed enterprise location. It is a compile-time constant
 * per platform: no environment variable, target repository, or discovered path
 * participates, because enterprise posture must not be steerable by the seat.
 */
export function enterpriseAdminCatalogRootV1(platform: NodeJS.Platform): string {
  if (platform === "win32") return "C:\\ProgramData\\aih\\admin-catalog";
  if (platform === "darwin") return "/Library/Application Support/aih/admin-catalog";
  return "/etc/aih/admin-catalog";
}

function absoluteRoot(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(label);
  if (!isAbsolute(value)) fail(label);
  return resolve(value);
}

/** The vibe canonical location, always contained beneath the admin root. */
export function vibeAdminCatalogRootV1(adminRoot: string): string {
  return join(absoluteRoot(adminRoot, "admin root"), ".aih", "admin-catalog");
}

function contained(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
    fail("path containment");
  return target;
}

/** Reject links only within the authority-controlled path segment. */
function hasLinkedAuthorityPath(boundary: string, target: string): boolean {
  const root = absoluteRoot(boundary, "authority boundary");
  const resolvedTarget = resolve(target);
  const rel = relative(root, resolvedTarget);
  if (
    rel.length !== 0 &&
    (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes(".."))
  )
    return true;
  for (let current = resolvedTarget; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A missing target still fails through the fixed bootstrap-file diagnostic.
    }
    if (current === root) return false;
  }
}

export function adminCatalogBootstrapPathV1(catalogRoot: string): string {
  const root = absoluteRoot(catalogRoot, "catalog root");
  return contained(root, join(root, ADMIN_CATALOG_BOOTSTRAP_FILE));
}

/**
 * One deterministic cache slot per (source, channel), named by a
 * domain-separated digest so the file name can never carry a traversal segment
 * and never varies with an untrusted value.
 */
export function adminCatalogCacheSlotPathV1(
  catalogRoot: string,
  bootstrap: AdminCatalogBootstrapV1,
): string {
  const root = absoluteRoot(catalogRoot, "catalog root");
  const slot = createHash("sha256")
    .update(
      canonicalStrictJsonBytesV1({
        domain: "aih.admin-catalog-cache-slot-v1",
        value: { channel: bootstrap.channel, sourceId: bootstrap.sourceId },
      }),
    )
    .digest("hex");
  return contained(root, join(root, ADMIN_CATALOG_CACHE_DIR, `${slot}.json`));
}

/**
 * Enterprise reads ONLY the fixed OS/admin-managed file; a missing file fails
 * closed and never falls through to the vibe copy under the target admin root.
 * Vibe reads only its explicit canonical file and reports the visibly weaker
 * `local-admin-file` provenance, which is never enterprise-eligible.
 */
export function resolveAdminCatalogBootstrapV1(
  input: ResolveAdminCatalogBootstrapV1Input,
): ResolvedAdminCatalogBootstrapV1 {
  const enterprise = input.posture === "enterprise";
  const catalogRoot = enterprise
    ? absoluteRoot(input.platformAdminRoot, "platform admin root")
    : vibeAdminCatalogRootV1(input.adminRoot);
  const authorityBoundary = enterprise ? catalogRoot : absoluteRoot(input.adminRoot, "admin root");
  if (hasLinkedAuthorityPath(authorityBoundary, catalogRoot)) fail("catalog root links");
  const bytes = readRegularFile(adminCatalogBootstrapPathV1(catalogRoot), {
    maxBytes: MAX_BOOTSTRAP_BYTES,
  });
  if (bytes === undefined) {
    fail(
      enterprise
        ? "enterprise posture requires the OS/admin-managed canonical bootstrap file"
        : "vibe posture requires the canonical bootstrap file under the admin root",
    );
  }
  return {
    bootstrap: parseAdminCatalogBootstrapV1Json(bytes),
    catalogRoot,
    provenance: enterprise ? "os-admin-managed" : "local-admin-file",
  };
}
