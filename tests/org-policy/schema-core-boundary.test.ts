/**
 * The engine boundary of the Policy Workbench UI delivery.
 *
 * `src/org-policy/schema-core.ts` carries the canonical organization-policy
 * grammar with no host dependency, so the browser bundle can enforce the same
 * schema the CLI does. `src/org-policy/schema.ts` adds the Node loader on top
 * and re-exports the grammar, so every existing importer is unaffected.
 *
 * This file pins the three things that could silently rot: the purity of the
 * grammar's import graph, the completeness of the re-export, and the digest
 * staying byte-identical to `node:crypto`.
 */
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { build } from "esbuild";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as governanceDecisionV2 from "../../src/org-policy/governance-decision-v2.js";
import { GovernanceDecisionSourceV2Schema } from "../../src/org-policy/governance-decision-v2.js";
import * as schema from "../../src/org-policy/schema.js";
import * as schemaCore from "../../src/org-policy/schema-core.js";

const ENTRY = join(process.cwd(), "src/org-policy/schema-core.ts");

/** Host modules that must never appear behind the canonical grammar. */
const FORBIDDEN_INPUTS = [
  "src/internals/fsxn.ts",
  "src/internals/plan.ts",
  "src/internals/proc.ts",
  "src/internals/prompt.ts",
];

describe("schema-core bundles for the browser", () => {
  it("has no node: import, no external, and no host module in its graph", async () => {
    const result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    expect(result.errors).toStrictEqual([]);
    const metafile = result.metafile;
    expect(metafile).toBeDefined();

    const inputs = Object.keys(metafile.inputs).map((path) => path.replaceAll("\\", "/"));
    const nodeInputs = inputs.filter((path) => path.startsWith("node:"));
    expect(
      nodeInputs,
      `node built-ins reached the grammar: ${nodeInputs.join(", ")}`,
    ).toStrictEqual([]);

    const imports = Object.entries(metafile.inputs).flatMap(([importer, value]) =>
      value.imports.map((entry) => ({
        importer: importer.replaceAll("\\", "/"),
        path: entry.path.replaceAll("\\", "/"),
        external: entry.external === true,
      })),
    );
    const nodeImports = imports.filter((entry) => entry.path.startsWith("node:"));
    expect(
      nodeImports,
      `node built-ins imported: ${nodeImports.map((e) => `${e.importer} -> ${e.path}`).join(", ")}`,
    ).toStrictEqual([]);
    const externals = imports.filter((entry) => entry.external);
    expect(
      externals,
      `externalized imports: ${externals.map((e) => `${e.importer} -> ${e.path}`).join(", ")}`,
    ).toStrictEqual([]);

    const hostInputs = inputs.filter((path) => FORBIDDEN_INPUTS.some((bad) => path.endsWith(bad)));
    expect(hostInputs, `host modules reached the grammar: ${hostInputs.join(", ")}`).toStrictEqual(
      [],
    );
  }, 60_000);
});

describe("schema.ts stays the one import path", () => {
  it("re-exports every name of schema-core", () => {
    const missing = Object.keys(schemaCore).filter((name) => !Object.hasOwn(schema, name));
    expect(missing, `schema.ts does not re-export: ${missing.join(", ")}`).toStrictEqual([]);
  });

  it("keeps the loader's own exports", () => {
    for (const name of [
      "assertGovernanceOwnsSurface",
      "orgPolicyPath",
      "hasExplicitOrgPolicySource",
      "readOrgPolicy",
      "parseOrgPolicyContents",
    ]) {
      expect(Object.hasOwn(schema, name), `schema.ts lost ${name}`).toBe(true);
    }
  });
});

describe("the pure SRI check decides exactly as Buffer did", () => {
  /**
   * The predicate as it was written before the extraction — `Buffer.from(…,
   * "base64")` and the re-encode round-trip — kept here as the reference the
   * grammar must still agree with.
   */
  function bufferSha512Sri(value: string): boolean {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (match?.[1] === undefined) return false;
    const encoded = match[1];
    const decoded = Buffer.from(encoded, "base64");
    return decoded.length === 64 && decoded.toString("base64") === encoded;
  }

  /**
   * The npm branch is the one place the predicate is reached from. Every field
   * but `integrity` is fixed and valid, so an issue whose path ends at
   * `integrity` is exactly the predicate's refusal. Comparing on that path,
   * rather than on `success`, keeps the proof about the SRI check alone.
   */
  const validNpmSource = {
    type: "npm",
    registry: "https://registry.npmjs.org/",
    package: "left-pad",
    version: "1.3.0",
  } as const;

  function schemaAcceptsIntegrity(candidate: string): boolean {
    const result = GovernanceDecisionSourceV2Schema.safeParse({
      ...validNpmSource,
      integrity: candidate,
    });
    if (result.success) return true;
    return !result.error.issues.some((issue) => issue.path.at(-1) === "integrity");
  }

  it("does not put the predicate on the module's public surface", () => {
    expect(Object.keys(governanceDecisionV2)).not.toContain("validSha512Sri");
  });

  it("accepts real 64-byte digests", () => {
    for (let round = 0; round < 50; round += 1) {
      const sri = `sha512-${randomBytes(64).toString("base64")}`;
      expect([sri, schemaAcceptsIntegrity(sri)]).toStrictEqual([sri, true]);
      expect(bufferSha512Sri(sri)).toBe(true);
    }
  });

  it("agrees with Buffer on arbitrary base64-shaped strings", () => {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const body = fc.string({
      unit: fc.constantFrom(...charset.split("")),
      minLength: 1,
      maxLength: 92,
    });
    const pad = fc.constantFrom("", "=", "==");
    fc.assert(
      fc.property(body, pad, (data, padding) => {
        const value = `sha512-${data}${padding}`;
        expect([value, schemaAcceptsIntegrity(value)]).toStrictEqual([
          value,
          bufferSha512Sri(value),
        ]);
      }),
      { numRuns: 1500 },
    );
  });

  it("agrees with Buffer on near-miss digests and non-canonical trailing bits", () => {
    const base = randomBytes(64).toString("base64");
    const cases = [
      "",
      "sha512-",
      "sha256-abc",
      `sha512-${base}`,
      `sha512-${base.slice(0, 86)}`,
      `sha512-${base.slice(0, 86)}=`,
      `sha512-${base.slice(0, 85)}B==`,
      `sha512-${base.slice(0, 85)}A==`,
      `sha512-${base.slice(0, 85)}Q==`,
      `sha512-${base.slice(0, 85)}/==`,
      `sha512-${randomBytes(63).toString("base64")}`,
      `sha512-${randomBytes(65).toString("base64")}`,
      `sha512-${base}extra`,
      `sha512-${base.replace("=", "")}`,
    ];
    for (const value of cases) {
      expect([value, schemaAcceptsIntegrity(value)]).toStrictEqual([value, bufferSha512Sri(value)]);
    }
  });
});

describe("hookCommandDigest is unchanged", () => {
  it("equals node's sha256 of the command", () => {
    const commands = [
      "",
      "node ./hooks/guard.js",
      "npx --yes @aihq/core hook run",
      "echo 'ünïcødé — ✅ 中文 🙂'",
      "a".repeat(1000),
      "cmd 😀 tail",
    ];
    for (const command of commands) {
      const expected = `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`;
      expect([command, schema.hookCommandDigest(command)]).toStrictEqual([command, expected]);
      expect(schemaCore.hookCommandDigest(command)).toBe(expected);
    }
  });
});
