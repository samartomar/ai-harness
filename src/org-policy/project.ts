import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AIH_CONFIG_FILE,
  AihConfigSchema,
  isActiveManagedMcpProjectionOwnership,
  type ManagedMcpProjectionOwnership,
  managedMcpProjectionConfigJsonFromRaw,
  managedMcpProjectionOwnership,
  revokedManagedMcpProjectionOwnership,
} from "../config/marker.js";
import { readIfExists } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import { type Action, type PlanContext, type WriteAction, writeJson } from "../internals/plan.js";
import {
  managedMcpAllowlistSettings,
  matchesManagedMcpProjectionOwnership,
} from "../mcp/allowlist.js";
import { managedMcpExample } from "../mcp/enterprise.js";
import { mcpServers, type StdioServer } from "../mcp/servers.js";
import { scanRepo } from "../profile/scan.js";
import { composeOrgPolicy } from "./compose.js";
import type { OrgPolicy } from "./schema.js";

function commandPolicyFor(composed: ReturnType<typeof composeOrgPolicy>): Record<string, unknown> {
  return {
    deny: composed.command.deny.map((rule) => ({ pattern: rule.pattern, reason: rule.reason })),
    ask: composed.command.ask.map((rule) => ({ pattern: rule.pattern, reason: rule.reason })),
    safeReadOnly: composed.command.safe_read_only.map((rule) => rule.pattern),
    safeVerification: composed.command.safe_verification.map((rule) => rule.pattern),
  };
}

function stdioAllowedServers(
  ctx: PlanContext,
  allowed: readonly string[],
  disabled: readonly string[],
  enforceAllowlist: boolean,
): Record<string, StdioServer> {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const catalog = mcpServers("project", stack);
  const allowedSet = new Set(allowed);
  const disabledSet = new Set(disabled);
  const out: Record<string, StdioServer> = {};
  for (const [name, server] of Object.entries(catalog)) {
    if (
      disabledSet.has(name) ||
      (enforceAllowlist && !allowedSet.has(name)) ||
      server.type !== "stdio"
    )
      continue;
    out[name] = server;
  }
  return out;
}

function managedSettings(
  ctx: PlanContext,
  policy: OrgPolicy,
): {
  settings: Record<string, unknown>;
  managedMcp: Record<string, unknown>;
  managedMcpEnabled: boolean;
  managedMcpSettings: ReturnType<typeof managedMcpAllowlistSettings>;
} {
  const composed = composeOrgPolicy(policy);
  const stdio = stdioAllowedServers(
    ctx,
    composed.mcp.allowedServers,
    composed.mcp.disabledServers,
    composed.mcp.allowManagedOnly,
  );
  const settings: Record<string, unknown> = {
    organizationPolicy: {
      minimumPosture: composed.minimumPosture,
      references: composed.references,
    },
    sandbox: {
      commandPolicy: commandPolicyFor(composed),
    },
  };
  const managedMcpSettings = managedMcpAllowlistSettings(stdio);
  if (composed.mcp.allowManagedOnly) Object.assign(settings, managedMcpSettings);
  return {
    settings,
    managedMcp: managedMcpExample(stdio),
    managedMcpEnabled: composed.mcp.allowManagedOnly,
    managedMcpSettings,
  };
}

function withExpectedContents(action: WriteAction, contents: string | undefined): WriteAction {
  return {
    ...action,
    expect:
      contents === undefined
        ? { absent: true }
        : { sha256: createHash("sha256").update(contents, "utf8").digest("hex") },
  };
}

function managedMcpProjectionOwnershipOnDisk(ctx: PlanContext):
  | {
      ownership: ManagedMcpProjectionOwnership;
      matches: boolean;
      markerSource: string | undefined;
      settingsSource: string | undefined;
    }
  | undefined {
  const markerSource = readIfExists(join(ctx.root, AIH_CONFIG_FILE));
  let ownership: ManagedMcpProjectionOwnership | undefined;
  try {
    ownership =
      markerSource === undefined
        ? undefined
        : AihConfigSchema.parse(JSON.parse(markerSource)).managedMcpProjection;
  } catch {
    return undefined;
  }
  if (!isActiveManagedMcpProjectionOwnership(ownership)) return undefined;
  const settingsSource = readIfExists(join(ctx.root, ".claude", "managed-settings.json"));
  if (settingsSource === undefined) {
    return { ownership, matches: false, markerSource, settingsSource };
  }
  try {
    return {
      ownership,
      matches: matchesManagedMcpProjectionOwnership(parseJsoncText(settingsSource), ownership),
      markerSource,
      settingsSource,
    };
  } catch {
    return { ownership, matches: false, markerSource, settingsSource };
  }
}

function managedMcpProjectionOwnershipAction(
  ctx: PlanContext,
  generated: ReturnType<typeof managedMcpAllowlistSettings>,
): Action {
  const source = readIfExists(join(ctx.root, AIH_CONFIG_FILE));
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      managedMcpProjectionConfigJsonFromRaw(
        source,
        ctx.contextDir,
        ctx.targets ?? ["claude"],
        managedMcpProjectionOwnership(generated),
      ),
      "record Claude managed-MCP projection ownership",
      { merge: true },
    ),
    source,
  );
}

function clearManagedMcpProjectionOwnershipAction(source: string | undefined): Action {
  return withExpectedContents(
    writeJson(AIH_CONFIG_FILE, {}, "clear Claude managed-MCP projection ownership", {
      merge: true,
      removeJsonTopLevelKeys: ["managedMcpProjection"],
    }),
    source,
  );
}

function revokeManagedMcpProjectionOwnershipAction(
  ownership: ManagedMcpProjectionOwnership,
  source: string | undefined,
): Action {
  return withExpectedContents(
    writeJson(
      AIH_CONFIG_FILE,
      { managedMcpProjection: revokedManagedMcpProjectionOwnership(ownership) },
      "revoke Claude managed-MCP projection ownership after operator change",
      { merge: true },
    ),
    source,
  );
}

export function orgPolicyProjectionActions(ctx: PlanContext, policy: OrgPolicy): Action[] {
  const posture = ctx.posture ?? policy.minimumPosture;
  if (posture === "vibe") return [];
  const { settings, managedMcp, managedMcpEnabled, managedMcpSettings } = managedSettings(
    ctx,
    policy,
  );
  const owned = managedMcpEnabled
    ? managedMcpProjectionOwnershipAction(ctx, managedMcpSettings)
    : undefined;
  const onDisk = managedMcpEnabled ? undefined : managedMcpProjectionOwnershipOnDisk(ctx);
  const settingsSource =
    onDisk?.settingsSource ?? readIfExists(join(ctx.root, ".claude", "managed-settings.json"));
  const actions: Action[] = [
    withExpectedContents(
      writeJson(
        ".claude/managed-settings.json",
        settings,
        "project managed-settings compiled from aih-org-policy.json",
        {
          merge: true,
          replaceJsonKeys: managedMcpEnabled
            ? ["allowManagedMcpServersOnly", "allowedMcpServers"]
            : undefined,
          removeJsonTopLevelKeys: onDisk?.matches
            ? ["allowManagedMcpServersOnly", "allowedMcpServers"]
            : undefined,
        },
      ),
      settingsSource,
    ),
  ];
  if (owned !== undefined) actions.push(owned);
  else if (onDisk !== undefined) {
    actions.push(
      onDisk.matches
        ? clearManagedMcpProjectionOwnershipAction(onDisk.markerSource)
        : revokeManagedMcpProjectionOwnershipAction(onDisk.ownership, onDisk.markerSource),
    );
  }
  if (posture === "enterprise") {
    actions.push(
      writeJson(
        "managed-settings.json.example",
        settings,
        "org admin: system-path managed-settings.json example compiled from aih-org-policy.json",
      ),
      writeJson(
        "managed-mcp.json.example",
        managedMcp,
        "org admin: system-path managed-mcp.json example compiled from aih-org-policy.json",
      ),
    );
  }
  return actions;
}
