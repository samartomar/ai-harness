import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { mcpUvxPinAttestationProbe } from "../../src/mcp/attest.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-attest-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(run: Runner): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { attestMcpPins: true },
  };
}

function writeKiroConfig(args: string[]): void {
  mkdirSync(join(root, ".kiro", "settings"), { recursive: true });
  writeFileSync(
    join(root, ".kiro", "settings", "mcp.json"),
    JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "uvx", args } } }),
  );
}

/**
 * The governed pins carry `--offline --no-python-downloads --no-env-file` by
 * design; attestation requires execution. On a workstation without a pre-warmed
 * uv cache the launch exits before the MCP initialize handshake — the exact
 * fresh machine that most wants attestation (6.0.1 field report, New 4). The
 * probe stays an advisory skip, but the detail must name the cause and the
 * one-time remedy instead of a bare exit code.
 */
describe("mcpUvxPinAttestationProbe — offline pins on a cold uv cache", () => {
  it("names the --offline cause and the pre-warm remedy when the launch dies pre-handshake", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.9.0",
    ]);
    const run = fakeRunner((argv) => (argv[0] === "uvx" ? { code: 1, stdout: "" } : undefined));
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.verdict).toBe("skip");
    expect(check.code).toBe("mcp.pin-unattested");
    expect(check.detail).toContain("exited 1 without an initialize response");
    expect(check.detail).toContain("--offline");
    expect(check.detail).toContain("pre-warm");
  });

  it("keeps the plain failure wording for a launcher that does not pin --offline", async () => {
    writeKiroConfig(["--no-python-downloads", "--no-env-file", "codebase-memory-mcp@0.9.0"]);
    const run = fakeRunner((argv) => (argv[0] === "uvx" ? { code: 1, stdout: "" } : undefined));
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.verdict).toBe("skip");
    expect(check.code).toBe("mcp.pin-unattested");
    expect(check.detail).toContain("exited 1 without an initialize response");
    expect(check.detail).not.toContain("pre-warm");
  });

  it("does not add the offline note when the handshake succeeded with a drifted version", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.9.0",
    ]);
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "codebase-memory-mcp", version: "0.10.4" } },
    });
    const run = fakeRunner((argv) =>
      argv[0] === "uvx" ? { code: 0, stdout: `${initialize}\n` } : undefined,
    );
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.verdict).toBe("skip");
    expect(check.code).toBe("mcp.version-drift");
    expect(check.detail).not.toContain("pre-warm");
  });
});
