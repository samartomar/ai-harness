import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTokenSaviorProcessCompactor,
  TOKEN_SAVIOR_RUNTIME_PIN,
  TokenSaviorAuditMcpPolicyGuard,
} from "../../src/ecc-profile/token-savior.js";

const pythonCommand = process.env.AIH_TOKEN_SAVIOR_PYTHON;
const runtimeRoot = process.env.AIH_TOKEN_SAVIOR_RUNTIME_ROOT;
const enabled = Boolean(pythonCommand && runtimeRoot);

describe.skipIf(!enabled)("exact-pinned Token Savior direct compactor", () => {
  it("imports the pure compact function and returns full original evidence", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "aih-token-savior-live-"));
    expect(lstatSync(pythonCommand ?? "").isFile()).toBe(true);
    expect(lstatSync(runtimeRoot ?? "").isDirectory()).toBe(true);
    const compact = createTokenSaviorProcessCompactor({
      pythonCommand: pythonCommand ?? "",
      runtimeRoot: runtimeRoot ?? "",
      tempRoot,
      verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
    });
    const stdout = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,102 +1,102 @@ function sample() {",
      ...Array.from({ length: 100 }, (_, index) => ` unchanged context ${index}`),
      "-return oldValue;",
      "+return newValue;",
    ].join("\n");
    const result = await compact(
      { command: "git diff", stdout, stderr: "" },
      new AbortController().signal,
    ).finally(() => rmSync(tempRoot, { recursive: true, force: true }));

    expect(result).not.toBeNull();
    expect(result?.originalText).toBe(stdout);
    expect(result?.originalBytes).toBe(Buffer.byteLength(stdout));
    expect(result?.text).toContain("+return newValue;");
    expect(result?.compactBytes).toBeLessThan(result?.originalBytes ?? 0);
  });

  it("starts the compact-only audit MCP with only ts_discover and no resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-token-savior-mcp-"));
    const project = join(root, "project");
    const state = join(root, "state");
    const transcripts = join(root, "transcripts");
    mkdirSync(project);
    mkdirSync(state);
    mkdirSync(transcripts);
    const executable = join(
      runtimeRoot ?? "",
      process.platform === "win32" ? "Scripts/token-savior.exe" : "bin/token-savior",
    );
    expect(lstatSync(executable).isFile()).toBe(true);

    try {
      const responses = await new Promise<Map<number, unknown>>((resolve, reject) => {
        const child = spawn(executable, [], {
          cwd: project,
          env: {
            SYSTEMROOT: process.env.SYSTEMROOT,
            SystemRoot: process.env.SystemRoot,
            PATH: process.env.PATH,
            Path: process.env.Path,
            TEMP: root,
            TMP: root,
            HOME: state,
            USERPROFILE: state,
            APPDATA: state,
            LOCALAPPDATA: state,
            XDG_DATA_HOME: state,
            PROJECT_ROOT: project,
            TOKEN_SAVIOR_DATA_DIR: state,
            TS_STATE_ROOT: state,
            TS_TRANSCRIPT_ROOT: transcripts,
            TOKEN_SAVIOR_PROFILE: "compact-only",
            TOKEN_SAVIOR_NO_WARMUP: "1",
            TS_CAPTURE_DISABLED: "1",
            TS_MEMORY_DISABLE: "1",
            TS_RESOURCES_DISABLED: "1",
            TS_THIN_SCHEMAS: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        const found = new Map<number, unknown>();
        let buffer = "";
        let stderr = "";
        let bytes = 0;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let completed = false;
          const complete = () => {
            if (completed) return;
            completed = true;
            if (error) reject(error);
            else resolve(found);
          };
          child.once("close", complete);
          if (!child.kill()) complete();
        };
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                `Token Savior MCP probe timed out${stderr === "" ? "" : `: ${stderr.slice(0, 2_048)}`}`,
              ),
            ),
          20_000,
        );
        child.on("error", () => finish(new Error("Token Savior MCP probe could not start")));
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
        });
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) {
            finish(new Error("Token Savior MCP probe exceeded its output limit"));
            return;
          }
          buffer += chunk.toString("utf8");
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === "") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              finish(new Error("Token Savior MCP probe returned malformed JSON"));
              return;
            }
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              typeof (parsed as { id?: unknown }).id === "number"
            ) {
              found.set((parsed as { id: number }).id, parsed);
              if (found.has(1) && found.has(2)) finish();
            }
          }
        });
        const messages = [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "aih-token-savior-probe", version: "1" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        ];
        child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
      });

      expect(responses.get(1)).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
      const guard = new TokenSaviorAuditMcpPolicyGuard();
      const tools = guard.filterToolsList(
        (responses.get(2) as { result?: unknown } | undefined)?.result,
      );
      expect(responses.get(2)).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
      });
      expect(tools).toMatchObject({ tools: [{ name: "ts_discover" }] });
      expect(tools.tools).toHaveLength(1);
      expect(
        guard.inspectClientRequest({
          jsonrpc: "2.0",
          id: 3,
          method: "resources/list",
          params: {},
        }),
      ).toEqual({
        forward: false,
        response: { jsonrpc: "2.0", id: 3, result: { resources: [] } },
      });
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});
