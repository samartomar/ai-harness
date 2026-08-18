import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_V1_LIMITS,
} from "../../src/governance-doctor/capability-v1.js";
import {
  canonicalGovernanceDoctorProfileV1Bytes,
  createGovernanceDoctorProfileV1,
  governanceDoctorProfileV1Sha256,
  parseGovernanceDoctorProfileV1Json,
} from "../../src/governance-doctor/profile-v1.js";

const root = resolve(__dirname, "..", "..");
const profileSource = readFileSync(resolve(root, "src/governance-doctor/profile-v1.ts"), "utf8");
const capabilitySource = readFileSync(
  resolve(root, "src/governance-doctor/capability-v1.ts"),
  "utf8",
);

/**
 * Unicode fixtures are built from code points rather than written as literals, so
 * this source stays pure ASCII. An invisible literal is unreviewable, and it would
 * itself be hidden Unicode in a file whose whole subject is hidden Unicode.
 */
const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

/** Precomposed U+00E9: already NFC, so this text is accepted verbatim. */
const COMPOSED = `caf${cp(0x00e9)} policy`;
/** "e" + U+0301 combining acute: not NFC, so this text is rejected, never normalized. */
const DECOMPOSED = `cafe${cp(0x0301)} policy`;

function prose(overrides: Record<string, unknown> = {}) {
  return {
    attribution: "catalog:aih/governance-doctor",
    text: "AIH owns the policy decision for this surface.",
    ...overrides,
  };
}

function role(overrides: Record<string, unknown> = {}) {
  return {
    owner: "aih" as const,
    roleId: "policy-owner",
    summary: prose(),
    ...overrides,
  };
}

function prerequisite(overrides: Record<string, unknown> = {}) {
  return {
    note: prose({ text: "A committed effective policy revision must exist." }),
    prerequisiteId: "effective-policy",
    satisfiedBy: "org-policy" as const,
    ...overrides,
  };
}

function conflict(overrides: Record<string, unknown> = {}) {
  return {
    conflictId: "mcp-controls",
    conflictsWithSurfaceId: "surface:aih.mcp-controls",
    note: prose({ text: "Both surfaces claim the same MCP control target." }),
    ...overrides,
  };
}

function profileInput(overrides: Record<string, unknown> = {}) {
  return {
    conflicts: [conflict()],
    diagnosticIds: ["aih.doctor.root", "aih.policy.evaluate"],
    effectVersion: "1",
    guidance: prose({ text: "Run the registered read-only diagnostics before anything else." }),
    nextActionId: "aih.status.root",
    prerequisites: [prerequisite()],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1" as const,
    repairPosture: "guided-only" as const,
    roles: [role()],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.workstation",
    ...overrides,
  };
}

describe("GovernanceDoctorProfileV1 capability allow-list", () => {
  it("registers only AIH-owned read-only diagnostic ids in a frozen, code-unit-ordered list", () => {
    const ids = GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS;
    expect(Object.isFrozen(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids]).toEqual([...ids].sort());
    for (const id of ids) expect(id).toMatch(/^aih\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
  });

  it("excludes every decision, intent, destructive, publication, and provider surface", () => {
    const forbidden =
      /approve|allow|pin|select|adopt|publish|submit|install|uninstall|remove|delete|apply|repair|heal|fix|write|sync|scan|fetch|sign|force|yes/;
    for (const id of GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS)
      expect(id, id).not.toMatch(forbidden);
  });

  it("publishes frozen hard bounds", () => {
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_V1_LIMITS)).toBe(true);
    for (const value of Object.values(GOVERNANCE_DOCTOR_V1_LIMITS)) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("never reaches a filesystem, process, or network capability", () => {
    for (const source of [profileSource, capabilitySource]) {
      expect(source).not.toMatch(
        /node:(?:fs|child_process|net|http|https|dgram|worker_threads|vm)/,
      );
      expect(source).not.toMatch(/\b(?:fetch|execSync|execFileSync|spawnSync|require)\s*\(/);
      expect(source).not.toMatch(/\bprocess\.(?:env|argv|cwd)\b/);
    }
  });

  it("orders exclusively by raw UTF-16 code units, never by locale collation", () => {
    for (const source of [profileSource, capabilitySource]) {
      expect(source).not.toMatch(/localeCompare|\bIntl\b|Collator/);
      expect(source).not.toMatch(/\.sort\(\s*\)/);
    }
  });
});

describe("createGovernanceDoctorProfileV1", () => {
  it("accepts a well-formed profile and mints a domain-separated content hash", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    expect(profile.protocol).toBe("GovernanceDoctorProfileV1");
    expect(profile.governanceDoctorProfileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.surfaceId).toBe("surface:aih.governance-doctor");
    expect(profile.repairPosture).toBe("guided-only");
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.roles)).toBe(true);
    expect(Object.isFrozen(profile.roles[0])).toBe(true);
    expect(Object.isFrozen(profile.roles[0]?.summary)).toBe(true);
  });

  it("separates the profile identity domain from a bare canonical JSON digest", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const bare = createHash("sha256")
      .update(canonicalGovernanceDoctorProfileV1Bytes(profile))
      .digest("hex");
    expect(profile.governanceDoctorProfileSha256).not.toBe(bare);
    expect(governanceDoctorProfileV1Sha256(profile)).toBe(profile.governanceDoctorProfileSha256);
  });

  it("binds identity to every profile field and nested source-attributed field", () => {
    const base = createGovernanceDoctorProfileV1(profileInput()).governanceDoctorProfileSha256;
    const mutations: Record<string, unknown>[] = [
      { surfaceId: "surface:aih.other" },
      { targetId: "target:aih.repository" },
      { repairPosture: "unavailable" },
      { nextActionId: "aih.doctor.root" },
      { diagnosticIds: ["aih.doctor.root"] },
      { schemaVersion: "2" },
      { effectVersion: "2" },
      { profileVersion: "2" },
      { guidance: prose({ text: "Different guidance." }) },
      { guidance: prose({ attribution: "catalog:aih/other" }) },
      { roles: [role({ owner: "operator" })] },
      { roles: [role({ roleId: "operator-owner" })] },
      { roles: [role({ summary: prose({ text: "Different role summary." }) })] },
      { roles: [role({ summary: prose({ attribution: "catalog:aih/other" }) })] },
      { prerequisites: [prerequisite({ satisfiedBy: "operator" })] },
      { prerequisites: [prerequisite({ prerequisiteId: "other-policy" })] },
      { prerequisites: [prerequisite({ note: prose({ text: "Different prerequisite." }) })] },
      { prerequisites: [prerequisite({ note: prose({ attribution: "catalog:aih/other" }) })] },
      { conflicts: [conflict({ conflictId: "other-conflict" })] },
      { conflicts: [conflict({ conflictsWithSurfaceId: "surface:aih.other" })] },
      { conflicts: [conflict({ note: prose({ text: "Different conflict." }) })] },
      { conflicts: [conflict({ note: prose({ attribution: "catalog:aih/other" }) })] },
    ];
    for (const mutation of mutations) {
      const digest = createGovernanceDoctorProfileV1(
        profileInput(mutation),
      ).governanceDoctorProfileSha256;
      expect(digest, JSON.stringify(mutation)).not.toBe(base);
    }
  });

  it("canonicalizes declaration order so equivalent profiles share one identity", () => {
    const forward = createGovernanceDoctorProfileV1(
      profileInput({
        conflicts: [conflict(), conflict({ conflictId: "canon-drift" })],
        diagnosticIds: ["aih.doctor.root", "aih.policy.evaluate"],
        roles: [role(), role({ roleId: "accountable-human", owner: "operator" })],
      }),
    );
    const reversed = createGovernanceDoctorProfileV1(
      profileInput({
        conflicts: [conflict({ conflictId: "canon-drift" }), conflict()],
        diagnosticIds: ["aih.policy.evaluate", "aih.doctor.root"],
        roles: [role({ roleId: "accountable-human", owner: "operator" }), role()],
      }),
    );
    expect(reversed.governanceDoctorProfileSha256).toBe(forward.governanceDoctorProfileSha256);
    expect(reversed.roles.map((item) => item.roleId)).toEqual([
      "accountable-human",
      "policy-owner",
    ]);
  });

  it("sorts by raw UTF-16 code units rather than punctuation-folding collation", () => {
    const profile = createGovernanceDoctorProfileV1(
      profileInput({ roles: [role({ roleId: "ab" }), role({ roleId: "a-b" })] }),
    );
    expect(profile.roles.map((item) => item.roleId)).toEqual(["a-b", "ab"]);
  });

  it("deep copies its input so later mutation cannot alter a minted profile", () => {
    const roles = [role()];
    const input = profileInput({ roles });
    const profile = createGovernanceDoctorProfileV1(input);
    const before = canonicalGovernanceDoctorProfileV1Bytes(profile).toString("utf8");
    roles[0] = role({ roleId: "tampered" });
    (input as { surfaceId: string }).surfaceId = "surface:aih.tampered";
    expect(profile.roles[0]?.roleId).toBe("policy-owner");
    expect(profile.surfaceId).toBe("surface:aih.governance-doctor");
    expect(canonicalGovernanceDoctorProfileV1Bytes(profile).toString("utf8")).toBe(before);
  });

  it("rejects unknown, missing, and mislabeled schema fields", () => {
    expect(() => createGovernanceDoctorProfileV1(profileInput({ extra: 1 }))).toThrow(TypeError);
    const { targetId: _dropped, ...missing } = profileInput();
    expect(() => createGovernanceDoctorProfileV1(missing)).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ protocol: "GovernanceDoctorProfileV2" })),
    ).toThrow(TypeError);
  });

  it("rejects a non-record, array, exotic prototype, proxy, accessor, or symbol-keyed input", () => {
    expect(() => createGovernanceDoctorProfileV1(null)).toThrow(TypeError);
    expect(() => createGovernanceDoctorProfileV1([profileInput()])).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(
        Object.assign(Object.create({ inherited: 1 }), profileInput()),
      ),
    ).toThrow(TypeError);
    expect(() => createGovernanceDoctorProfileV1(new Proxy(profileInput(), {}))).toThrow(TypeError);

    const accessor = profileInput();
    Object.defineProperty(accessor, "surfaceId", {
      configurable: true,
      enumerable: true,
      get: () => "surface:aih.governance-doctor",
    });
    expect(() => createGovernanceDoctorProfileV1(accessor)).toThrow(TypeError);

    const symbolKeyed = profileInput();
    (symbolKeyed as Record<symbol, unknown>)[Symbol("shadow")] = 1;
    expect(() => createGovernanceDoctorProfileV1(symbolKeyed)).toThrow(TypeError);
  });

  it("rejects nested proxies, sparse arrays, and cyclic structures", () => {
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ roles: [new Proxy(role(), {})] })),
    ).toThrow(TypeError);

    const sparse = [role(), role({ roleId: "second" })];
    delete sparse[0];
    expect(() => createGovernanceDoctorProfileV1(profileInput({ roles: sparse }))).toThrow(
      TypeError,
    );

    const cyclic: unknown[] = [role()];
    cyclic.push(cyclic);
    expect(() => createGovernanceDoctorProfileV1(profileInput({ roles: cyclic }))).toThrow(
      TypeError,
    );
  });

  it("rejects every diagnostic id outside the registered read-only allow-list", () => {
    const unregistered = [
      "aih.trust.allow",
      "aih.mcp.approve",
      "aih.marketplace.publish",
      "aih.skill.remove",
      "aih.pack.uninstall",
      "aih.support.issue",
      "aih.trust.scan",
      "npm install",
      "gh issue create",
      "sh -c 'aih doctor'",
      "aih doctor --force",
      "AIH.DOCTOR.ROOT",
      "",
    ];
    for (const id of unregistered) {
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ diagnosticIds: [id] })),
        id,
      ).toThrow(TypeError);
      expect(() => createGovernanceDoctorProfileV1(profileInput({ nextActionId: id })), id).toThrow(
        TypeError,
      );
    }
  });

  it("requires at least one diagnostic id and rejects duplicates", () => {
    expect(() => createGovernanceDoctorProfileV1(profileInput({ diagnosticIds: [] }))).toThrow(
      TypeError,
    );
    expect(() =>
      createGovernanceDoctorProfileV1(
        profileInput({ diagnosticIds: ["aih.doctor.root", "aih.doctor.root"] }),
      ),
    ).toThrow(TypeError);
  });

  it("closes the repair posture so no profile can name a mutator", () => {
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ repairPosture: "mechanical" })),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ repairPosture: "auto-eligible" })),
    ).toThrow(TypeError);
    expect(
      createGovernanceDoctorProfileV1(profileInput({ repairPosture: "unavailable" })).repairPosture,
    ).toBe("unavailable");
  });

  it("has no schema field capable of carrying a command, script, path, or credential", () => {
    const keys = Object.keys(createGovernanceDoctorProfileV1(profileInput()));
    for (const key of keys)
      expect(key, key).not.toMatch(
        /command|argv|shell|script|exec|path|url|endpoint|token|secret|credential/i,
      );
    expect(keys).toContain("nextActionId");
  });

  it("keeps every version string visible even when it is not a supported version", () => {
    const profile = createGovernanceDoctorProfileV1(
      profileInput({ effectVersion: "99", profileVersion: "future", schemaVersion: "2" }),
    );
    expect(profile.schemaVersion).toBe("2");
    expect(profile.effectVersion).toBe("99");
    expect(profile.profileVersion).toBe("future");
  });
});

describe("GovernanceDoctorProfileV1 untrusted prose", () => {
  const hostile: Record<string, string> = {
    "C0 BEL": `run${cp(0x0007)}aih`,
    DEL: `run${cp(0x007f)}aih`,
    "right-to-left override": `run ${cp(0x202e)}aih doctor`,
    "right-to-left isolate": `run ${cp(0x2067)}aih doctor`,
    "pop directional isolate": `run ${cp(0x2069)}aih`,
    "left-to-right mark": `run ${cp(0x200e)}aih`,
    "arabic letter mark": `run ${cp(0x061c)}aih`,
    "zero width space": `run${cp(0x200b)}aih`,
    "zero width joiner": `run${cp(0x200d)}aih`,
    "word joiner": `run${cp(0x2060)}aih`,
    BOM: `run${cp(0xfeff)}aih`,
    "soft hyphen": `run${cp(0x00ad)}aih`,
    "line separator": `run${cp(0x2028)}aih`,
    "paragraph separator": `run${cp(0x2029)}aih`,
    "no-break space": `run${cp(0x00a0)}aih`,
    "ideographic space": `run${cp(0x3000)}aih`,
    newline: "run\naih",
    tab: "run\taih",
    // Quoting delimiters: the Guide renders prose quoted and subordinate, so prose
    // that could close or escape that quoting is refused at the boundary.
    "double quote": 'run "aih" doctor',
    backslash: "run \\u0041 aih",
  };

  it("rejects control, format, and bidi-bearing prose instead of coercing it", () => {
    for (const [label, text] of Object.entries(hostile)) {
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ text }) })),
        label,
      ).toThrow(TypeError);
      expect(
        () =>
          createGovernanceDoctorProfileV1(
            profileInput({ roles: [role({ summary: prose({ text }) })] }),
          ),
        label,
      ).toThrow(TypeError);
    }
  });

  it("rejects lone surrogates and non-NFC prose without normalizing it", () => {
    expect(() =>
      createGovernanceDoctorProfileV1(
        profileInput({ guidance: prose({ text: "run \ud800 aih" }) }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ text: DECOMPOSED }) })),
    ).toThrow(TypeError);
    expect(
      createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ text: COMPOSED }) }))
        .guidance.text,
    ).toBe(COMPOSED);
  });

  it("bounds prose by raw UTF-16 code units and by UTF-8 bytes", () => {
    const units = GOVERNANCE_DOCTOR_V1_LIMITS.maxProseCodeUnits;
    expect(
      createGovernanceDoctorProfileV1(
        profileInput({ guidance: prose({ text: "a".repeat(units) }) }),
      ).guidance.text.length,
    ).toBe(units);
    expect(() =>
      createGovernanceDoctorProfileV1(
        profileInput({ guidance: prose({ text: "a".repeat(units + 1) }) }),
      ),
    ).toThrow(TypeError);

    // One astral code point is two UTF-16 code units: the ceiling is measured raw.
    const astral = cp(0x1d400);
    expect(astral.length).toBe(2);
    expect(
      createGovernanceDoctorProfileV1(
        profileInput({ guidance: prose({ text: astral.repeat(units / 2) }) }),
      ).guidance.text.length,
    ).toBe(units);
    expect(() =>
      createGovernanceDoctorProfileV1(
        profileInput({ guidance: prose({ text: astral.repeat(units / 2 + 1) }) }),
      ),
    ).toThrow(TypeError);

    const bytes = GOVERNANCE_DOCTOR_V1_LIMITS.maxProseUtf8Bytes;
    const wide = cp(0x4e00).repeat(Math.floor(bytes / 3) + 1);
    expect(wide.length).toBeLessThanOrEqual(units);
    expect(Buffer.byteLength(wide, "utf8")).toBeGreaterThan(bytes);
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ text: wide }) })),
    ).toThrow(TypeError);
  });

  it("rejects empty, padded, and unattributed prose", () => {
    for (const text of ["", " ", " padded", "padded "]) {
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ text }) })),
        JSON.stringify(text),
      ).toThrow(TypeError);
    }
    for (const attribution of [
      "",
      "Catalog:X",
      "catalog x",
      "../catalog",
      `catalog:x${cp(0x202e)}`,
    ]) {
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ guidance: prose({ attribution }) })),
        JSON.stringify(attribution),
      ).toThrow(TypeError);
    }
    const { attribution: _dropped, ...unattributed } = prose();
    expect(() => createGovernanceDoctorProfileV1(profileInput({ guidance: unattributed }))).toThrow(
      TypeError,
    );
  });
});

describe("GovernanceDoctorProfileV1 cardinality and identifier bounds", () => {
  it("enforces hard cardinality ceilings on every declared collection", () => {
    const cases = [
      ["roles", GOVERNANCE_DOCTOR_V1_LIMITS.maxRoles, (i: number) => role({ roleId: `r${i}` })],
      [
        "prerequisites",
        GOVERNANCE_DOCTOR_V1_LIMITS.maxPrerequisites,
        (i: number) => prerequisite({ prerequisiteId: `p${i}` }),
      ],
      [
        "conflicts",
        GOVERNANCE_DOCTOR_V1_LIMITS.maxConflicts,
        (i: number) => conflict({ conflictId: `c${i}` }),
      ],
    ] as const;
    for (const [field, max, build] of cases) {
      const atLimit = Array.from({ length: max }, (_unused, index) => build(index));
      const accepted = createGovernanceDoctorProfileV1(
        profileInput({ [field]: atLimit }),
      ) as unknown as Record<string, readonly unknown[]>;
      expect(accepted[field]?.length, field).toBe(max);
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ [field]: [...atLimit, build(max)] })),
        field,
      ).toThrow(TypeError);
      expect(() => createGovernanceDoctorProfileV1(profileInput({ [field]: [] })), field).toThrow(
        TypeError,
      );
    }
  });

  it("rejects duplicate collection member ids", () => {
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ roles: [role(), role()] })),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(
        profileInput({ prerequisites: [prerequisite(), prerequisite()] }),
      ),
    ).toThrow(TypeError);
    expect(() =>
      createGovernanceDoctorProfileV1(profileInput({ conflicts: [conflict(), conflict()] })),
    ).toThrow(TypeError);
  });

  it("rejects malformed identifiers, owners, and version strings", () => {
    for (const surfaceId of [
      "",
      "Surface:x",
      "surface",
      "surface:",
      ":x",
      "surface:x/y",
      "a".repeat(200),
    ])
      expect(() => createGovernanceDoctorProfileV1(profileInput({ surfaceId })), surfaceId).toThrow(
        TypeError,
      );
    for (const roleId of ["", "-lead", "Lead", "lead_role", "a".repeat(200)])
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ roles: [role({ roleId })] })),
        roleId,
      ).toThrow(TypeError);
    for (const owner of ["publisher", "", "AIH", null])
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ roles: [role({ owner })] })),
        String(owner),
      ).toThrow(TypeError);
    for (const satisfiedBy of ["catalog-publisher", "vendor", ""])
      expect(
        () =>
          createGovernanceDoctorProfileV1(
            profileInput({ prerequisites: [prerequisite({ satisfiedBy })] }),
          ),
        satisfiedBy,
      ).toThrow(TypeError);
    for (const schemaVersion of ["", ".1", "1 ", "a".repeat(64), 1])
      expect(
        () => createGovernanceDoctorProfileV1(profileInput({ schemaVersion })),
        String(schemaVersion),
      ).toThrow(TypeError);
  });
});

describe("canonicalGovernanceDoctorProfileV1Bytes / parseGovernanceDoctorProfileV1Json", () => {
  it("round-trips exact canonical UTF-8 bytes", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const bytes = canonicalGovernanceDoctorProfileV1Bytes(profile);
    const parsed = parseGovernanceDoctorProfileV1Json(bytes);
    expect(parsed.governanceDoctorProfileSha256).toBe(profile.governanceDoctorProfileSha256);
    expect(canonicalGovernanceDoctorProfileV1Bytes(parsed).equals(bytes)).toBe(true);
    expect(bytes.toString("utf8")).toBe(
      canonicalStrictJsonBytesV1(JSON.parse(bytes.toString("utf8"))).toString("utf8"),
    );
    expect(profile.governanceDoctorProfileSha256).toBe(
      "b1ffb6a52112ae1eca1b6aac9a8f15d2a0daea7c3e85be6d12e960175a5391d5",
    );
    expect(bytes.toString("base64")).toBe(
      "eyJjb25mbGljdHMiOlt7ImNvbmZsaWN0SWQiOiJtY3AtY29udHJvbHMiLCJjb25mbGljdHNXaXRoU3VyZmFjZUlkIjoic3VyZmFjZTphaWgubWNwLWNvbnRyb2xzIiwibm90ZSI6eyJhdHRyaWJ1dGlvbiI6ImNhdGFsb2c6YWloL2dvdmVybmFuY2UtZG9jdG9yIiwidGV4dCI6IkJvdGggc3VyZmFjZXMgY2xhaW0gdGhlIHNhbWUgTUNQIGNvbnRyb2wgdGFyZ2V0LiJ9fV0sImRpYWdub3N0aWNJZHMiOlsiYWloLmRvY3Rvci5yb290IiwiYWloLnBvbGljeS5ldmFsdWF0ZSJdLCJlZmZlY3RWZXJzaW9uIjoiMSIsImdvdmVybmFuY2VEb2N0b3JQcm9maWxlU2hhMjU2IjoiYjFmZmI2YTUyMTEyYWUxZWNhMWI2YWFjOWE4ZjE1ZDJhMGRhZWE3YzNlODViZTZkMTJlOTYwMTc1YTUzOTFkNSIsImd1aWRhbmNlIjp7ImF0dHJpYnV0aW9uIjoiY2F0YWxvZzphaWgvZ292ZXJuYW5jZS1kb2N0b3IiLCJ0ZXh0IjoiUnVuIHRoZSByZWdpc3RlcmVkIHJlYWQtb25seSBkaWFnbm9zdGljcyBiZWZvcmUgYW55dGhpbmcgZWxzZS4ifSwibmV4dEFjdGlvbklkIjoiYWloLnN0YXR1cy5yb290IiwicHJlcmVxdWlzaXRlcyI6W3sibm90ZSI6eyJhdHRyaWJ1dGlvbiI6ImNhdGFsb2c6YWloL2dvdmVybmFuY2UtZG9jdG9yIiwidGV4dCI6IkEgY29tbWl0dGVkIGVmZmVjdGl2ZSBwb2xpY3kgcmV2aXNpb24gbXVzdCBleGlzdC4ifSwicHJlcmVxdWlzaXRlSWQiOiJlZmZlY3RpdmUtcG9saWN5Iiwic2F0aXNmaWVkQnkiOiJvcmctcG9saWN5In1dLCJwcm9maWxlVmVyc2lvbiI6IjEiLCJwcm90b2NvbCI6IkdvdmVybmFuY2VEb2N0b3JQcm9maWxlVjEiLCJyZXBhaXJQb3N0dXJlIjoiZ3VpZGVkLW9ubHkiLCJyb2xlcyI6W3sib3duZXIiOiJhaWgiLCJyb2xlSWQiOiJwb2xpY3ktb3duZXIiLCJzdW1tYXJ5Ijp7ImF0dHJpYnV0aW9uIjoiY2F0YWxvZzphaWgvZ292ZXJuYW5jZS1kb2N0b3IiLCJ0ZXh0IjoiQUlIIG93bnMgdGhlIHBvbGljeSBkZWNpc2lvbiBmb3IgdGhpcyBzdXJmYWNlLiJ9fV0sInNjaGVtYVZlcnNpb24iOiIxIiwic3VyZmFjZUlkIjoic3VyZmFjZTphaWguZ292ZXJuYW5jZS1kb2N0b3IiLCJ0YXJnZXRJZCI6InRhcmdldDphaWgud29ya3N0YXRpb24ifQ==",
    );
  });

  it("returns a defensive copy of the canonical bytes", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const first = canonicalGovernanceDoctorProfileV1Bytes(profile);
    first.fill(0);
    expect(canonicalGovernanceDoctorProfileV1Bytes(profile).equals(first)).toBe(false);
  });

  it("refuses a forged profile that was never validated by this module", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const forged = JSON.parse(canonicalGovernanceDoctorProfileV1Bytes(profile).toString("utf8"));
    expect(forged.protocol).toBe("GovernanceDoctorProfileV1");
    expect(() => canonicalGovernanceDoctorProfileV1Bytes(forged)).toThrow(TypeError);
    expect(() => governanceDoctorProfileV1Sha256(forged)).toThrow(TypeError);
    expect(() => canonicalGovernanceDoctorProfileV1Bytes({ ...profile })).toThrow(TypeError);
  });

  it("rejects noncanonical, duplicated, commented, and BOM-prefixed transport bytes", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const text = canonicalGovernanceDoctorProfileV1Bytes(profile).toString("utf8");
    expect(() => parseGovernanceDoctorProfileV1Json(Buffer.from(` ${text}`, "utf8"))).toThrow(
      TypeError,
    );
    expect(() =>
      parseGovernanceDoctorProfileV1Json(Buffer.from(`${cp(0xfeff)}${text}`, "utf8")),
    ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorProfileV1Json(Buffer.from(`${text.slice(0, -1)},}`, "utf8")),
    ).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorProfileV1Json(
        Buffer.from(text.replace('{"', '{"protocol":"GovernanceDoctorProfileV1","'), "utf8"),
      ),
    ).toThrow(TypeError);
    expect(() => parseGovernanceDoctorProfileV1Json(Buffer.from("//c\n{}", "utf8"))).toThrow(
      TypeError,
    );
    expect(() => parseGovernanceDoctorProfileV1Json(Buffer.from([0xff, 0xfe]))).toThrow(TypeError);
    expect(() => parseGovernanceDoctorProfileV1Json(42)).toThrow(TypeError);
  });

  it("rejects oversized and deeply nested transport before parsing unknown content", () => {
    const oversized = Buffer.alloc(GOVERNANCE_DOCTOR_V1_LIMITS.maxTransportBytes + 1, 0x20);
    const deeplyNestedUnknown = `{${'"unknown":{'.repeat(33)}"x":0${"}".repeat(33)}}`;
    expect(() => parseGovernanceDoctorProfileV1Json(oversized)).toThrow(TypeError);
    expect(() =>
      parseGovernanceDoctorProfileV1Json(Buffer.from(deeplyNestedUnknown, "utf8")),
    ).toThrow(TypeError);
    expect(profileSource).not.toContain(
      'assertStrictJsonValueV1(input, "governance doctor profile")',
    );
  });

  it("rejects a supplied identity that does not match the recomputed identity", () => {
    const profile = createGovernanceDoctorProfileV1(profileInput());
    const parsed = JSON.parse(canonicalGovernanceDoctorProfileV1Bytes(profile).toString("utf8"));
    parsed.governanceDoctorProfileSha256 = createHash("sha256").update("forged").digest("hex");
    expect(() => parseGovernanceDoctorProfileV1Json(canonicalStrictJsonBytesV1(parsed))).toThrow(
      TypeError,
    );
  });

  it("produces byte-identical output across repeated runs", () => {
    const first = canonicalGovernanceDoctorProfileV1Bytes(
      createGovernanceDoctorProfileV1(profileInput()),
    );
    const second = canonicalGovernanceDoctorProfileV1Bytes(
      createGovernanceDoctorProfileV1(profileInput()),
    );
    expect(first.equals(second)).toBe(true);
  });
});
