import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { DEFAULT_MARKETPLACE_OUT, readMarketplaceManifest } from "../marketplace/manifest.js";
import type { McpCredentials, McpEgress, McpSupplyChain } from "../mcp/servers.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { classifyIncomingMcp } from "../trust/mcp-classify.js";
import { checkWorkspaceChildPath } from "../workspace/detect.js";
import { readWorkspaceManifest } from "../workspace/manifest.js";
import { aihWorkspaceGraphRepo } from "../workspace/templates.js";

type SurfaceKind = "mcp" | "marketplace";

interface CapabilitySurface {
  kind: SurfaceKind;
  id: string;
  label: string;
  metadata: string;
  forceUndeclared?: boolean;
  owner?: string;
  repo?: string;
  pinnedSha?: string;
}

const MCP_REGISTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const EGRESS_VALUES = new Set<McpEgress>(["none", "local-only", "vendor-incumbent", "third-party"]);
const CREDENTIAL_VALUES = new Set<McpCredentials>(["none", "oauth", "token"]);
const SUPPLY_CHAIN_VALUES = new Set<McpSupplyChain>(["pinned", "unpinned", "hosted-remote"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeLabel(value: string): string {
  const rendered = value
    .replace(/[\r\n]+/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: labels must not carry terminal controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[^A-Za-z0-9._:@/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return rendered.length > 0 ? rendered.slice(0, 120) : "unnamed";
}

function stringField(
  raw: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const value = raw[key];
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function mcpMetadata(rawServer: unknown): string {
  const raw = isRecord(rawServer) ? rawServer : {};
  const fallback = classifyIncomingMcp(rawServer);
  const egress = stringField(raw, "egress", EGRESS_VALUES) ?? fallback.egress;
  const credentials = stringField(raw, "credentials", CREDENTIAL_VALUES) ?? fallback.credentials;
  const supplyChain = stringField(raw, "supplyChain", SUPPLY_CHAIN_VALUES) ?? fallback.supplyChain;
  return `${egress}/${credentials}/${supplyChain}`;
}

function realOrResolved(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function declaredWorkspaceGraphRepos(root: string, contextDir: string): Set<string> {
  const manifest = readWorkspaceManifest(root, contextDir);
  if (manifest?.status !== "OK") return new Set();
  const rootAbs = realOrResolved(root);
  const out = new Set<string>();
  for (const repo of manifest.repos) {
    try {
      const checked = checkWorkspaceChildPath(rootAbs, repo.path);
      if (!checked.exists) continue;
      const child = realOrResolved(join(rootAbs, checked.path));
      if (isContainedPath(rootAbs, child)) out.add(child);
    } catch {
      // An invalid declared child path is not eligible for the internal exemption.
    }
  }
  return out;
}

function isDeclaredWorkspaceGraphServer(root: string, contextDir: string, value: unknown): boolean {
  const repo = aihWorkspaceGraphRepo(value);
  if (repo === undefined || !isAbsolute(repo)) return false;
  const rootAbs = realOrResolved(root);
  const repoAbs = realOrResolved(repo);
  if (!isContainedPath(rootAbs, repoAbs)) return false;
  return declaredWorkspaceGraphRepos(rootAbs, contextDir).has(repoAbs);
}

function invalidMcpName(name: string): Check {
  const label = safeLabel(name);
  return {
    name: "enterprise baseline attestation",
    verdict: "fail",
    code: "baseline.registry-invalid",
    detail: `.mcp.json mcpServers.${label} is not a safe registry identity; MCP names must match ${MCP_REGISTRY_ID_RE.source}`,
    location: { uri: `.mcp.json#mcpServers.${label}` },
    fingerprint: `baseline-invalid:mcp-name:${label}`,
  };
}

function parseMcpSurfaces(
  root: string,
  contextDir: string,
): { surfaces: CapabilitySurface[]; error?: Check } {
  const raw = readIfExists(join(root, ".mcp.json"));
  if (raw === undefined) return { surfaces: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      surfaces: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: ".mcp.json is not valid JSON, so the enterprise baseline cannot be attested",
        location: { uri: ".mcp.json" },
        fingerprint: "baseline-invalid:mcp-json",
      },
    };
  }
  const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
  if (servers === undefined) return { surfaces: [] };
  if (!isRecord(servers)) {
    return {
      surfaces: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: ".mcp.json mcpServers must be an object to attest registry membership",
        location: { uri: ".mcp.json" },
        fingerprint: "baseline-invalid:mcp-shape",
      },
    };
  }
  const surfaces: CapabilitySurface[] = [];
  const labels = new Set<string>();
  for (const [name, value] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    if (!MCP_REGISTRY_ID_RE.test(name)) return { surfaces: [], error: invalidMcpName(name) };
    if (
      name.startsWith("aih-workspace-graph-") &&
      isDeclaredWorkspaceGraphServer(root, contextDir, value)
    ) {
      continue;
    }
    const label = `mcp:${safeLabel(name)}`;
    if (labels.has(label)) {
      return {
        surfaces: [],
        error: {
          name: "enterprise baseline attestation",
          verdict: "fail",
          code: "baseline.registry-invalid",
          detail: `.mcp.json contains colliding MCP registry labels at ${label}`,
          location: { uri: ".mcp.json" },
          fingerprint: `baseline-invalid:mcp-label-collision:${label}`,
        },
      };
    }
    labels.add(label);
    surfaces.push({
      kind: "mcp",
      id: name,
      label,
      metadata: mcpMetadata(value),
      forceUndeclared: name.startsWith("aih-workspace-graph-") ? true : undefined,
    });
  }
  return { surfaces };
}

function parseSourceRef(
  source: string,
  commit: string,
): Pick<CapabilitySurface, "owner" | "repo" | "pinnedSha"> {
  const normalized = source.replace(/^github:/, "");
  const match = /^([^/\s@]+)\/([^@\s]+)(?:@([0-9a-f]{40}))?$/i.exec(normalized);
  if (!match?.[1] || !match[2]) return {};
  const commitSha = /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined;
  return {
    owner: match[1],
    repo: match[2],
    pinnedSha: (match[3] ?? commitSha)?.toLowerCase(),
  };
}

function parseMarketplaceSurfaces(root: string): { surfaces: CapabilitySurface[]; error?: Check } {
  const marketplaceDir = join(root, DEFAULT_MARKETPLACE_OUT);
  if (readIfExists(join(marketplaceDir, "marketplace.json")) === undefined) {
    return { surfaces: [] };
  }
  const read = readMarketplaceManifest(marketplaceDir);
  if (!read.ok) {
    return {
      surfaces: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: `marketplace artifact cannot be parsed for baseline attestation: ${read.reason}`,
        location: { uri: `${DEFAULT_MARKETPLACE_OUT}/marketplace.json` },
        fingerprint: "baseline-invalid:marketplace",
      },
    };
  }
  return {
    surfaces: read.manifest.skills
      .map((skill) => {
        const parsed = parseSourceRef(skill.source, skill.commit);
        const ref =
          parsed.owner && parsed.repo
            ? `${parsed.owner}/${parsed.repo}${
                parsed.pinnedSha ? `@${parsed.pinnedSha.slice(0, 12)}` : ""
              }`
            : safeLabel(skill.source);
        return {
          kind: "marketplace" as const,
          id: ref,
          label: `marketplace:${ref}`,
          metadata: `${skill.name}/${skill.verdict}`,
          ...parsed,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function collectSurfaces(
  root: string,
  contextDir: string,
): { surfaces: CapabilitySurface[]; error?: Check } {
  const mcp = parseMcpSurfaces(root, contextDir);
  if (mcp.error) return mcp;
  const marketplace = parseMarketplaceSurfaces(root);
  if (marketplace.error) return marketplace;
  return { surfaces: [...mcp.surfaces, ...marketplace.surfaces] };
}

function isDeclared(surface: CapabilitySurface, policy: OrgPolicy): boolean {
  if (surface.forceUndeclared === true) return false;
  if (surface.kind === "mcp") {
    const allowed = new Set(policy.mcp?.allowedServers ?? []);
    return allowed.has(surface.id) || allowed.has(surface.label);
  }
  if (!surface.owner || !surface.repo) return false;
  return (policy.trust?.approvedSources ?? []).some((source) => {
    if (source.owner !== surface.owner || source.repo !== surface.repo) return false;
    return source.pinnedSha === undefined || source.pinnedSha.toLowerCase() === surface.pinnedSha;
  });
}

function surfaceSummary(surface: CapabilitySurface): string {
  return `${surface.label} (${surface.metadata})`;
}

export function enterpriseBaselineAttestationCheck(ctx: PlanContext): Check {
  const name = "enterprise baseline attestation";
  if (ctx.posture !== "enterprise") {
    return {
      name,
      verdict: "skip",
      detail: "enterprise baseline attestation runs only at enterprise posture",
    };
  }

  const collected = collectSurfaces(ctx.root, ctx.contextDir);
  if (collected.error) return collected.error;
  if (collected.surfaces.length === 0) {
    return {
      name,
      verdict: "pass",
      detail: "clean baseline attestation: no external capability surfaces discovered",
    };
  }

  let policy: OrgPolicy | undefined;
  try {
    policy = readOrgPolicy(ctx.root, ctx.env);
  } catch (err) {
    return {
      name,
      verdict: "fail",
      code: "baseline.registry-invalid",
      detail: `declared capability registry cannot be read from ${AIH_ORG_POLICY_FILE}: ${(err as Error).message}`,
      location: { uri: AIH_ORG_POLICY_FILE },
      fingerprint: "baseline-invalid:org-policy",
    };
  }
  if (policy === undefined) {
    return {
      name,
      verdict: "fail",
      code: "baseline.registry-missing",
      detail: `external capability surfaces are present (${collected.surfaces
        .map((surface) => surface.label)
        .join(", ")}) but ${AIH_ORG_POLICY_FILE} does not declare a registry`,
      location: { uri: AIH_ORG_POLICY_FILE },
      fingerprint: "baseline-registry-missing",
    };
  }

  const undeclared = collected.surfaces.filter((surface) => !isDeclared(surface, policy));
  if (undeclared.length > 0) {
    return {
      name,
      verdict: "fail",
      code: "baseline.undeclared-surface",
      detail:
        "undeclared external capability surfaces: " +
        `${undeclared.map(surfaceSummary).join(", ")} — declare them in ${AIH_ORG_POLICY_FILE} (` +
        "mcp.allowedServers / trust.approvedSources) or remove the residue",
      fingerprint: `baseline-undeclared:${undeclared.map((surface) => surface.label).join("|")}`,
    };
  }

  return {
    name,
    verdict: "pass",
    detail:
      "clean baseline attestation: " +
      `${collected.surfaces.length} external capability surface${
        collected.surfaces.length === 1 ? "" : "s"
      } are declared registry members: ${collected.surfaces.map(surfaceSummary).join(", ")}`,
  };
}
