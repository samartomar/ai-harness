import { expect } from "vitest";
import type { WorkbenchPolicyBindingsV1 } from "../../../src/org-policy/workbench/compile-policy.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
} from "../../../src/org-policy/workbench/contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";

const digest = "sha256:" + "a".repeat(64);
const origin = { kind: "administrator" } as const;
function asset(
  id: string,
  action: AuthoringAssetV1["authoring"]["action"] = "record-selection",
): AuthoringAssetV1 {
  return {
    id,
    sourceId: "source:test",
    sourceRevisionId: "revision:1",
    contentDigest: digest,
    originalPath: "catalog.json",
    derivation: "built-in",
    kind: "skill",
    label: id,
    detailChunkId: "detail:" + id,
    declaredHostCapabilities: [],
    authoring: {
      action,
      supportedTargets: action === "select-control" ? ["codex"] : [],
      ...(action === "select-control" ? { projectorId: "mcp-managed-settings" as const } : {}),
    },
  };
}
export function fixture() {
  const assets = Object.fromEntries(
    [
      asset("tool", "select-control"),
      asset("package"),
      asset("external"),
      asset("request", "record-request"),
      asset("other"),
    ].map((item) => [item.id, item]),
  );
  const bundle = {
    version: "authoring-catalog-bundle/v1",
    sources: {},
    assets,
    groups: {},
    relations: [],
    templates: {},
    evidence: {},
    provenance: { bundleDigest: digest },
    detailChunks: {},
  } as AuthoringCatalogBundleV1;
  const bindings: WorkbenchPolicyBindingsV1 = {
    tool: {
      kind: "control",
      candidate: { id: "tool", targets: ["codex"], source: { type: "aih" } },
    },
    package: {
      kind: "package-root",
      packageRoot: { catalogRepository: "acme/catalog", root: "skill:test" },
    },
    external: {
      kind: "external-selection",
      external: {
        owner: "acme",
        item: {
          id: "skill:external",
          kind: "skill",
          source: { repository: "acme/source", commit: "b".repeat(40), path: "skill.md" },
        },
      },
    },
    other: { kind: "intent" },
  };
  const policy = {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
  };
  function select(...ids: string[]) {
    let state = createWorkbenchState();
    for (const id of ids) {
      const result = reduceWorkbenchAction(bundle, state, {
        type: "select-root",
        assetId: id,
        origin,
      });
      expect(result.accepted).toBe(true);
      state = result.state;
    }
    return state;
  }
  return { bundle, bindings, policy, select };
}
