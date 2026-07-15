import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { mcpResolverLike, mcpResolverPinState } from "../mcp/pins.js";
import { inspectContainedRelativePath } from "./contained-path.js";

export { hasExactPackagePin } from "../mcp/pins.js";

export type RuntimeFindingSeverity = "fail" | "warn" | "info";

export interface RuntimeFinding {
  code: string;
  severity: RuntimeFindingSeverity;
  surface: string;
  message: string;
}

export interface RuntimeInventory {
  root: string;
  mcp: {
    config: "absent" | "present" | "unsafe" | "invalid";
    servers: Array<{
      name: string;
      type: "stdio" | "http" | "unknown";
      command?: string;
      egress?: string;
      credentials?: string;
      supplyChain?: string;
    }>;
  };
  tools: Array<{ name: string; source: string; state: "present" | "absent" | "unsafe" }>;
  processAudit: { state: "skipped"; reason: string };
  workflowLaunchers: Array<{ file: string; line: number; text: string }>;
  findings: RuntimeFinding[];
}

type ContainedText =
  | { state: "absent" }
  | { state: "unsafe" }
  | {
      state: "present";
      text: string;
    };

const TOOL_FOOTPRINTS = [
  { name: "Claude", path: "CLAUDE.md" },
  { name: "Codex", path: "AGENTS.md" },
  { name: "MCP", path: ".mcp.json" },
  { name: "Claude managed settings", path: ".claude/managed-settings.json" },
  { name: "Codex local config", path: ".codex/config.toml" },
] as const;

function readContainedText(root: string, relPath: string): ContainedText {
  const info = inspectContainedRelativePath(root, relPath);
  if (info.state === "absent") return { state: "absent" };
  if (info.state === "unsafe" || info.kind !== "file") return { state: "unsafe" };
  return { state: "present", text: readFileSync(info.realPath, "utf8") };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function envValueLooksSafe(value: string): boolean {
  return /^([A-Za-z]+ )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

function analyzeMcp(root: string, findings: RuntimeFinding[]): RuntimeInventory["mcp"] {
  const read = readContainedText(root, ".mcp.json");
  if (read.state === "absent") return { config: "absent", servers: [] };
  if (read.state === "unsafe") {
    findings.push({
      code: "ai-runtime.mcp-config-unsafe",
      severity: "fail",
      surface: ".mcp.json",
      message: "MCP config is not a contained regular file.",
    });
    return { config: "unsafe", servers: [] };
  }

  const errors: ParseError[] = [];
  const parsed = parse(read.text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const errorName = errors[0] ? printParseErrorCode(errors[0].error) : "Unknown";
    findings.push({
      code: "ai-runtime.mcp-config-invalid",
      severity: "fail",
      surface: ".mcp.json",
      message: `MCP config JSONC is invalid: ${errorName}.`,
    });
    return { config: "invalid", servers: [] };
  }

  const rootObj = objectRecord(parsed);
  const servers = objectRecord(rootObj?.mcpServers);
  if (!servers) return { config: "present", servers: [] };

  const inventory: RuntimeInventory["mcp"]["servers"] = [];
  for (const [name, rawServer] of Object.entries(servers)) {
    const server = objectRecord(rawServer);
    const type = server?.type === "stdio" || server?.type === "http" ? server.type : "unknown";
    const command = typeof server?.command === "string" ? server.command : undefined;
    const args = stringArray(server?.args);
    const env = objectRecord(server?.env);
    inventory.push({
      name,
      type,
      command,
      egress: typeof server?.egress === "string" ? server.egress : undefined,
      credentials: typeof server?.credentials === "string" ? server.credentials : undefined,
      supplyChain: typeof server?.supplyChain === "string" ? server.supplyChain : undefined,
    });

    const resolver = command === undefined ? undefined : mcpResolverLike(command);
    if (type === "stdio" && resolver === "npx" && command !== undefined) {
      if (mcpResolverPinState(command, args, env) !== "pinned") {
        findings.push({
          code: "ai-runtime.npx-unpinned",
          severity: "fail",
          surface: `.mcp.json:${name}`,
          message: "MCP npx launcher must name an exact package version.",
        });
      }
    }

    if (type === "stdio" && resolver === "uvx" && command !== undefined) {
      if (!args.includes("--offline") || !args.includes("--no-env-file")) {
        findings.push({
          code: "ai-runtime.uvx-launcher-unhardened",
          severity: "fail",
          surface: `.mcp.json:${name}`,
          message: "MCP uvx launcher must use offline and no-env-file flags.",
        });
      }
      if (mcpResolverPinState(command, args, env) !== "pinned") {
        findings.push({
          code: "ai-runtime.uvx-unpinned",
          severity: "fail",
          surface: `.mcp.json:${name}`,
          message: "MCP uvx launcher must name an exact package version.",
        });
      }
    }

    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value !== "string" || !envValueLooksSafe(value)) {
        findings.push({
          code: "ai-runtime.mcp-env-literal",
          severity: "fail",
          surface: `.mcp.json:${name}:${key}`,
          message: "MCP env values must be environment placeholders, not literals.",
        });
      }
    }

    const headers = objectRecord(server?.headers);
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (typeof value !== "string" || !envValueLooksSafe(value)) {
        findings.push({
          code: "ai-runtime.mcp-header-literal",
          severity: "fail",
          surface: `.mcp.json:${name}:${key}`,
          message: "MCP header values must be environment placeholders, not literals.",
        });
      }
    }

    if (server?.egress === "third-party") {
      findings.push({
        code: "ai-runtime.third-party-egress",
        severity: "warn",
        surface: `.mcp.json:${name}`,
        message: "MCP server declares third-party egress and needs reviewer visibility.",
      });
    }
  }

  return { config: "present", servers: inventory };
}

function scanWorkflowLaunchers(
  root: string,
  findings: RuntimeFinding[],
): RuntimeInventory["workflowLaunchers"] {
  const workflowRoot = inspectContainedRelativePath(root, ".github/workflows");
  if (workflowRoot.state === "absent") return [];
  if (workflowRoot.state === "unsafe" || workflowRoot.kind !== "directory") {
    findings.push({
      code: "ai-runtime.workflow-root-unsafe",
      severity: "fail",
      surface: ".github/workflows",
      message: "Workflow root is not a contained directory.",
    });
    return [];
  }
  const launchers: RuntimeInventory["workflowLaunchers"] = [];
  for (const entry of readdirSync(workflowRoot.realPath, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ya?ml)$/i.test(entry.name)) continue;
    const rel = `.github/workflows/${entry.name}`;
    const read = readContainedText(root, rel);
    if (read.state !== "present") {
      findings.push({
        code: "ai-runtime.workflow-unsafe",
        severity: "fail",
        surface: rel,
        message: "Workflow file is not a contained regular file.",
      });
      continue;
    }
    const lines = read.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\bnpx\b.*@latest\b/i.test(line) || /\bnpx\b.*\s(latest|next)\b/i.test(line)) {
        const item = { file: rel, line: index + 1, text: line.trim() };
        launchers.push(item);
        findings.push({
          code: "ai-runtime.workflow-mutable-npx",
          severity: "warn",
          surface: `${rel}:${item.line}`,
          message: "Workflow uses a mutable npx launcher; pin or justify before release.",
        });
      }
    });
  }
  return launchers;
}

function toolFootprints(root: string): RuntimeInventory["tools"] {
  return TOOL_FOOTPRINTS.map((tool) => {
    const info = inspectContainedRelativePath(root, tool.path);
    return {
      name: tool.name,
      source: tool.path,
      state: info.state === "unsafe" ? "unsafe" : info.state === "present" ? "present" : "absent",
    };
  });
}

export function buildAiRuntimeInventory(root = process.cwd()): RuntimeInventory {
  const findings: RuntimeFinding[] = [];
  const mcp = analyzeMcp(root, findings);
  const workflowLaunchers = scanWorkflowLaunchers(root, findings);
  return {
    root,
    mcp,
    tools: toolFootprints(root),
    processAudit: {
      state: "skipped",
      reason:
        "Process enumeration is intentionally skipped in the release gate to avoid capturing command lines or secrets.",
    },
    workflowLaunchers,
    findings,
  };
}

export function summarizeRuntimeInventory(inventory: RuntimeInventory): string {
  const fail = inventory.findings.filter((finding) => finding.severity === "fail").length;
  const warn = inventory.findings.filter((finding) => finding.severity === "warn").length;
  const info = inventory.findings.filter((finding) => finding.severity === "info").length;
  return [
    `AI runtime inventory ${fail > 0 ? "failed" : "passed"}: ${inventory.mcp.servers.length} MCP server(s), ${fail} fail, ${warn} warn, ${info} info.`,
    `Process audit: ${inventory.processAudit.state} (${inventory.processAudit.reason})`,
    ...inventory.findings.map(
      (finding) =>
        `- ${finding.severity.toUpperCase()} ${finding.code} ${finding.surface}: ${finding.message}`,
    ),
  ].join("\n");
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const root = argValue(argv, "--root") ?? process.cwd();
  const inventory = buildAiRuntimeInventory(root);
  if (argv.includes("--json")) console.log(JSON.stringify(inventory, null, 2));
  else console.log(summarizeRuntimeInventory(inventory));
  return inventory.findings.some((finding) => finding.severity === "fail") ? 1 : 0;
}

if (basename(process.argv[1] ?? "") === "ai-runtime-inventory.ts") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    });
}
