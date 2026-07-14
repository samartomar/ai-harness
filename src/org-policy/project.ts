import { type Action, type PlanContext, writeJson } from "../internals/plan.js";
import { managedMcpAllowlistSettings } from "../mcp/allowlist.js";
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
  if (composed.mcp.allowManagedOnly) {
    Object.assign(settings, managedMcpAllowlistSettings(stdio));
  }
  return {
    settings,
    managedMcp: managedMcpExample(stdio),
    managedMcpEnabled: composed.mcp.allowManagedOnly,
  };
}

export function orgPolicyProjectionActions(ctx: PlanContext, policy: OrgPolicy): Action[] {
  const posture = ctx.posture ?? policy.minimumPosture;
  if (posture === "vibe") return [];
  const { settings, managedMcp, managedMcpEnabled } = managedSettings(ctx, policy);
  const actions: Action[] = [
    writeJson(
      ".claude/managed-settings.json",
      settings,
      "project managed-settings compiled from aih-org-policy.json",
      {
        merge: true,
        replaceJsonKeys: managedMcpEnabled ? ["allowedMcpServers"] : undefined,
        removeJsonTopLevelKeys: managedMcpEnabled
          ? undefined
          : ["allowManagedMcpServersOnly", "allowedMcpServers"],
      },
    ),
  ];
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
