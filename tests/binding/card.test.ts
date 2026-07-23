import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoMachineLocalPath,
  buildFrameworkCard,
  CARD_SCHEMA_VERSION,
  contextCostCard,
  type DoctorCardInput,
  d18SurfaceLabels,
  deriveSupportLabel,
  type FrameworkCard,
  type FrameworkCardBuildInput,
  FrameworkCardError,
  FrameworkCardSchema,
  frameworkCardPath,
  parseFrameworkCard,
  readFrameworkCard,
  renderFrameworkCard,
  type SupportLabel,
  scanCardIdentity,
  sourceIdentityFromLock,
  writeFrameworkCardAtomic,
} from "../../src/binding/card.js";
import {
  parseLocalVerificationEvidence,
  readLocalVerificationEvidence,
  writeLocalVerificationEvidenceAtomic,
} from "../../src/binding/evidence.js";
import { SUPPORTED_HOST_TUPLE } from "../../src/binding/host-tuple.js";
import type { BindingLock } from "../../src/binding/lock.js";
import type { FrameworkCardDisclosure } from "../../src/binding/scan-gate.js";
import type { BindingSource } from "../../src/binding/schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT = "c".repeat(40);

const GIT_SOURCE: BindingSource = {
  kind: "git",
  repository: "samartomar/ECC",
  commitSha: COMMIT,
  treeDigest: SHA_A,
};

const DISCLOSURE: FrameworkCardDisclosure = {
  rawFindings: {
    total: 3,
    high: 1,
    bySeverity: { info: 0, low: 1, medium: 1, high: 1, critical: 0 },
  },
  closureFindings: { total: 1, high: 1, unknownReachability: 0 },
  inertFindings: { total: 2, high: 0 },
  acceptedRuntimeFindings: { total: 0 },
  visibleTypographyAdvisories: { total: 0, files: 0 },
  residualRisk: { blockingUnaccepted: 0, unknownReachability: 0, inertReported: 2 },
};

function baseInput(overrides: Partial<FrameworkCardBuildInput> = {}): FrameworkCardBuildInput {
  return {
    framework: "ecc",
    scope: "project",
    targetLabel: "STRICT_PROJECT_BINDING_VERIFIED",
    source: GIT_SOURCE,
    installMechanism: "upstream-local-installer",
    ...overrides,
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-binding-card-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FrameworkCard schema + parse", () => {
  it("round-trips a minimal built card through parse -> serialize -> parse", () => {
    const first = buildFrameworkCard(baseInput());
    const second = parseFrameworkCard(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(first.cardVersion).toBe(CARD_SCHEMA_VERSION);
    expect(first.host).toBe("claude");
    expect(first.verifiedHostTuple).toEqual(SUPPORTED_HOST_TUPLE);
  });

  it("round-trips a fully-populated card (scanCache disclosure, cost, all arrays)", () => {
    const card = buildFrameworkCard(
      baseInput({
        mode: "full",
        identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true },
        counts: { skills: 4, agents: 3, commands: 2, rules: 5, hooks: 1, mcpServers: 2 },
        mcpServers: ["github", "context7"],
        scriptsBinariesDeps: [
          "home:.claude/plugins/cache/ecc/ecc",
          ".claude/settings.json#/enabledPlugins/ecc",
        ],
        network: "unspecified",
        update: "disabled",
        telemetry: "disabled",
        lockdown: [
          { key: "telemetry", value: "off" },
          { key: "auto_upgrade", value: "false" },
        ],
        sharedState: [
          { label: "ECC_AGENT_DATA_HOME", kind: "state-dir", note: ".aih/ecc/agent-data" },
        ],
        contextCost: contextCostCard({
          source: "aih-estimate",
          evidence: "aih static tree estimate (bytes/4)",
          projectedTokens: 1234,
          counts: { skills: 4, agents: 3, commands: 2, rules: 5, hooks: 1, mcpServers: 2 },
          totalBytes: 4936,
          estimate: true,
        }).contextCost,
        scanCache: scanCardIdentity({
          rawSourceScan: "FINDINGS_PRESENT",
          selectedProfileGate: "ALLOW_WITH_CONDITIONS",
          disclosure: DISCLOSURE,
          coverage: [
            { dimension: "identity-coverage", status: "missing", reason: "docker unavailable" },
          ],
        }),
        residualRisks: ["residual risk: office-hours obligation"],
        enterpriseDisposition: "label decision: strict",
      }),
    );
    const round = parseFrameworkCard(JSON.parse(JSON.stringify(card)));
    expect(round).toEqual(card);
    expect(round.scanCache?.disclosure).toEqual(DISCLOSURE);
  });

  it("carries scanCache.deepScanKey/runtimeQualKey when the caller supplies them, absent otherwise (Phase-2 §C card wiring)", () => {
    const DEEP = "d".repeat(64);
    const QUAL = "e".repeat(64);
    const withKeys = buildFrameworkCard(
      baseInput({
        scanCache: scanCardIdentity({
          rawSourceScan: "CLEAN",
          selectedProfileGate: "ALLOW",
          disclosure: DISCLOSURE,
          deepScanKey: DEEP,
          runtimeQualKey: QUAL,
        }),
      }),
    );
    expect(withKeys.scanCache?.deepScanKey).toBe(DEEP);
    expect(withKeys.scanCache?.runtimeQualKey).toBe(QUAL);
    // The Phase-2 keys survive the strict zod round-trip (schema drift would fail here).
    expect(parseFrameworkCard(JSON.parse(JSON.stringify(withKeys)))).toEqual(withKeys);

    const withoutKeys = buildFrameworkCard(
      baseInput({
        scanCache: scanCardIdentity({
          rawSourceScan: "CLEAN",
          selectedProfileGate: "ALLOW",
          disclosure: DISCLOSURE,
        }),
      }),
    );
    expect(withoutKeys.scanCache?.deepScanKey).toBeUndefined();
    expect(withoutKeys.scanCache?.runtimeQualKey).toBeUndefined();
  });

  it("is strict — rejects unknown keys", () => {
    const card = buildFrameworkCard(baseInput());
    expect(FrameworkCardSchema.safeParse({ ...card, smuggled: true }).success).toBe(false);
  });

  it("rejects a partial D7 identity (all-or-nothing)", () => {
    const card = buildFrameworkCard(baseInput());
    expect(FrameworkCardSchema.safeParse({ ...card, scannedDigest: SHA_A }).success).toBe(false);
  });

  it("rejects match inconsistent with the digests", () => {
    const card = buildFrameworkCard(
      baseInput({ identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true } }),
    );
    expect(FrameworkCardSchema.safeParse({ ...card, loadedDigest: SHA_B }).success).toBe(false);
  });
});

describe("assertNoMachineLocalPath (H3)", () => {
  it("accepts a card whose only paths are home:-prefixed or repo-relative labels", () => {
    const card = buildFrameworkCard(
      baseInput({
        scriptsBinariesDeps: [
          "home:.claude/settings.json#/extraKnownMarketplaces/ecc",
          ".claude/skills/ecc/SKILL.md",
          "skill:verification-loop",
        ],
        sharedState: [
          { label: "install root", kind: "state-dir", note: "home:.claude/skills/gstack" },
        ],
      }),
    );
    expect(() => assertNoMachineLocalPath(card)).not.toThrow();
  });

  it.each<[string, string]>([
    ["posix absolute", "/home/me/checkout"],
    ["windows drive", "C:\\Users\\me\\checkout"],
    ["tilde home", "~/.claude/skills"],
    ["$HOME", "$HOME/.claude"],
    ["%USERPROFILE%", "%USERPROFILE%\\.claude"],
  ])("rejects a %s embedded in a string field", (_name, bad) => {
    const card = buildFrameworkCard(baseInput());
    expect(() => assertNoMachineLocalPath({ ...card, scriptsBinariesDeps: [bad] })).toThrow(
      FrameworkCardError,
    );
  });

  it("rejects a machine path nested in a shared-state note", () => {
    const card = buildFrameworkCard(baseInput());
    expect(() =>
      assertNoMachineLocalPath({
        ...card,
        sharedState: [{ label: "x", kind: "state-dir", note: "/abs/leak" }],
      }),
    ).toThrow(FrameworkCardError);
  });

  it("fails the build closed when an input carries a machine path", () => {
    expect(() => buildFrameworkCard(baseInput({ scriptsBinariesDeps: ["/abs/leak"] }))).toThrow(
      FrameworkCardError,
    );
  });
});

describe("support-label derivation (H4 / O1)", () => {
  const STRICT: SupportLabel = "STRICT_PROJECT_BINDING_VERIFIED";
  const SHARED: SupportLabel = "PROJECT_SELECTED_SHARED_RUNTIME";

  it("issues STRICT only for a strict-capable target that is contamination-clean AND in-tuple", () => {
    expect(deriveSupportLabel(STRICT, { contaminationClean: true, inTuple: true })).toBe(STRICT);
  });

  it.each<[string, DoctorCardInput | undefined, SupportLabel]>([
    ["contaminated", { contaminationClean: false, inTuple: true }, "PROJECT_BINDING_CONFLICTED"],
    ["off-tuple", { contaminationClean: true, inTuple: false }, "HOST_BINDING_UNVALIDATED"],
    ["absent doctor input", undefined, "PROJECT_BINDING_CONFLICTED"],
  ])("downgrades a strict target when %s", (_name, doctor, expected) => {
    expect(deriveSupportLabel(STRICT, doctor)).toBe(expected);
  });

  it("never promotes a non-strict target to STRICT even when clean and in-tuple", () => {
    expect(deriveSupportLabel(SHARED, { contaminationClean: true, inTuple: true })).toBe(SHARED);
  });

  it("still downgrades a non-strict target when contaminated or off-tuple", () => {
    expect(deriveSupportLabel(SHARED, { contaminationClean: false, inTuple: true })).toBe(
      "PROJECT_BINDING_CONFLICTED",
    );
    expect(deriveSupportLabel(SHARED, { contaminationClean: true, inTuple: false })).toBe(
      "HOST_BINDING_UNVALIDATED",
    );
  });

  it("keeps a DEFERRED (not-yet-provisioned) target deferred", () => {
    expect(deriveSupportLabel("DEFERRED", { contaminationClean: true, inTuple: true })).toBe(
      "DEFERRED",
    );
  });

  it("wires the same rule through buildFrameworkCard.supportLabel", () => {
    const strictCard = buildFrameworkCard(
      baseInput({ doctor: { contaminationClean: true, inTuple: true } }),
    );
    expect(strictCard.supportLabel).toBe(STRICT);
    const previewCard = buildFrameworkCard(baseInput());
    expect(previewCard.supportLabel).toBe("PROJECT_BINDING_CONFLICTED");
    expect(previewCard.targetLabel).toBe(STRICT);
  });
});

describe("renderFrameworkCard (deterministic, sorted)", () => {
  function richCard(): FrameworkCard {
    return buildFrameworkCard(
      baseInput({
        mode: "full",
        identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true },
        mcpServers: ["github", "context7"],
        scriptsBinariesDeps: ["z-label", "a-label", "m-label"],
        lockdown: [
          { key: "telemetry", value: "off" },
          { key: "auto_upgrade", value: "false" },
        ],
        residualRisks: ["zeta risk", "alpha risk"],
      }),
    );
  }

  it("is byte-stable across two renders of the same card", () => {
    const card = richCard();
    expect(renderFrameworkCard(card)).toEqual(renderFrameworkCard(card));
  });

  it("is byte-stable across two independent builds of the same input", () => {
    expect(renderFrameworkCard(richCard())).toEqual(renderFrameworkCard(richCard()));
  });

  it("sorts arrays deterministically regardless of input order", () => {
    const text = renderFrameworkCard(richCard()).join("\n");
    expect(text).toContain("surface labels: a-label, m-label, z-label");
    // lockdown sorted by key: auto_upgrade before telemetry
    expect(text.indexOf("lockdown auto_upgrade")).toBeLessThan(text.indexOf("lockdown telemetry"));
    // residual risks sorted
    expect(text.indexOf("alpha risk")).toBeLessThan(text.indexOf("zeta risk"));
  });

  it("renders the identity, pin, labels, and host tuple", () => {
    const text = renderFrameworkCard(richCard()).join("\n");
    expect(text).toContain("framework: ecc");
    expect(text).toContain("mode: full");
    expect(text).toContain(`pin: samartomar/ECC@${COMMIT}`);
    expect(text).toContain("match: true");
    expect(text).toContain("target label: STRICT_PROJECT_BINDING_VERIFIED");
    expect(text).toContain("verified host tuple: claudeCode 2.1.217 (provenance)");
  });

  it("renders the lock-absent preview line when no identity is present", () => {
    expect(renderFrameworkCard(buildFrameworkCard(baseInput())).join("\n")).toContain(
      "binding lock: absent (not yet provisioned)",
    );
  });
});

describe("shared card fragments (§A.3.1)", () => {
  function lock(): BindingLock {
    return {
      schemaVersion: 1,
      declaration: {
        schemaVersion: 1,
        framework: { id: "ecc", mode: "lean", host: "claude" },
        source: GIT_SOURCE,
      },
      writes: [],
      scannedDigest: SHA_A,
      loadedDigest: SHA_A,
      match: true,
      ownership: [
        {
          kind: "file",
          target: ".claude/skills/ecc/SKILL.md",
          preExisting: { absent: true },
          applied: SHA_B,
          postApplyDigest: SHA_B,
        },
        {
          kind: "json-pointer",
          target: "home:.claude/settings.json#/extraKnownMarketplaces/ecc",
          preExisting: { absent: true },
          applied: { x: 1 },
          postApplyDigest: SHA_B,
        },
      ],
    };
  }

  it("sourceIdentityFromLock recovers the D7 identity", () => {
    expect(sourceIdentityFromLock(lock())).toEqual({
      source: GIT_SOURCE,
      identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true },
    });
  });

  it("d18SurfaceLabels splits repo-relative from home-scoped targets (sorted)", () => {
    expect(d18SurfaceLabels(lock())).toEqual({
      repoRelative: [".claude/skills/ecc/SKILL.md"],
      homeScope: ["home:.claude/settings.json#/extraKnownMarketplaces/ecc"],
    });
  });
});

describe("committed card write/read (O8)", () => {
  it("writes framework-card.json beside the lock and reads it back identically", () => {
    const card = buildFrameworkCard(
      baseInput({ identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true } }),
    );
    writeFrameworkCardAtomic(root, card);
    expect(frameworkCardPath(root)).toBe(join(root, ".aih", "binding", "framework-card.json"));
    expect(readFrameworkCard(root)).toEqual(card);
  });

  it("reports absence when no card exists", () => {
    expect(readFrameworkCard(root)).toBeUndefined();
  });

  it("fails closed on corrupt card JSON", () => {
    writeFrameworkCardAtomic(root, buildFrameworkCard(baseInput()));
    writeFileSync(frameworkCardPath(root), "{ not json");
    expect(() => readFrameworkCard(root)).toThrow(FrameworkCardError);
  });

  it("fails closed on a schema-invalid card", () => {
    writeFrameworkCardAtomic(root, buildFrameworkCard(baseInput()));
    writeFileSync(frameworkCardPath(root), JSON.stringify({ cardVersion: 1 }));
    expect(() => readFrameworkCard(root)).toThrow(FrameworkCardError);
  });

  it("fails closed reading a committed card that carries a machine-local path", () => {
    const card = buildFrameworkCard(baseInput());
    writeFrameworkCardAtomic(root, card);
    writeFileSync(
      frameworkCardPath(root),
      JSON.stringify({ ...card, scriptsBinariesDeps: ["/abs/leak"] }),
    );
    expect(() => readFrameworkCard(root)).toThrow(FrameworkCardError);
  });

  it("refuses to write a card that carries a machine-local path", () => {
    const card = buildFrameworkCard(baseInput());
    expect(() =>
      writeFrameworkCardAtomic(root, { ...card, scriptsBinariesDeps: ["/abs/leak"] }),
    ).toThrow(FrameworkCardError);
  });
});

describe("local verification evidence (§A.4) — abs paths allowed, never in the card", () => {
  const ABS_CHECKOUT =
    process.platform === "win32" ? "C:\\Users\\me\\ecc-checkout" : "/home/me/ecc-checkout";

  function evidence() {
    return parseLocalVerificationEvidence({
      schemaVersion: 1,
      treeDigest: SHA_A,
      framework: "ecc",
      checkoutPath: ABS_CHECKOUT,
      installRoot: `${ABS_CHECKOUT}/.claude`,
      os: { platform: "win32", release: "10.0.26200", arch: "x64" },
      runtime: { node: "24.18.0", bun: "1.3.14", claudeCode: "2.1.217" },
      measuredAt: "2026-07-22T00:00:00.000Z",
      contamination: [{ framework: "gstack", surface: "hooks", detail: "1 leaked hook" }],
      doctorTranscript: [{ code: "binding.contaminated", status: "pass" }],
    });
  }

  it("round-trips an evidence record carrying absolute paths", () => {
    writeLocalVerificationEvidenceAtomic(root, evidence());
    expect(readLocalVerificationEvidence(root, SHA_A)).toEqual(evidence());
  });

  it("reports absence for an unwritten digest", () => {
    expect(readLocalVerificationEvidence(root, SHA_B)).toBeUndefined();
  });

  it("keeps the evidence's absolute paths out of a card for the same binding", () => {
    writeLocalVerificationEvidenceAtomic(root, evidence());
    const card = buildFrameworkCard(
      baseInput({ identity: { scannedDigest: SHA_A, loadedDigest: SHA_A, match: true } }),
    );
    expect(() => assertNoMachineLocalPath(card)).not.toThrow();
    expect(JSON.stringify(card)).not.toContain(ABS_CHECKOUT);
    // the two records share the treeDigest identity
    expect(card.scannedDigest).toBe(readLocalVerificationEvidence(root, SHA_A)?.treeDigest);
  });
});
