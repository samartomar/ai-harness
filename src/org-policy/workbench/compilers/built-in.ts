import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../../../contract/strict-json-v1.js";
import type { GovernedMcpTarget } from "../../../internals/cli-registry.js";
import type {
  AihCatalogSourceV1,
  AihPolicyControl,
  PolicyAuthoringHook,
} from "../../catalog-provider-types.js";
import type {
  CompilerAssetDeclarationV1,
  CoreAuthoringCapabilityRegistryEntryV1,
} from "../contracts.js";
import type { CompiledDeclarationV1 } from "./formats.js";

/**
 * The built-in compiler receives only the public fields it renders. Keeping
 * this structural shape local prevents a provider compiler from coupling to
 * the runtime MCP-server registry or its configuration authority.
 */
interface BuiltInMcpDisclosureV1 {
  readonly type: "stdio" | "http";
  readonly description: string;
  readonly egress: "none" | "local-only" | "vendor-incumbent" | "third-party";
  readonly credentials: "none" | "oauth" | "token";
}

export interface BuiltInCatalogInputV1
  extends Pick<AihCatalogSourceV1, "aihCapabilityPackage" | "aihSkills" | "aihAgents"> {
  mcp: readonly {
    id: string;
    description: string;
    control: AihPolicyControl;
    server?: BuiltInMcpDisclosureV1;
  }[];
  hooks: readonly PolicyAuthoringHook[];
  unavailableMcp: readonly {
    id: string;
    description?: string;
    server?: BuiltInMcpDisclosureV1;
    configuredIdentity: string;
    transport: string;
    reason: string;
  }[];
  nonProjectableMcp: readonly {
    id: string;
    transport: string;
    reason: string;
    description?: string;
    server?: BuiltInMcpDisclosureV1;
  }[];
}

/** Only public disclosure fields enter the UI; never commands, headers, or environment values. */
function mcpDecision(
  server: BuiltInMcpDisclosureV1 | undefined,
  description?: string,
): Record<string, string> {
  if (server === undefined) return description === undefined ? {} : { purpose: description };
  const egress = {
    none: "The source declares no network traffic from this server.",
    "local-only": "Network activity is directed by the user, such as sites visited in a browser.",
    "vendor-incumbent":
      "Connects to a vendor service. Review the source description for the destination and data involved.",
    "third-party":
      "Sends data to a third-party service. Review the provider and the information it receives.",
  }[server.egress];
  const credentials = {
    none: "No required credential is declared.",
    oauth: "Uses sign-in authorization handled by the client.",
    token: "Requires a token or API key supplied separately.",
  }[server.credentials];
  return {
    purpose: description ?? server.description,
    access: `${server.type === "stdio" ? "Runs a local process." : "Connects to a service over HTTP."} ${egress} ${credentials}`,
  };
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface CompiledBuiltInCatalogV1 {
  source: { id: string; revisionId: string; contentDigest: string; locator: string };
  declarations: CompiledDeclarationV1[];
  coreCapabilities: CoreAuthoringCapabilityRegistryEntryV1[];
  detailBytes: Record<string, string>;
}

/**
 * AIH's local package declarations are explicitly declaration-bound. Their
 * digests bind the compiler input manifest, never claim to be upstream package
 * bytes or scanner evidence.
 */
export function compileBuiltInCatalogV1(catalog: BuiltInCatalogInputV1): CompiledBuiltInCatalogV1 {
  const sourceId = "source:aih-core";
  const revisionId = `package:${catalog.aihCapabilityPackage.name}@${catalog.aihCapabilityPackage.version}`;
  const sourceManifest = canonicalStrictJsonBytesV1({
    version: "built-in-catalog-input/v1",
    package: catalog.aihCapabilityPackage,
    controls: catalog.mcp.map(({ id, control }) => ({ id, control })),
    unavailableMcp: catalog.unavailableMcp,
    nonProjectableMcp: catalog.nonProjectableMcp,
    hooks: catalog.hooks,
    skills: catalog.aihSkills,
    agents: catalog.aihAgents,
  });
  const detailBytes: Record<string, string> = {};
  const declarations: CompiledDeclarationV1[] = [];
  const coreCapabilities: CoreAuthoringCapabilityRegistryEntryV1[] = [];
  const add = (
    id: string,
    kind: string,
    label: string,
    originalPath: string,
    declarationInput: unknown,
    supportedTargets: readonly GovernedMcpTarget[] = [],
    projectorId?: "mcp-managed-settings" | "usage-hook",
    decision?: Record<string, string>,
    runtimeIdentity?: string,
  ): void => {
    if (declarations.some((entry) => entry.declaration.id === id)) {
      throw new Error(`duplicate built-in catalog declaration ${id}`);
    }
    const detailChunkId = `detail:${id}`;
    const bytes = canonicalStrictJsonBytesV1({
      version: "built-in-declaration/v1",
      declaration: declarationInput,
    });
    const contentDigest = digest(bytes);
    detailBytes[detailChunkId] = canonicalStrictJsonBytesV1({
      version: "built-in-detail/v1",
      declaration: declarationInput,
      identity: { kind: "declaration", digest: contentDigest },
      ...(decision === undefined ? {} : { decision }),
    }).toString("utf8");
    const declaration: CompilerAssetDeclarationV1 = {
      id,
      sourceId,
      sourceRevisionId: revisionId,
      contentDigest,
      originalPath,
      derivation: "built-in",
      kind,
      label,
      detailChunkId,
      declaredHostCapabilities: [...supportedTargets],
      ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    };
    declarations.push({
      declaration,
      inputFormat: "built-in/v1",
    });
    if (projectorId !== undefined) {
      coreCapabilities.push({
        assetId: id,
        sourceId,
        sourceRevisionId: revisionId,
        contentDigest,
        action: "select-control",
        projectorId,
        supportedTargets: [...supportedTargets],
      });
    }
  };
  for (const { id, control, description, server } of catalog.mcp) {
    add(
      `aih/${id}`,
      control.kind,
      id,
      `core-control/${id}`,
      { id, description, control },
      control.targets,
      control.projector,
      mcpDecision(server, description),
      control.source.type === "mcp" ? `mcp:${control.source.server}` : undefined,
    );
  }
  for (const hook of catalog.hooks) {
    if (catalog.mcp.some((entry) => entry.id === hook.id)) continue;
    add(
      `aih/${hook.id}`,
      hook.control.kind,
      hook.id,
      `core-control/${hook.id}`,
      hook,
      hook.control.targets,
      hook.control.projector,
    );
  }
  for (const item of catalog.unavailableMcp) {
    const { description, server, ...declaration } = item;
    add(
      `aih/${item.id}`,
      "mcp",
      item.id,
      `core-request/${item.id}`,
      declaration,
      [],
      undefined,
      mcpDecision(server, description),
      `mcp:${item.configuredIdentity}`,
    );
  }
  for (const item of catalog.nonProjectableMcp) {
    const id = `aih/${item.id}`;
    if (!declarations.some((entry) => entry.declaration.id === id)) {
      const { description, server, ...declaration } = item;
      add(
        id,
        "mcp",
        item.id,
        `core-request/${item.id}`,
        declaration,
        [],
        undefined,
        mcpDecision(server, description),
        `mcp:${item.id}`,
      );
    }
  }
  for (const pack of catalog.aihSkills) {
    const { purpose, ...declaration } = pack;
    add(
      `aih/${pack.id}`,
      "skill",
      pack.id,
      pack.sources[0]?.path ?? `packs/${pack.pack}`,
      declaration,
      [],
      undefined,
      purpose === undefined ? undefined : { purpose },
    );
  }
  for (const pack of catalog.aihAgents) {
    const { purpose, ...declaration } = pack;
    add(
      `aih/${pack.id}`,
      "agent",
      pack.id,
      pack.sources[0]?.path ?? `packs/${pack.pack}`,
      declaration,
      [],
      undefined,
      purpose === undefined ? undefined : { purpose },
    );
  }
  return {
    source: {
      id: sourceId,
      revisionId,
      contentDigest: digest(sourceManifest),
      locator: catalog.aihCapabilityPackage.name,
    },
    declarations,
    coreCapabilities,
    detailBytes,
  };
}
