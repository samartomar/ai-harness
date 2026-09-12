import { describe, expect, it } from "vitest";
import {
  evaluateMcpRuntimeObservation,
  type McpRuntimeBindings,
  type McpRuntimeObservationV1,
} from "../../src/heal/mcp-runtime-evidence.js";

const bindings: McpRuntimeBindings = {
  client: {
    targetCli: "codex",
    executable: "C:\\tools\\codex.exe",
    version: "0.153.1",
    sha256: "a".repeat(64),
  },
  target: {
    canonicalRoot: "C:\\fixtures\\consumer",
    configPath: "C:\\fixtures\\consumer\\.codex\\config.toml",
    configSha256: "b".repeat(64),
  },
  policy: { approvalPolicy: "never", sandbox: "read-only", networkAccess: false },
  server: {
    name: "memory",
    fixtureIdentity: `sha256:${"c".repeat(64)}`,
    runtimeIdentity: `sha256:${"d".repeat(64)}`,
    cacheIdentity: `sha256:${"e".repeat(64)}`,
  },
  invocation: { tool: "get_code_snippet", argumentsSha256: "f".repeat(64) },
};

function observation(overrides: Partial<McpRuntimeObservationV1> = {}): McpRuntimeObservationV1 {
  return {
    schemaVersion: 1,
    kind: "aih-mcp-runtime-observation",
    ...bindings,
    observedAt: "2026-09-12T05:00:00.000Z",
    expiresAt: "2026-09-19T05:00:00.000Z",
    support: { nativeClientStarted: true, configuredServerRecognized: true },
    discovery: { serverConnected: true, tool: "get_code_snippet", toolListed: true },
    operation: {
      expectedCanary: "canary-41",
      actualCanary: "canary-41",
      succeeded: true,
      sessionId: "session-one",
    },
    restart: {
      actualCanary: "canary-41",
      succeeded: true,
      sessionId: "session-two",
      observedAt: "2026-09-12T05:05:00.000Z",
    },
    enforcement: {
      boundary: "mcp-subprocess",
      operation: "write outside fixture",
      denied: true,
      effectAbsent: true,
    },
    ...overrides,
  };
}

const now = "2026-09-12T06:00:00.000Z";
const restart = (): NonNullable<McpRuntimeObservationV1["restart"]> => ({
  actualCanary: "canary-41",
  succeeded: true,
  sessionId: "session-two",
  observedAt: "2026-09-12T05:05:00.000Z",
});
const enforcement = (): NonNullable<McpRuntimeObservationV1["enforcement"]> => ({
  boundary: "mcp-subprocess",
  operation: "write outside fixture",
  denied: true,
  effectAbsent: true,
});

describe("MCP runtime observation V1", () => {
  it("keeps supported, discovered, exercised, restart and MCP enforcement distinct", () => {
    expect(evaluateMcpRuntimeObservation(observation(), bindings, now)).toEqual({
      recordState: "current",
      reasons: [],
      supported: "verified",
      discovered: "verified",
      exercised: "verified",
      restart: "verified",
      enforcement: "verified",
    });
  });

  it.each([
    ["client executable", { client: { ...bindings.client, executable: "C:\\other\\codex.exe" } }],
    ["client version", { client: { ...bindings.client, version: "0.154.0" } }],
    ["client hash", { client: { ...bindings.client, sha256: "c".repeat(64) } }],
    ["root", { target: { ...bindings.target, canonicalRoot: "C:\\fixtures\\other" } }],
    [
      "config path",
      { target: { ...bindings.target, configPath: "C:\\fixtures\\other\\config.toml" } },
    ],
    ["config hash", { target: { ...bindings.target, configSha256: "d".repeat(64) } }],
    ["policy", { policy: { ...bindings.policy, networkAccess: true } }],
    ["fixture", { server: { ...bindings.server, fixtureIdentity: `sha256:${"1".repeat(64)}` } }],
    [
      "server runtime",
      { server: { ...bindings.server, runtimeIdentity: `sha256:${"2".repeat(64)}` } },
    ],
    ["cache", { server: { ...bindings.server, cacheIdentity: `sha256:${"3".repeat(64)}` } }],
    [
      "tool",
      {
        invocation: { ...bindings.invocation, tool: "search_code" },
        discovery: { ...observation().discovery, tool: "search_code" },
      },
    ],
    ["arguments", { invocation: { ...bindings.invocation, argumentsSha256: "4".repeat(64) } }],
  ])("marks a material %s mismatch stale", (_label, changed) => {
    const result = evaluateMcpRuntimeObservation(observation(changed), bindings, now);
    expect(result.recordState).toBe("stale");
    expect(result.exercised).toBe("unverified");
  });

  it("marks an expired observation stale", () => {
    expect(
      evaluateMcpRuntimeObservation(observation(), bindings, "2026-09-20T00:00:00.000Z")
        .recordState,
    ).toBe("stale");
  });

  it.each([
    ["unknown field", { ...observation(), extra: true }],
    ["future observation", observation({ observedAt: "2026-09-13T00:00:00.000Z" })],
    ["reversed deadline", observation({ expiresAt: "2026-09-11T00:00:00.000Z" })],
    [
      "future restart",
      observation({ restart: { ...restart(), observedAt: "2026-09-13T00:00:00.000Z" } }),
    ],
    ["invalid hash", observation({ client: { ...bindings.client, sha256: "no" } })],
    ["unknown version", observation({ client: { ...bindings.client, version: "unknown" } })],
    [
      "path control character",
      observation({ target: { ...bindings.target, configPath: "C:\\fixture\nconfig.toml" } }),
    ],
  ])("rejects %s as invalid", (_label, input) => {
    expect(evaluateMcpRuntimeObservation(input, bindings, now).recordState).toBe("invalid");
  });

  it("rejects fabricated or unavailable current material bindings", () => {
    const unavailable = {
      ...bindings,
      client: { ...bindings.client, sha256: "unavailable" },
    } as McpRuntimeBindings;
    expect(evaluateMcpRuntimeObservation(observation(), unavailable, now).recordState).toBe(
      "invalid",
    );
  });

  it("accepts canonical UNC paths and rejects Windows root-relative paths", () => {
    const uncBindings: McpRuntimeBindings = {
      ...bindings,
      target: {
        ...bindings.target,
        canonicalRoot: "\\\\server\\share\\consumer",
        configPath: "\\\\server\\share\\consumer\\.codex\\config.toml",
      },
    };
    expect(
      evaluateMcpRuntimeObservation(observation({ target: uncBindings.target }), uncBindings, now)
        .recordState,
    ).toBe("current");
    expect(
      evaluateMcpRuntimeObservation(
        observation({ target: { ...bindings.target, canonicalRoot: "\\consumer" } }),
        bindings,
        now,
      ).recordState,
    ).toBe("invalid");
  });

  it("does not accept a success flag when the operation canary differs", () => {
    const result = evaluateMcpRuntimeObservation(
      observation({ operation: { ...observation().operation, actualCanary: "wrong" } }),
      bindings,
      now,
    );
    expect(result.recordState).toBe("current");
    expect(result.exercised).toBe("unverified");
    expect(result.restart).toBe("unverified");
  });

  it("rejects a listed tool that differs from the invoked tool binding", () => {
    const result = evaluateMcpRuntimeObservation(
      observation({ discovery: { ...observation().discovery, tool: "search_code" } }),
      bindings,
      now,
    );
    expect(result.recordState).toBe("invalid");
    expect(result.exercised).toBe("unverified");
  });

  it("requires a distinct successful restart session with the same canary", () => {
    const result = evaluateMcpRuntimeObservation(
      observation({ restart: { ...restart(), sessionId: "session-one" } }),
      bindings,
      now,
    );
    expect(result.exercised).toBe("verified");
    expect(result.restart).toBe("unverified");
  });

  it("does not treat a client shell denial as MCP subprocess enforcement", () => {
    const result = evaluateMcpRuntimeObservation(
      observation({ enforcement: { ...enforcement(), boundary: "client-shell" } }),
      bindings,
      now,
    );
    expect(result.enforcement).toBe("unverified");
    expect(result.exercised).toBe("verified");
  });

  it("does not infer later stages from support alone", () => {
    const result = evaluateMcpRuntimeObservation(
      observation({
        discovery: { ...observation().discovery, toolListed: false },
        operation: { ...observation().operation, succeeded: false },
        restart: undefined,
        enforcement: undefined,
      }),
      bindings,
      now,
    );
    expect(result.supported).toBe("verified");
    expect(result.discovered).toBe("unverified");
    expect(result.exercised).toBe("unverified");
    expect(result.restart).toBe("unverified");
    expect(result.enforcement).toBe("unverified");
  });
});
