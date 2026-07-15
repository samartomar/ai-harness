import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFile } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  AIH_MARKETPLACE_FILE,
  DEFAULT_MARKETPLACE_OUT,
  type MarketplaceManifest,
  MarketplaceManifestSchema,
} from "../marketplace/manifest.js";
import { policyAwareMcpCatalog } from "../mcp/catalog.js";
import { mcpPackageResolver } from "../mcp/pins.js";
import type { McpServer } from "../mcp/servers.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { MCP_CONFIG_FILES } from "../secrets/scan.js";
import { classifyIncomingMcp } from "../trust/mcp-classify.js";
import { checkWorkspaceChildPath } from "../workspace/detect.js";
import { readWorkspaceManifest } from "../workspace/manifest.js";
import { spanningMcp } from "../workspace/templates.js";

type SurfaceKind = "mcp" | "marketplace";

interface CapabilitySurface {
  kind: SurfaceKind;
  id: string;
  label: string;
  metadata: string;
  forceUndeclared?: boolean;
  sourceUri?: string;
  owner?: string;
  repo?: string;
  pinnedSha?: string;
}

const MCP_REGISTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const OWNER_REPO_PART_RE = /^[A-Za-z0-9_.-]+$/;

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

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function mcpMetadata(server: McpServer): string {
  return `${server.egress}/${server.credentials}/${server.supplyChain}`;
}

function operationalShape(server: McpServer): unknown {
  return server.type === "stdio"
    ? {
        type: server.type,
        command: server.command,
        args: server.args,
        env: server.env ?? {},
      }
    : {
        type: server.type,
        url: server.url,
        headers: server.headers ?? {},
      };
}

function sameOperationalShape(a: McpServer, b: McpServer): boolean {
  return (
    JSON.stringify(stable(operationalShape(a))) === JSON.stringify(stable(operationalShape(b)))
  );
}

function declaredWorkspaceGraphServers(root: string, contextDir: string): Record<string, unknown> {
  const manifest = readWorkspaceManifest(root, contextDir);
  if (manifest?.status !== "OK") return {};
  const repos: string[] = [];
  for (const repo of manifest.repos) {
    try {
      const checked = checkWorkspaceChildPath(root, repo.path);
      if (!checked.exists) continue;
      repos.push(checked.path);
    } catch {
      // An invalid declared child path is not eligible for the internal exemption.
    }
  }
  return spanningMcp(root, repos).mcpServers;
}

function isDeclaredWorkspaceGraphServer(
  generated: Record<string, unknown>,
  name: string,
  value: unknown,
): boolean {
  const expected = generated[name];
  if (expected === undefined) return false;
  return sameOperationalShape(classifyIncomingMcp(value), classifyIncomingMcp(expected));
}

function invalidMcpName(rel: string, name: string): Check {
  const label = safeLabel(name);
  return {
    name: "enterprise baseline attestation",
    verdict: "fail",
    code: "baseline.registry-invalid",
    detail: `${rel} mcpServers.${label} is not a safe registry identity; MCP names must match ${MCP_REGISTRY_ID_RE.source}`,
    location: { uri: `${rel}#mcpServers.${label}` },
    fingerprint: `baseline-invalid:mcp-name:${rel}:${label}`,
  };
}

interface IncomingMcpServerMap {
  key: "mcpServers" | "servers" | "mcp";
  servers: Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function openCodeServer(server: unknown): unknown {
  if (!isRecord(server)) return server;
  if (server.type === "remote") {
    return { ...server, url: stringValue(server.url) };
  }
  const command = Array.isArray(server.command) ? server.command : [];
  const executable = command[0];
  return {
    ...server,
    command: typeof executable === "string" ? executable : undefined,
    args: command.slice(1).filter((item): item is string => typeof item === "string"),
    env: server.environment ?? server.env,
  };
}

function openCodeServers(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, openCodeServer(server)]),
  );
}

function incomingServerMaps(parsed: unknown): IncomingMcpServerMap[] | undefined {
  if (!isRecord(parsed)) return undefined;
  const maps: IncomingMcpServerMap[] = [];
  for (const key of ["mcpServers", "servers"] as const) {
    if (!Object.hasOwn(parsed, key)) continue;
    const value = parsed[key];
    if (!isRecord(value)) return undefined;
    maps.push({ key, servers: value });
  }
  if (Object.hasOwn(parsed, "mcp")) {
    const value = parsed.mcp;
    if (!isRecord(value)) return undefined;
    maps.push({ key: "mcp", servers: openCodeServers(value) });
  }
  return maps;
}

function mcpShapeInvalid(rel: string): Check {
  return {
    name: "enterprise baseline attestation",
    verdict: "fail",
    code: "baseline.registry-invalid",
    detail: `${rel} must contain object MCP server maps to attest registry membership`,
    location: { uri: rel },
    fingerprint: `baseline-invalid:mcp-shape:${rel}`,
  };
}

function unsafeConfigRead(rel: string, reason: string): Check {
  return {
    name: "enterprise baseline attestation",
    verdict: "fail",
    code: "baseline.registry-invalid",
    detail: `${rel} must be a contained regular file for baseline attestation: ${reason}`,
    location: { uri: rel },
    fingerprint: `baseline-invalid:unsafe-config:${rel}`,
  };
}

function readContainedConfig(root: string, rel: string): { raw?: string; error?: Check } {
  const inspected = inspectContainedRelativePath(root, rel);
  if (inspected.state === "absent") return {};
  if (inspected.state === "unsafe") return { error: unsafeConfigRead(rel, inspected.reason) };
  if (inspected.kind !== "file") return { error: unsafeConfigRead(rel, `found ${inspected.kind}`) };
  const raw = readRegularFile(inspected.realPath);
  if (raw === undefined) return { error: unsafeConfigRead(rel, "could not read regular file") };
  return { raw: raw.toString("utf8") };
}

function parseMcpConfig(
  root: string,
  rel: string,
): { maps: IncomingMcpServerMap[]; error?: Check } {
  const read = readContainedConfig(root, rel);
  if (read.error) return { maps: [], error: read.error };
  if (read.raw === undefined) return { maps: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return {
      maps: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: `${rel} is not valid JSON, so the enterprise baseline cannot be attested`,
        location: { uri: rel },
        fingerprint: `baseline-invalid:mcp-json:${rel}`,
      },
    };
  }
  const maps = incomingServerMaps(parsed);
  if (maps === undefined) return { maps: [], error: mcpShapeInvalid(rel) };
  return { maps };
}

type McpCatalog = Record<string, McpServer[]>;

function addCatalogServer(catalog: McpCatalog, name: string, server: McpServer): void {
  const existing = catalog[name] ?? [];
  if (existing.some((candidate) => sameOperationalShape(candidate, server))) {
    catalog[name] = existing;
    return;
  }
  catalog[name] = [...existing, server];
}

function generatedMcpCatalog(ctx: PlanContext): { catalog: McpCatalog; error?: Check } {
  const variants = [
    { scope: "project" },
    { scope: "remote" },
    { scope: "project", githubAuth: "token" as const },
    { scope: "remote", githubAuth: "token" as const },
    { scope: "project", selfHost: true },
    { scope: "remote", selfHost: true },
  ];
  const catalog: McpCatalog = {};
  for (const variant of variants) {
    const catalogResult = policyAwareMcpCatalog(ctx, variant);
    if (catalogResult.error !== undefined && catalogResult.errorSource === "catalog") {
      return {
        catalog: {},
        error: {
          name: "enterprise baseline attestation",
          verdict: "fail",
          code: "baseline.registry-invalid",
          detail: `MCP catalog cannot be built for baseline attestation: ${(catalogResult.error as Error).message}`,
          fingerprint: "baseline-invalid:mcp-catalog",
        },
      };
    }
    for (const [name, server] of Object.entries(catalogResult.servers ?? {})) {
      addCatalogServer(catalog, name, server);
    }
  }
  return { catalog };
}

function catalogBoundServer(
  catalog: McpCatalog,
  name: string,
  classified: McpServer,
): { server: McpServer; declaredByCatalog: boolean } {
  for (const expected of catalog[name] ?? []) {
    const packageResolver =
      classified.type === "stdio" && mcpPackageResolver(classified.command) !== undefined;
    if (
      (!packageResolver || classified.supplyChain === expected.supplyChain) &&
      sameOperationalShape(classified, expected)
    ) {
      return { server: expected, declaredByCatalog: true };
    }
  }
  return { server: classified, declaredByCatalog: false };
}

function parseMcpSurfaces(ctx: PlanContext): { surfaces: CapabilitySurface[]; error?: Check } {
  const catalogResult = generatedMcpCatalog(ctx);
  if (catalogResult.error) return { surfaces: [], error: catalogResult.error };
  const catalog = catalogResult.catalog;
  const workspaceGraphServers = declaredWorkspaceGraphServers(ctx.root, ctx.contextDir);
  const surfaces: CapabilitySurface[] = [];
  for (const rel of MCP_CONFIG_FILES) {
    const read = parseMcpConfig(ctx.root, rel);
    if (read.error) return { surfaces: [], error: read.error };
    for (const map of read.maps) {
      const labels = new Set<string>();
      for (const [name, value] of Object.entries(map.servers).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (!MCP_REGISTRY_ID_RE.test(name))
          return { surfaces: [], error: invalidMcpName(rel, name) };
        if (
          name.startsWith("aih-workspace-graph-") &&
          isDeclaredWorkspaceGraphServer(workspaceGraphServers, name, value)
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
              detail: `${rel} contains colliding MCP registry labels at ${label}`,
              location: { uri: rel },
              fingerprint: `baseline-invalid:mcp-label-collision:${rel}:${label}`,
            },
          };
        }
        labels.add(label);
        const classified = classifyIncomingMcp(value);
        const bound = catalogBoundServer(catalog, name, classified);
        surfaces.push({
          kind: "mcp",
          id: name,
          label,
          metadata: mcpMetadata(bound.server),
          sourceUri: rel,
          forceUndeclared:
            name.startsWith("aih-workspace-graph-") || !bound.declaredByCatalog ? true : undefined,
        });
      }
    }
  }
  return { surfaces };
}

function parseSourceRef(
  source: string,
  commit: string,
): { ref: Pick<CapabilitySurface, "owner" | "repo" | "pinnedSha">; error?: string } {
  const commitSha = /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined;
  if (commitSha === undefined) {
    return { ref: {}, error: "marketplace skill commit must be a 40-character Git SHA" };
  }
  const normalized = source.replace(/^github:/, "");
  const match = /^([^/\s@]+)\/([^@\s]+)(?:@([0-9a-f]{40}))?$/i.exec(normalized);
  if (!match?.[1] || !match[2]) return { ref: {} };
  if (!OWNER_REPO_PART_RE.test(match[1]) || !OWNER_REPO_PART_RE.test(match[2])) return { ref: {} };
  const sourcePin = match[3]?.toLowerCase();
  if (sourcePin !== undefined && sourcePin !== commitSha) {
    return {
      ref: {},
      error: "marketplace skill source pin must match the packaged commit",
    };
  }
  return {
    ref: {
      owner: match[1].toLowerCase(),
      repo: match[2].toLowerCase(),
      pinnedSha: commitSha,
    },
  };
}

function parseMarketplaceSurfaces(root: string): { surfaces: CapabilitySurface[]; error?: Check } {
  const manifestRel = `${DEFAULT_MARKETPLACE_OUT}/${AIH_MARKETPLACE_FILE}`;
  const read = readContainedConfig(root, manifestRel);
  if (read.error) return { surfaces: [], error: read.error };
  if (read.raw === undefined) {
    return { surfaces: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return {
      surfaces: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: `marketplace artifact cannot be parsed for baseline attestation: ${AIH_MARKETPLACE_FILE} is not valid JSON`,
        location: { uri: manifestRel },
        fingerprint: "baseline-invalid:marketplace",
      },
    };
  }
  const result = MarketplaceManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : `: ${issue.path.join(".") || "(root)"} — ${issue.message}`;
    return {
      surfaces: [],
      error: {
        name: "enterprise baseline attestation",
        verdict: "fail",
        code: "baseline.registry-invalid",
        detail: `marketplace artifact cannot be parsed for baseline attestation: ${AIH_MARKETPLACE_FILE} failed schema validation${where}`,
        location: { uri: manifestRel },
        fingerprint: "baseline-invalid:marketplace",
      },
    };
  }
  const manifest: MarketplaceManifest = result.data;
  const surfaces: CapabilitySurface[] = [];
  for (const skill of manifest.skills) {
    const parsed = parseSourceRef(skill.source, skill.commit);
    if (parsed.error) {
      return {
        surfaces: [],
        error: {
          name: "enterprise baseline attestation",
          verdict: "fail",
          code: "baseline.registry-invalid",
          detail: `${safeLabel(skill.name)}: ${parsed.error}`,
          location: { uri: `${DEFAULT_MARKETPLACE_OUT}/marketplace.json` },
          fingerprint: `baseline-invalid:marketplace-pin:${safeLabel(skill.name)}`,
        },
      };
    }
    const ref =
      parsed.ref.owner && parsed.ref.repo
        ? `${parsed.ref.owner}/${parsed.ref.repo}${
            parsed.ref.pinnedSha ? `@${parsed.ref.pinnedSha.slice(0, 12)}` : ""
          }`
        : safeLabel(skill.source);
    surfaces.push({
      kind: "marketplace",
      id: ref,
      label: `marketplace:${ref}`,
      metadata: `${safeLabel(skill.name)}/${skill.verdict}`,
      ...parsed.ref,
    });
  }
  return {
    surfaces: surfaces.sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function collectSurfaces(ctx: PlanContext): { surfaces: CapabilitySurface[]; error?: Check } {
  const mcp = parseMcpSurfaces(ctx);
  if (mcp.error) return mcp;
  const marketplace = parseMarketplaceSurfaces(ctx.root);
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
  if (!surface.pinnedSha) return false;
  return (policy.trust?.approvedSources ?? []).some((source) => {
    if (
      source.owner.toLowerCase() !== surface.owner ||
      source.repo.toLowerCase() !== surface.repo
    ) {
      return false;
    }
    return source.pinnedSha?.toLowerCase() === surface.pinnedSha;
  });
}

function surfaceSummary(surface: CapabilitySurface): string {
  const source = surface.sourceUri ? ` @ ${surface.sourceUri}` : "";
  return `${surface.label}${source} (${surface.metadata})`;
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

  const collected = collectSurfaces(ctx);
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
      } ${collected.surfaces.length === 1 ? "is" : "are"} declared registry members: ${collected.surfaces.map(surfaceSummary).join(", ")}`,
  };
}
