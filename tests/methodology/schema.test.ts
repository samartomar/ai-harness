import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type MethodologyProposal,
  parseMethodologyProposal,
} from "../../src/methodology/schema.js";

function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      id: "gstack",
      kind: "hybrid-runtime",
      source: {
        type: "local-git",
        repository: "garrytan/gstack",
        root: "C:/research/gstack",
        requestedRef: "v1.2.0",
        resolvedCommit: "a".repeat(40),
      },
      adapter: {
        id: "builtin:gstack",
        contractVersion: 1,
        implementationHash: "b".repeat(64),
      },
    },
    host: {
      id: "codex",
      version: "0.144.1",
      build: "cbacbb97",
      contractVersion: "codex-0.144.1-windows-x64-v1",
      coverage: "partial",
      scope: "project",
      isolationMode: "profile-home",
      operatingSystem: "windows",
      operatingSystemVersion: "10.0.26200",
      architecture: "x64",
      runtimes: { node: "24.13.1", npm: "11.8.0" },
    },
    policyVersion: "enterprise-core-v1",
    ...over,
  };
}

describe("methodology proposal schema", () => {
  it("parses an exact provider, adapter, host, OS, and runtime tuple", () => {
    const parsed = parseMethodologyProposal(proposal());

    expect(parsed).toMatchObject({
      provider: {
        source: { resolvedCommit: "a".repeat(40) },
        adapter: { implementationHash: "b".repeat(64) },
      },
      host: { coverage: "partial", isolationMode: "profile-home" },
    });
    expectTypeOf(parsed).toEqualTypeOf<MethodologyProposal>();
  });

  it.each([
    ["short commit", { resolvedCommit: "deadbeef" }],
    ["floating commit", { resolvedCommit: "main" }],
    ["control character", { requestedRef: "release\u0000candidate" }],
    ["malformed repository", { repository: "../gstack" }],
    ["relative source root", { root: "research/gstack" }],
  ])("rejects a source with %s", (_label, sourceOverride) => {
    const value = proposal();
    const provider = value.provider as Record<string, unknown>;
    provider.source = { ...(provider.source as object), ...sourceOverride };

    expect(() => parseMethodologyProposal(value)).toThrow();
  });

  it.each([
    ["provider", { surprise: true }],
    ["host", { surprise: true }],
  ])("rejects unknown %s fields", (field, extra) => {
    const value = proposal();
    value[field] = { ...(value[field] as object), ...extra };

    expect(() => parseMethodologyProposal(value)).toThrow();
  });

  it("rejects unknown enum values and empty runtime maps", () => {
    expect(() =>
      parseMethodologyProposal(
        proposal({ host: { ...(proposal().host as object), coverage: "best-effort" } }),
      ),
    ).toThrow();
    expect(() =>
      parseMethodologyProposal(
        proposal({ host: { ...(proposal().host as object), runtimes: {} } }),
      ),
    ).toThrow();
  });

  it("accepts no future intent and strictly validates supplied intent", () => {
    expect(parseMethodologyProposal(proposal())).not.toHaveProperty("intent");

    const withIntent = proposal({
      intent: {
        selectedBy: "operator",
        selectedAt: "2026-07-15T00:00:00.000Z",
        reason: "Evaluate exact source",
      },
    });
    expect(parseMethodologyProposal(withIntent).intent?.selectedBy).toBe("operator");

    const invalidIntent = proposal({
      intent: {
        selectedBy: "operator",
        selectedAt: "yesterday",
        reason: "Evaluate exact source",
        surprise: true,
      },
    });
    expect(() => parseMethodologyProposal(invalidIntent)).toThrow();
  });
});
