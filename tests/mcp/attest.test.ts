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
      "codebase-memory-mcp@0.10.5",
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
    writeKiroConfig(["--no-python-downloads", "--no-env-file", "codebase-memory-mcp@0.10.5"]);
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
      "codebase-memory-mcp@0.10.5",
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

/**
 * A cold uv cache and a server that cannot start on this host both exit non-zero
 * before the handshake, but only one of them speaks first. A package that never
 * resolved cannot emit JSON-RPC at all; a server that answers with an `error`
 * object resolved, ran, and is stating why it refuses to serve — observed on
 * codebase-memory-mcp 0.10.4 refusing its daemon endpoint on a hardened host.
 * Routing that operator to pre-warm a cache that is already warm is remediation
 * advice that cannot work, so the server's own words outrank the inference.
 */
describe("mcpUvxPinAttestationProbe — a server that reports its own startup error", () => {
  const daemonError = JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -32001,
      message:
        "secure daemon endpoint could not be created: DACL entry 1 grants mutation rights to untrusted identity",
    },
  });

  it("surfaces the reported error instead of the --offline/pre-warm narrative", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.10.4",
    ]);
    const run = fakeRunner((argv) =>
      argv[0] === "uvx" ? { code: 1, stdout: `${daemonError}\n` } : undefined,
    );
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.detail).toContain("secure daemon endpoint could not be created");
    expect(check.detail).toContain("-32001");
    expect(check.detail).not.toContain("pre-warm");
    expect(check.detail).not.toContain("cold uv cache");
  });

  it("routes the state to its own code, still advisory rather than a hard fail", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.10.4",
    ]);
    const run = fakeRunner((argv) =>
      argv[0] === "uvx" ? { code: 1, stdout: `${daemonError}\n` } : undefined,
    );
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.verdict).toBe("skip");
    expect(check.code).toBe("mcp.server-startup-error");
  });

  it("bounds and sanitizes the echoed message like every other cross-boundary echo", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.10.4",
    ]);
    const hostile = JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: `\u001b[31mboom\n${"A".repeat(4000)}` },
    });
    const run = fakeRunner((argv) =>
      argv[0] === "uvx" ? { code: 1, stdout: `${hostile}\n` } : undefined,
    );
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    const detail = check.detail ?? "";
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("\n");
    expect(detail).toContain("boom");
    // Bounded, and non-empty — an absent detail must not satisfy the bound.
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.length).toBeLessThan(600);
  });

  it("keeps the pre-warm remedy when the launch dies without saying anything", async () => {
    writeKiroConfig([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "codebase-memory-mcp@0.10.4",
    ]);
    // Non-JSON chatter on stdout is not the server speaking the protocol; the
    // cold-cache inference is still the best available reading.
    const run = fakeRunner((argv) =>
      argv[0] === "uvx" ? { code: 1, stdout: "error: no such package\n" } : undefined,
    );
    const check = await mcpUvxPinAttestationProbe(ctx(run));
    expect(check.code).toBe("mcp.pin-unattested");
    expect(check.detail).toContain("pre-warm");
  });
});
