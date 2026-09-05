import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../../../contract/strict-json-v1.js";
import type { PolicyAuthoringCatalog } from "../../catalog.js";
import type {
  CompilerAssetDeclarationV1,
  CoreAuthoringCapabilityRegistryEntryV1,
} from "../contracts.js";
import type { CompiledDeclarationV1 } from "./registry.js";

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
export function compileBuiltInCatalogV1(catalog: PolicyAuthoringCatalog): CompiledBuiltInCatalogV1 {
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
    supportedTargets: readonly ("claude" | "codex" | "kiro")[] = [],
    projectorId?: "mcp-managed-settings" | "usage-hook",
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
  for (const { id, control, description } of catalog.mcp) {
    add(
      `aih/${id}`,
      control.kind,
      id,
      `core-control/${id}`,
      { id, description, control },
      control.targets,
      control.projector,
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
    add(`aih/${item.id}`, "mcp", item.id, `core-request/${item.id}`, item);
  }
  for (const item of catalog.nonProjectableMcp) {
    const id = `aih/${item.id}`;
    if (!declarations.some((entry) => entry.declaration.id === id)) {
      add(id, "mcp", item.id, `core-request/${item.id}`, item);
    }
  }
  for (const pack of catalog.aihSkills) {
    add(`aih/${pack.id}`, "skill", pack.id, pack.sources[0]?.path ?? `packs/${pack.pack}`, pack);
  }
  for (const pack of catalog.aihAgents) {
    add(`aih/${pack.id}`, "agent", pack.id, pack.sources[0]?.path ?? `packs/${pack.pack}`, pack);
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
