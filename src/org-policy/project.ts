import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, type PlanContext, writeJson } from "../internals/plan.js";
import { managedMcpAllowlistSettings } from "../mcp/allowlist.js";
import { managedMcpExample } from "../mcp/enterprise.js";
import {
  clearManagedMcpProjectionOwnershipAction,
  MANAGED_MCP_PROJECTION_KEYS,
  MANAGED_SETTINGS_PATH,
  managedMcpProjectionOnDisk,
  managedMcpProjectionOwnershipAction,
  revokeManagedMcpProjectionOwnershipAction,
  withExpectedContents,
} from "../mcp/managed-projection.js";
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

export function orgPolicyProjectionActions(ctx: PlanContext, policy: OrgPolicy): Action[] {
  const posture = ctx.posture ?? policy.minimumPosture;
  if (posture === "vibe") return [];
  const { settings, managedMcp, managedMcpEnabled, managedMcpSettings } = managedSettings(
    ctx,
    policy,
  );
  const owned = managedMcpEnabled
    ? managedMcpProjectionOwnershipAction(ctx, ctx.targets ?? ["claude"], managedMcpSettings)
    : undefined;
  // The deactivation branch reuses the shared managed-MCP lifecycle
  // (`src/mcp/managed-projection.ts`), but folds the key subtraction into the
  // managed-settings write this projection already emits — the executor collapses
  // repeated writes to one path, so a second write action would be dropped.
  const onDisk = managedMcpEnabled ? undefined : managedMcpProjectionOnDisk(ctx.root);
  const settingsSource =
    onDisk?.settingsSource ?? readIfExists(join(ctx.root, ".claude", "managed-settings.json"));
  const actions: Action[] = [
    withExpectedContents(
      writeJson(
        MANAGED_SETTINGS_PATH,
        settings,
        "project managed-settings compiled from aih-org-policy.json",
        {
          merge: true,
          replaceJsonKeys: managedMcpEnabled ? [...MANAGED_MCP_PROJECTION_KEYS] : undefined,
          removeJsonTopLevelKeys: onDisk?.matches ? [...MANAGED_MCP_PROJECTION_KEYS] : undefined,
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
