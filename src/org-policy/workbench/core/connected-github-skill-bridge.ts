import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../contract/strict-json-v1.js";
import { projectWorkbenchPolicy } from "../compile-policy.js";
import type { WorkbenchRootV1 } from "../contracts.js";
import { importWorkbenchPolicySelections } from "../policy-import.js";
import { prepareWorkbenchCatalog } from "../prepared-catalog.js";
import { reduceWorkbenchAction } from "../selection-engine.js";
import type { ResolvedGithubSkillV1 } from "./bounded-github-skill-resolver.js";
import { verifyWorkbenchAuthoringSourceBytesV1 } from "./verification.js";

export interface ConnectedGithubSkillBridgeV1 {
  readonly version: "aih-connected-github-skill-bridge/v1";
  readonly state: "prepared-pending-evidence";
  readonly policy: Record<string, unknown>;
  readonly root: WorkbenchRootV1;
  /** Private Core input used only to render the next connected Workbench page. */
  readonly manifestBytes: readonly string[];
}

function existingManifestBytes(policy: Record<string, unknown>): string[] {
  const raw = policy.authoringSources;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new TypeError("saved authoring sources are malformed");
  return raw.map((source) => verifyWorkbenchAuthoringSourceBytesV1(source).text);
}

function labelFor(resolved: ResolvedGithubSkillV1): string {
  return `Pending security review: ${resolved.skill} from ${resolved.source.repository}@${resolved.source.commit} (saved choice only)`;
}

function manifestFor(resolved: ResolvedGithubSkillV1): { sourceId: string; bytes: string } {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolved.source.repository) ||
    !/^[a-f0-9]{40}$/.test(resolved.source.commit) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(resolved.skill)
  ) {
    throw new TypeError("connected Skill identity is invalid");
  }
  const sourceId = `source:connected-github-skill-${canonicalStrictJsonSha256V1({
    domain: "aih-connected-github-skill-source/v1",
    repository: resolved.source.repository,
    skill: resolved.skill,
    commit: resolved.source.commit,
  })}`;
  return {
    sourceId,
    bytes: canonicalStrictJsonBytesV1({
      version: "organization-authoring-manifest/v1",
      source: {
        id: sourceId,
        revisionId: resolved.source.commit,
        locator: `https://github.com/${resolved.source.repository}`,
      },
      assets: [
        {
          id: `skill:${resolved.skill}`,
          kind: "skill",
          label: labelFor(resolved),
          path: resolved.source.path,
        },
      ],
    }).toString("utf8"),
  };
}

/**
 * Core prepares a declaration-only Skill asset and records a pending source
 * intent. The returned policy has no scan result, approval, target, or install
 * instruction; those remain separate Core workflows.
 */
export function bridgeConnectedGithubSkillV1(
  policy: Record<string, unknown>,
  resolved: ResolvedGithubSkillV1,
): ConnectedGithubSkillBridgeV1 {
  const manifest = manifestFor(resolved);
  const previousManifests = existingManifestBytes(policy);
  const manifestBytes = previousManifests.includes(manifest.bytes)
    ? previousManifests
    : [...previousManifests, manifest.bytes];
  const prepared = prepareWorkbenchCatalog(undefined, {
    organizationManifestBytes: manifestBytes,
  });
  const asset = Object.values(prepared.bundle.assets).find(
    (candidate) =>
      candidate.kind === "skill" &&
      candidate.sourceId === manifest.sourceId &&
      candidate.sourceRevisionId === resolved.source.commit &&
      candidate.originalPath === resolved.source.path &&
      candidate.label === labelFor(resolved),
  );
  if (asset === undefined) throw new TypeError("Core did not prepare the connected Skill asset");
  const source = prepared.bundle.sources[manifest.sourceId];
  if (
    source === undefined ||
    source.id !== manifest.sourceId ||
    source.revision.id !== resolved.source.commit ||
    source.distributor.kind !== "organization" ||
    source.distributor.locator !== `https://github.com/${resolved.source.repository}` ||
    source.upstreamOrigin.kind !== "organization" ||
    source.upstreamOrigin.locator !== `https://github.com/${resolved.source.repository}` ||
    source.inputFormat !== "organization-authoring-manifest/v1"
  ) {
    throw new TypeError("Core did not retain the connected Skill source descriptor");
  }
  if (prepared.sourceInputs[asset.sourceId] === undefined)
    throw new TypeError("Core did not prepare the connected Skill source");

  const imported = importWorkbenchPolicySelections(
    policy,
    prepared.bundle,
    prepared.bindings,
    prepared.sourceInputs,
  );
  if (!imported.accepted)
    throw new TypeError(
      `Current policy cannot retain its saved selections: ${imported.diagnostics.join("; ")}`,
    );
  const existingRoot = imported.state.roots.find(
    (candidate) => candidate.assetId === asset.id && candidate.origin.kind === "administrator",
  );
  const reduced =
    existingRoot === undefined
      ? reduceWorkbenchAction(prepared.bundle, imported.state, {
          type: "select-root",
          assetId: asset.id,
          origin: { kind: "administrator" },
        })
      : { accepted: true as const, state: imported.state };
  if (!reduced.accepted)
    throw new TypeError(
      `Core did not record the connected Skill selection: ${(reduced.diagnostics ?? []).map((item) => item.message).join("; ")}`,
    );
  const projected = projectWorkbenchPolicy(
    policy,
    reduced.state,
    prepared.bundle,
    prepared.bindings,
    "author",
    prepared.sourceInputs,
  );
  if (!projected.accepted)
    throw new TypeError(
      `Core did not project the connected Skill: ${projected.diagnostics.join("; ")}`,
    );
  const root = reduced.state.roots.find((candidate) => candidate.assetId === asset.id);
  if (root === undefined) throw new TypeError("Core did not retain the connected Skill root");
  return {
    version: "aih-connected-github-skill-bridge/v1",
    state: "prepared-pending-evidence",
    policy: projected.policy,
    root,
    manifestBytes,
  };
}
