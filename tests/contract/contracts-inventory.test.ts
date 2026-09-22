import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DECISION_SCHEMA_DIGESTS_V2,
  GOVERNANCE_INPUT_V1_FORMAT,
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  MAX_GOVERNANCE_INPUT_BYTES_V1,
  MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1,
  MAX_UPSTREAM_ARTIFACT_FILES_V1,
  MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1,
  MAX_UPSTREAM_OBSERVATION_WINDOW_MS,
  ORGANIZATION_EVIDENCE_ENVELOPE_V1_FORMAT,
  SUPPORTED_CLIS,
  UPSTREAM_ARTIFACT_MANIFEST_V1_FORMAT,
  UPSTREAM_OBSERVATION_RECEIPT_V1_FORMAT,
} from "../../src/index.js";

/**
 * CONTRACTS.md is prose, and prose drifts. Every `file:line` it cites is pinned
 * here to the text that line must still hold, every value it states is compared
 * with what this build exports or ships, and every refusal code it names must be
 * a real member of the refusal union. Moving a definition, renaming a constant
 * or bumping a literal therefore fails this test until the document follows.
 */
const root = resolve(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/gu, "\n");
const contracts = read("CONTRACTS.md");
const sha256 = (path: string) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");

const GOVERNANCE_INPUT = "src/org-policy/governance-input-v1.ts";

/** Each cited source line and the text it must still contain. */
const PINS: ReadonlyArray<readonly [file: string, line: number, text: string]> = [
  [GOVERNANCE_INPUT, 79, 'export const GOVERNANCE_INPUT_V1_FORMAT = "aih-governance-input";'],
  [GOVERNANCE_INPUT, 81, "export const MAX_GOVERNANCE_INPUT_BYTES_V1 = 8_192;"],
  [GOVERNANCE_INPUT, 137, "export type GovernanceInputRefusalV1 ="],
  [GOVERNANCE_INPUT, 613, '"unknown-contract-version",'],
  [GOVERNANCE_INPUT, 719, "export interface ScanVerificationAdapterV1 {"],
  [GOVERNANCE_INPUT, 743, "export interface ScanExecutionAdapterV1 {"],
  [GOVERNANCE_INPUT, 769, "export interface AssessmentMaterialResolverV1 {"],
  [GOVERNANCE_INPUT, 787, "export interface QualificationMaterialResolverV1 {"],
  [GOVERNANCE_INPUT, 809, "export interface QualificationAttestationVerifierV1 {"],
  [GOVERNANCE_INPUT, 932, "function declaredCoreContractAcceptedV1(verified: unknown): boolean {"],
  [GOVERNANCE_INPUT, 1049, 'refused: "qualification-receipt-malformed",'],
  [GOVERNANCE_INPUT, 1248, '"observation.manifestPath",'],
  [GOVERNANCE_INPUT, 1457, 'if (declares === false) reason = "unknown-contract-version";'],
  [GOVERNANCE_INPUT, 1483, 'reason: "unknown-contract-version"'],
  [GOVERNANCE_INPUT, 1575, 'reason: "scan-core-contract-unknown"'],
  [GOVERNANCE_INPUT, 1786, 'reason: "authority-version"'],
  [
    "src/org-policy/qualification-v1.ts",
    15,
    'export const ORGANIZATION_EVIDENCE_ENVELOPE_V1_FORMAT = "aih-organization-evidence";',
  ],
  [
    "src/org-policy/qualification-v1.ts",
    17,
    "export const MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1 = 4_096;",
  ],
  [
    "src/org-policy/upstream-artifact-manifest-v1.ts",
    20,
    'export const UPSTREAM_ARTIFACT_MANIFEST_V1_FORMAT = "aih-upstream-artifact-manifest";',
  ],
  [
    "src/org-policy/upstream-artifact-manifest-v1.ts",
    21,
    "export const MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1 = 512 * 1024;",
  ],
  [
    "src/org-policy/upstream-artifact-manifest-v1.ts",
    22,
    "export const MAX_UPSTREAM_ARTIFACT_FILES_V1 = 256;",
  ],
  [
    "src/org-policy/upstream-observation-receipt-v1.ts",
    46,
    'export const UPSTREAM_OBSERVATION_RECEIPT_V1_FORMAT = "aih-upstream-observation-receipt";',
  ],
  [
    "src/org-policy/upstream-observation-receipt-v1.ts",
    97,
    "export function parseUpstreamObservationReceiptV1(value: unknown)",
  ],
  [
    "src/org-policy/governance-decision-v2.ts",
    19,
    "export const ACCEPTED_DECISION_SCHEMA_DIGESTS_V2: readonly string[] = Object.freeze([",
  ],
  [
    "src/org-policy/governance-decision-v2.ts",
    242,
    'format: z.literal("aih-governance-decision"),',
  ],
  ["src/org-policy/authority-v3.ts", 60, 'format: z.literal("aih-policy-authority-receipt"),'],
  ["src/org-policy/authority-v3.ts", 61, "version: z.literal(3),"],
  [
    "src/org-policy/supported-qualification-receipt-v2.ts",
    36,
    "export const MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2 = 5_970;",
  ],
  [
    "src/org-policy/supported-qualification-receipt-v2.ts",
    103,
    'format: z.literal("aih-supported-qualification-receipt"),',
  ],
  ["src/internals/clis.ts", 9, "export const SUPPORTED_CLIS = ["],
  ["src/index.ts", 19, 'export { type Cli, SUPPORTED_CLIS } from "./internals/clis.js";'],
];

/** Refusal-union members no code path produces today; see the reachability test. */
const UNPRODUCED_REFUSALS = ["derived-digest-mismatch"];

function refusalUnion(): string[] {
  const source = read(GOVERNANCE_INPUT);
  const start = source.indexOf("export type GovernanceInputRefusalV1 =");
  const end = source.indexOf(";", start);
  return [...source.slice(start, end).matchAll(/\|\s*"([a-z0-9-]+)"/gu)].map(
    (match) => match[1] as string,
  );
}

describe("CONTRACTS.md inventory", () => {
  it("cites only pinned lines, and every pinned line still holds its definition", () => {
    const pinned = new Set(PINS.map(([file, line]) => `${file}:${line}`));
    const cited = new Set(
      [...contracts.matchAll(/`((?:src|tests)\/[^`\s]+\.ts):(\d+)`/gu)].map(
        (match) => `${match[1]}:${match[2]}`,
      ),
    );
    expect([...cited].sort()).toEqual([...pinned].sort());
    for (const [file, line, text] of PINS) {
      const actual = read(file).split("\n")[line - 1] ?? "";
      expect(actual, `${file}:${line}`).toContain(text);
    }
  });

  it("states the formats, versions and bounds this build exports", () => {
    expect(GOVERNANCE_INPUT_V1_FORMAT).toBe("aih-governance-input");
    expect(MAX_GOVERNANCE_INPUT_BYTES_V1).toBe(8192);
    expect(ORGANIZATION_EVIDENCE_ENVELOPE_V1_FORMAT).toBe("aih-organization-evidence");
    expect(MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1).toBe(4096);
    expect(UPSTREAM_ARTIFACT_MANIFEST_V1_FORMAT).toBe("aih-upstream-artifact-manifest");
    expect(MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1).toBe(512 * 1024);
    expect(MAX_UPSTREAM_ARTIFACT_FILES_V1).toBe(256);
    expect(UPSTREAM_OBSERVATION_RECEIPT_V1_FORMAT).toBe("aih-upstream-observation-receipt");
    expect(MAX_UPSTREAM_OBSERVATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2).toBe(5970);
    for (const text of [
      '`format: "aih-governance-input"`, `version: 1`',
      '`format: "aih-organization-evidence"`, `version: 1`',
      '`format: "aih-upstream-artifact-manifest"`, `version: 1`',
      '`format: "aih-upstream-observation-receipt"`, `version: 1`',
      '`format: "aih-governance-decision"`, `version: 2`',
      '`format: "aih-policy-authority-receipt"`, `version: 3`',
      '`format: "aih-supported-qualification-receipt"`, `version: 2`',
      "8192 bytes",
      "4096 bytes",
      "512 KiB",
      "256 files",
      "5970 bytes",
      "24 hours",
    ])
      expect(contracts, text).toContain(text);
  });

  it("matches every shipped schema's declared format and version", () => {
    const schema = (name: string) =>
      JSON.parse(read(`schemas/${name}.schema.json`)) as {
        properties?: Record<string, { const?: unknown }>;
        oneOf?: Array<{ properties?: Record<string, { const?: unknown }> }>;
      };
    const identity = (name: string) => {
      const properties = schema(name).properties;
      return [properties?.format?.const, properties?.version?.const];
    };
    expect(identity("aih-organization-evidence-envelope-v1")).toEqual([
      ORGANIZATION_EVIDENCE_ENVELOPE_V1_FORMAT,
      1,
    ]);
    expect(identity("aih-upstream-artifact-manifest-v1")).toEqual([
      UPSTREAM_ARTIFACT_MANIFEST_V1_FORMAT,
      1,
    ]);
    expect(identity("aih-upstream-observation-receipt-v1")).toEqual([
      UPSTREAM_OBSERVATION_RECEIPT_V1_FORMAT,
      1,
    ]);
    expect(identity("aih-supported-qualification-receipt-v2")).toEqual([
      "aih-supported-qualification-receipt",
      2,
    ]);
    for (const branch of schema("aih-governance-decision-v2").oneOf ?? [])
      expect([branch.properties?.format?.const, branch.properties?.version?.const]).toEqual([
        "aih-governance-decision",
        2,
      ]);
    // The legacy authority branches are named in the inventory as not an input.
    expect(
      (schema("aih-policy-authority-receipt").oneOf ?? []).map(
        (branch) => branch.properties?.version?.const,
      ),
    ).toEqual([1, 2, 3]);
    const manifest = JSON.parse(read("package.json")) as { exports: Record<string, unknown> };
    expect(manifest.exports["./schemas/*.json"]).toBe("./schemas/*.json");
  });

  it("names the accepted decision-schema digests, the current one last", () => {
    expect(ACCEPTED_DECISION_SCHEMA_DIGESTS_V2).toEqual([
      "27295aee8d8be333abe2c73adc72884b534b1c9980a9b7a39d12be8d34c5caff",
      "7fdf101568cd7caa28516d0be37704c0dfd51198bc54d41d65829abbe77547cc",
    ]);
    expect(ACCEPTED_DECISION_SCHEMA_DIGESTS_V2.at(-1)).toBe(
      sha256("schemas/aih-governance-decision-v2.schema.json"),
    );
    for (const digest of ACCEPTED_DECISION_SCHEMA_DIGESTS_V2) expect(contracts).toContain(digest);
  });

  it("recomputes every digest a sibling mirror claims from the schema Core ships", () => {
    const shipped = new Map(
      readdirSync(resolve(root, "schemas"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => [sha256(`schemas/${name}`), `schemas/${name}`]),
    );
    const mirrors = contracts.slice(contracts.indexOf("## Where siblings mirror a Core artifact"));
    const rows = mirrors
      .slice(0, mirrors.indexOf("\n\n", mirrors.indexOf("| --- |")))
      .split("\n")
      .filter((line) => line.startsWith("| `@aihq/"));
    expect(rows.length).toBe(5);
    for (const row of rows) {
      const artifact = /\| `(schemas\/[^`]+)` \|/u.exec(row)?.[1];
      const digests = [...row.matchAll(/`([0-9a-f]{64})`/gu)].map((match) => match[1] as string);
      expect(artifact, row).toBeDefined();
      expect(digests.length, row).toBeGreaterThan(0);
      for (const digest of digests) {
        // Either the exact bytes this package ships, or an accepted older revision.
        if (shipped.get(digest) !== artifact)
          expect(ACCEPTED_DECISION_SCHEMA_DIGESTS_V2, row).toContain(digest);
      }
    }
  });

  it("describes SUPPORTED_CLIS as the shape this build exports", () => {
    expect(SUPPORTED_CLIS.length).toBe(11);
    expect(new Set(SUPPORTED_CLIS).size).toBe(SUPPORTED_CLIS.length);
    for (const id of SUPPORTED_CLIS) expect(id).toMatch(/^[a-z][a-z0-9-]{0,63}$/u);
    expect(contracts).toContain("11 lowercase ids, unique, in a fixed order");
  });

  it("names only refusal codes that exist", () => {
    const union = new Set(refusalUnion());
    const named = new Set(
      [...contracts.matchAll(/`([a-z]+(?:-[a-z0-9]+)+)`/gu)]
        .map((match) => match[1] as string)
        .filter((token) => union.has(token) || /(?:unknown|malformed|unverified)/u.test(token)),
    );
    expect(named.size).toBeGreaterThan(10);
    for (const code of named) expect(union, code).toContain(code);
  });

  it("keeps every refusal code produced somewhere, except the one never wired", () => {
    const source = read(GOVERNANCE_INPUT);
    const start = source.indexOf("export type GovernanceInputRefusalV1 =");
    const end = source.indexOf(";", start);
    const producers = [
      source.slice(0, start) + source.slice(end),
      ...readdirSync(resolve(root, "src/org-policy"))
        .filter((name) => name.endsWith(".ts") && name !== "governance-input-v1.ts")
        .map((name) => read(`src/org-policy/${name}`)),
    ].join("\n");
    const unproduced = refusalUnion().filter((code) => !producers.includes(`"${code}"`));
    // `derived-digest-mismatch` has been declared since the contract was added and
    // no path produces it: a saved document whose derived digests disagree is refused
    // as non-canonical bytes by the parser first. Wiring it is a separate change.
    expect(unproduced).toEqual(UNPRODUCED_REFUSALS);
  });
});
