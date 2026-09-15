import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateOpenCodeRuntimeEvidence,
  type RuntimeEvidenceResult,
} from "../../src/heal/opencode-runtime-evidence.js";
import {
  type OpenCodeRuntimeFixture,
  openCodeRuntimeFixture,
} from "./opencode-runtime-evidence-fixture.js";

const now = "2026-09-13T12:10:00.000Z";
let fixture: OpenCodeRuntimeFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

async function evaluate(
  overrides: Partial<Parameters<typeof evaluateOpenCodeRuntimeEvidence>[0]> = {},
): Promise<RuntimeEvidenceResult> {
  fixture ??= openCodeRuntimeFixture();
  return evaluateOpenCodeRuntimeEvidence({
    root: fixture.root,
    evidencePath: fixture.evidencePath,
    now,
    platform: "linux",
    targetCli: "opencode",
    run: async () => ({ code: 0, stdout: "opencode version 1.18.11\n", stderr: "" }),
    ...overrides,
  });
}

describe("OpenCode runtime evidence current-material binding", () => {
  it("reports one current fixed operation and each shell/MCP restriction separately", async () => {
    const result = await evaluate();
    expect(result).toMatchObject({
      requested: true,
      targetCli: "opencode",
      source: "local-unsigned-observation",
      recordState: "current",
      reasons: [],
      observedAt: "2026-09-13T12:00:00.000Z",
      expiresAt: "2026-09-13T13:00:00.000Z",
      supported: "verified",
      discovered: "verified",
      exercised: "verified",
      restart: "verified",
      enforcement: "verified",
      operation: { server: "fixture", tool: "fixture_probe" },
    });
    expect(result.restrictions).toHaveLength(14);
    expect(result.restrictions).toContainEqual({
      id: "protected-read",
      boundary: "client-shell",
      status: "verified",
    });
    expect(result.restrictions).toContainEqual({
      id: "protected-read",
      boundary: "mcp-subprocess",
      status: "verified",
    });
    expect(fixture?.observation.materials?.map((material) => material.role)).toEqual([
      "sandbox-profile",
      "organization-policy",
      "bubblewrap",
      "seccomp",
      "provider-plugin",
      "mcp-runtime",
      "mcp-fixture",
      "mcp-fixture-config",
      "managed-mcp-manifest",
      "managed-mcp-entry",
    ]);
  });

  it("marks a current observation stale after actual native configuration changes", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(fixture.paths.config, `${readConfig(fixture)}\n`);
    const result = await evaluate();
    expect(result.recordState).toBe("stale");
    expect(result.reasons).toContain("target-binding-changed");
    expect(result.exercised).toBe("unverified");
  });

  it("marks the observation stale when the fixed operation's current canary changes", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(fixture.paths.marker, "CANARY_B\n");
    expect(await evaluate()).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["operation-binding-changed"]),
      exercised: "unverified",
    });
  });

  it("binds managed MCP entry bytes and fails closed when launch authority changes", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(fixture.paths.managedEntry, "changed-managed-entry");
    expect(await evaluate()).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["material-binding-changed"]),
    });

    fixture.cleanup();
    fixture = openCodeRuntimeFixture();
    writeFileSync(fixture.paths.policy, '{"organization":"changed"}\n');
    expect(await evaluate()).toMatchObject({
      recordState: "unavailable",
      reasons: expect.arrayContaining(["sandbox-profile-material-unavailable"]),
      supported: "unverified",
      exercised: "unverified",
    });
  });

  it("does not read or execute paths supplied by the imported observation", async () => {
    fixture = openCodeRuntimeFixture();
    const current = fixture;
    writeFileSync(
      current.evidencePath,
      JSON.stringify({
        ...current.observation,
        client: {
          ...current.observation.client,
          executable: join(current.outside, "missing-client"),
        },
        materials: current.observation.materials?.map((material, index) =>
          index === 0 ? { ...material, path: join(current.outside, "missing-material") } : material,
        ),
      }),
    );
    const calls: Array<{ argv: string[]; options: unknown }> = [];
    const result = await evaluate({
      run: async (argv, options) => {
        calls.push({ argv, options });
        return { code: 0, stdout: "1.18.11\n", stderr: "" };
      },
    });
    expect(result.recordState).toBe("stale");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["client-binding-changed", "material-binding-changed"]),
    );
    expect(calls).toEqual([
      {
        argv: [current.paths.opencode, "--version"],
        options: expect.objectContaining({
          cwd: current.root,
          env: expect.objectContaining({
            PATH: expect.stringContaining(current.outside),
            AIH_ORG_POLICY: current.paths.policy,
          }),
          timeoutMs: 15_000,
          maxBufferBytes: 64 * 1024,
        }),
      },
    ]);
  });

  it("keeps a copied observation for another canonical root stale", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(
      fixture.evidencePath,
      JSON.stringify({
        ...fixture.observation,
        target: { ...fixture.observation.target, canonicalRoot: fixture.outside },
      }),
    );
    expect(await evaluate()).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["target-binding-changed"]),
      exercised: "unverified",
    });
  });

  it("returns actionable unavailable and invalid results without changing local state", async () => {
    fixture = openCodeRuntimeFixture();
    expect(await evaluate({ evidencePath: join(fixture.outside, "missing.json") })).toMatchObject({
      recordState: "unavailable",
      reasons: ["observation-file-unavailable"],
      observedAt: null,
      expiresAt: null,
    });
    writeFileSync(fixture.evidencePath, "not json");
    expect(await evaluate()).toMatchObject({
      recordState: "invalid",
      reasons: ["malformed-observation"],
    });
    expect(await evaluate({ targetCli: "codex" })).toMatchObject({
      recordState: "unavailable",
      reasons: ["opencode-selection-required"],
    });
    expect(await evaluate({ platform: "windows" })).toMatchObject({
      recordState: "unavailable",
      reasons: ["opencode-linux-required"],
    });
  });

  it("retains explicit dates and makes expired or failed observations unverified", async () => {
    fixture = openCodeRuntimeFixture();
    expect(await evaluate({ now: "2026-09-13T13:00:00.000Z" })).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["observation-expired"]),
      observedAt: "2026-09-13T12:00:00.000Z",
      expiresAt: "2026-09-13T13:00:00.000Z",
      exercised: "unverified",
    });
    writeFileSync(
      fixture.evidencePath,
      JSON.stringify({
        ...fixture.observation,
        operation: { ...fixture.observation.operation, succeeded: false },
      }),
    );
    expect(await evaluate()).toMatchObject({
      recordState: "current",
      reasons: expect.arrayContaining(["operation-failed"]),
      exercised: "unverified",
      restart: "unverified",
    });
  });

  it("keeps an incomplete restriction set unverified with an actionable reason", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(
      fixture.evidencePath,
      JSON.stringify({
        ...fixture.observation,
        enforcement: {
          boundary: "mcp-subprocess",
          operation: "legacy write probe",
          denied: true,
          effectAbsent: true,
        },
        restrictions: fixture.observation.restrictions?.slice(0, 1),
      }),
    );
    expect(await evaluate()).toMatchObject({
      recordState: "current",
      reasons: expect.arrayContaining(["restriction-set-incomplete"]),
      enforcement: "unverified",
    });
  });

  it("rejects control characters in imported identifiers before terminal rendering", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(
      fixture.evidencePath,
      JSON.stringify({
        ...fixture.observation,
        server: { ...fixture.observation.server, name: "fixture\u001b[31m" },
      }),
    );
    expect(await evaluate()).toMatchObject({
      recordState: "invalid",
      reasons: ["malformed-observation"],
      operation: null,
    });
  });

  it("marks imported and locally measured client version changes stale", async () => {
    fixture = openCodeRuntimeFixture();
    writeFileSync(
      fixture.evidencePath,
      JSON.stringify({
        ...fixture.observation,
        client: { ...fixture.observation.client, version: "1.18.10" },
      }),
    );
    expect(await evaluate()).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["client-binding-changed"]),
    });
    writeFileSync(fixture.evidencePath, JSON.stringify(fixture.observation));
    expect(
      await evaluate({
        run: async () => ({ code: 0, stdout: "opencode version 1.18.12\n", stderr: "" }),
      }),
    ).toMatchObject({
      recordState: "stale",
      reasons: expect.arrayContaining(["client-binding-changed"]),
    });
  });
});

function readConfig(value: OpenCodeRuntimeFixture): string {
  return JSON.stringify(JSON.parse(readFileSync(value.paths.config, "utf8")));
}
