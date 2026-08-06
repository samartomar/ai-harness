import { describe, expect, it } from "vitest";
import { POLICY_ENGINE_FIELD_CONSUMERS } from "../../src/org-policy/effective.js";
import type { HookRegistration } from "../../src/org-policy/hook-registrar.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import {
  aihDispatcher,
  eccStopRegistrations,
  measuredStopEvent,
  sha256,
} from "./hook-registrar-fixtures.js";

function governedPolicy(governance: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "2026-08-06.1",
      catalog: { reviewed: [], custom: [] },
      ...governance,
    },
  };
}

function superpowersRegistration(): HookRegistration {
  const command = "node ~/.superpowers/hooks/brainstorm-gate.js";
  return {
    id: "superpowers-brainstorm-gate",
    event: "Stop",
    command,
    functionTags: ["brainstorm-gate"],
    spawns: 1,
    owner: {
      kind: "third-party",
      framework: "superpowers",
      declaredControls: [],
      pin: {
        repository: "obra/Superpowers",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: "hooks/brainstorm-gate.js",
        launcherSha256: sha256(command),
        runtimeVersion: "1.0.0",
      },
    },
  };
}

describe("G1 — the policy grammar carries the projector's own registration shape", () => {
  it("accepts hook registrations as a governance sibling field, launchers byte-for-byte", () => {
    const registrations = measuredStopEvent();
    const policy = parseOrgPolicy(governedPolicy({ hookRegistrations: registrations }));
    const parsed = policy.governance?.hookRegistrations;
    expect(parsed).toHaveLength(registrations.length);
    for (const registration of registrations) {
      expect(parsed?.map((entry) => entry.command)).toContain(registration.command);
    }
  });

  it("is additive: a governed policy without the field parses to an empty list at schemaVersion 1", () => {
    const policy = parseOrgPolicy(governedPolicy({}));
    expect(policy.schemaVersion).toBe(1);
    expect(policy.governance?.hookRegistrations).toEqual([]);
  });

  it("refuses a launcher whose hash no longer matches its pin at parse time", () => {
    const [registration] = eccStopRegistrations();
    if (registration === undefined) throw new Error("expected a registration");
    const mutated = { ...registration, command: `${registration.command} --extra` };
    expect(() => parseOrgPolicy(governedPolicy({ hookRegistrations: [mutated] }))).toThrowError(
      /launcher hash .* no longer matches its pin .*drift, not a silent update/,
    );
  });

  it("carries an adoption-emitted unknown owner, hash refusal included", () => {
    const command = "node ~/.mystery/legacy-hook.js";
    const registration: HookRegistration = {
      id: "legacy-stop-hook",
      event: "Stop",
      command,
      functionTags: ["legacy-stop-hook"],
      spawns: 1,
      owner: { kind: "unknown", launcherSha256: sha256(command) },
    };
    const policy = parseOrgPolicy(governedPolicy({ hookRegistrations: [registration] }));
    expect(policy.governance?.hookRegistrations[0]?.owner.kind).toBe("unknown");
    expect(() =>
      parseOrgPolicy(
        governedPolicy({
          hookRegistrations: [{ ...registration, command: `${command} --mutated` }],
        }),
      ),
    ).toThrowError(/launcher hash .* no longer matches its pin/);
  });

  it("refuses a duplicate registration id at parse time", () => {
    const [registration] = eccStopRegistrations();
    if (registration === undefined) throw new Error("expected a registration");
    expect(() =>
      parseOrgPolicy(governedPolicy({ hookRegistrations: [registration, registration] })),
    ).toThrowError(/declared twice/);
  });

  it("refuses unknown keys inside a registration", () => {
    const [registration] = eccStopRegistrations();
    if (registration === undefined) throw new Error("expected a registration");
    expect(() =>
      parseOrgPolicy(
        governedPolicy({ hookRegistrations: [{ ...registration, wrapper: "aih-dispatch" }] }),
      ),
    ).toThrowError();
  });
});

describe("G2 — neither catalog fence moves", () => {
  it("keeps the reviewed catalog fenced to AIH-shipped identities, exact message", () => {
    expect(() =>
      parseOrgPolicy(
        governedPolicy({
          catalog: {
            reviewed: [
              {
                id: "ecc",
                kind: "framework",
                description: "ECC framework intent",
                source: {
                  type: "git",
                  repository: "affaan-m/ECC",
                  commit: "623f2c020f052319657674e4e6c29ab5d0ad566b",
                  tree: "623f2c020f052319657674e4e6c29ab5d0ad566b",
                },
                targets: ["claude"],
                projector: "framework-contract",
                lifecycle: "supported",
                evidence: { record: "ecc-evidence" },
                framework: "ecc",
              },
            ],
            custom: [],
          },
        }),
      ),
    ).toThrowError(
      "reviewed catalog entries must reference an AIH-shipped MCP or AIH-owned hook; organization additions belong in catalog.custom",
    );
  });

  it("keeps custom hook candidates refused, exact message", () => {
    expect(() =>
      parseOrgPolicy(
        governedPolicy({
          catalog: {
            reviewed: [],
            custom: [
              {
                id: "usage-metering",
                kind: "hook",
                description: "AIH usage metering hook",
                source: {
                  type: "hook",
                  handler: "usage-metering",
                  scriptDigest: `sha256:${"a".repeat(64)}`,
                },
                targets: ["claude"],
                projector: "hook-managed-settings",
                lifecycle: "supported",
                evidence: { record: "usage-metering" },
              },
            ],
          },
        }),
      ),
    ).toThrowError(
      "custom hook candidates are unsupported; AIH-owned hooks must use their exact reviewed control",
    );
  });
});

describe("G3 — one framework per policy, mirrored onto hook registrations", () => {
  it("refuses hook registrations drawn from both harnesses at once", () => {
    const [eccRegistration] = eccStopRegistrations();
    if (eccRegistration === undefined) throw new Error("expected a registration");
    expect(() =>
      parseOrgPolicy(
        governedPolicy({ hookRegistrations: [eccRegistration, superpowersRegistration()] }),
      ),
    ).toThrowError(/only one framework may be selected at a time.*ecc and superpowers/);
  });

  it("refuses a hook registration from the harness the selection already excludes", () => {
    const [eccRegistration] = eccStopRegistrations();
    if (eccRegistration === undefined) throw new Error("expected a registration");
    expect(() =>
      parseOrgPolicy(
        governedPolicy({
          externalSelections: [{ framework: "superpowers", items: [] }],
          hookRegistrations: [eccRegistration],
        }),
      ),
    ).toThrowError(/only one framework may be selected at a time.*ecc and superpowers/);
  });

  it("accepts the measured mixed-owner state under a single harness", () => {
    // The 2026-08-06 workstation: ECC, the repository, and AIH all registered
    // on Stop. "repository" is a third-party owner but not a harness, so the
    // one-framework rule must not bar it — only ecc/superpowers exclude each
    // other.
    const policy = parseOrgPolicy(
      governedPolicy({
        externalSelections: [{ framework: "ecc", items: [] }],
        hookRegistrations: [...measuredStopEvent(), aihDispatcher("PreCompact", ["pre-compact"])],
      }),
    );
    expect(policy.governance?.hookRegistrations.length).toBeGreaterThan(0);
  });
});

describe("G5 — every registration leaf is enrolled with an explicit consumer", () => {
  it("states that the projector writes the command verbatim and the resolver never reads it", () => {
    const consumer = POLICY_ENGINE_FIELD_CONSUMERS["governance.hookRegistrations.*.command"];
    expect(consumer).toBeDefined();
    expect(consumer).toContain("verbatim");
    expect(consumer).toContain("never reads");
  });
});
