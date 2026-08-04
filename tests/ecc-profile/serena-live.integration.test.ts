import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildEccMcpProfileProjection,
  CONTEXT7_SUBJECT_SHA256,
  SERENA_ALLOWED_TOOLS,
  SERENA_REQUIRED_TOOLS,
  SerenaMcpPolicyGuard,
} from "../../src/ecc-profile/mcp-profile.js";

const enabled = process.env.AIH_RUN_SERENA_INTEGRATION === "1";
const roots: string[] = [];
const serenaRuntimeRoot = fileURLToPath(
  new URL("../../src/ecc-profile/serena-runtime", import.meta.url),
);

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

async function runClient(client: "claude" | "codex"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `aih-serena-${client}-`));
  roots.push(root);
  const project = join(root, "project");
  const serenaHome = join(root, "serena-home");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(serenaHome, { recursive: true });
  writeFileSync(
    join(project, "src", "sample.ts"),
    "export function exactSymbol(value: number): number { return value + 1; }\n",
    "utf8",
  );
  const projection = buildEccMcpProfileProjection({
    client,
    canonicalWorktree: project,
    serenaHome,
    serenaRuntimeRoot,
    wrapperCommand: join(root, "aih-mcp-wrapper"),
    wrapperSha256: "c".repeat(64),
    serenaDependencyLockSha256: "a".repeat(64),
    context7Attestation: {
      endpoint: "https://mcp.context7.com/mcp",
      subjectSha256: CONTEXT7_SUBJECT_SHA256,
      reviewedAt: "2026-08-03T00:00:00.000Z",
    },
  });
  writeFileSync(join(serenaHome, "serena_config.yml"), projection.serenaConfig, "utf8");

  const executable = process.env.AIH_UV_PATH ?? "uv";
  const child = spawn(
    executable,
    [
      "--frozen",
      "--project",
      serenaRuntimeRoot,
      "serena",
      "start-mcp-server",
      "--context",
      client === "claude" ? "claude-code" : "codex",
      "--mode",
      "no-memories",
      "--project",
      project,
    ],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: root,
        TMP: root,
        UV_CACHE_DIR: join(root, "uv-cache"),
        UV_TOOL_DIR: join(root, "uv-tools"),
        SERENA_HOME: serenaHome,
        SERENA_USAGE_REPORTING: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof response.id === "number") pending.get(response.id)?.(response);
  });
  const request = (id: number, method: string, params: unknown): Promise<JsonRpcResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120_000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(response);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: `aih-${client}-acceptance`, version: "1" },
    });
    expect(initialized.error).toBeUndefined();
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request(2, "tools/list", {});
    expect(listed.error).toBeUndefined();
    const filtered = new SerenaMcpPolicyGuard().filterToolsList(listed.result);
    const names = filtered.tools.map((tool) => tool.name);
    expect(names.every((name) => (SERENA_ALLOWED_TOOLS as readonly string[]).includes(name))).toBe(
      true,
    );
    for (const required of SERENA_REQUIRED_TOOLS) expect(names).toContain(required);
    expect(names).not.toContain("activate_project");
    expect(names).not.toContain("write_memory");
    const symbols = await request(3, "tools/call", {
      name: "get_symbols_overview",
      arguments: { relative_path: "src/sample.ts", depth: 1 },
    });
    expect(symbols.error).toBeUndefined();
    expect(JSON.stringify(symbols.result)).toContain("exactSymbol");
  } finally {
    stdout.close();
    child.stdin.end();
    child.kill();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

describe.skipIf(!enabled)("exact-pinned Serena live acceptance", () => {
  it("initializes the bounded symbolic surface and serves a representative symbol request in both clients", async () => {
    await runClient("claude");
    await runClient("codex");
  }, 300_000);
});
