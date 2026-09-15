import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AihConfigSchema,
  isNativeMcpProjectionOwnership,
  nativeMcpProjectionOwnership,
  revokedNativeMcpProjectionOwnership,
} from "../../src/config/marker.js";

const expected = { entries: { approved: { command: "node", args: ["server.js"] } } };
const decision = {
  candidate: "approved",
  id: "decision-approved",
  issuer: "security-admin",
  digest: `sha256:${"a".repeat(64)}`,
  expiresAt: "2027-09-01T00:00:00Z",
};

describe("native MCP ownership receipts", () => {
  it("binds ownership to target, native path, contract, exact values and decisions", () => {
    const ownership = nativeMcpProjectionOwnership("cursor", expected, [decision]);
    expect(isNativeMcpProjectionOwnership(ownership, "cursor")).toBe(true);
    expect(isNativeMcpProjectionOwnership(ownership, "kimi")).toBe(false);
    for (const replacement of [
      { path: "operator.json" },
      { contract: "other-version" },
      { state: "revoked" },
      { expected: { entries: { approved: { command: "operator", args: [] } } } },
      { decisions: [{ ...decision, issuer: "other-issuer" }] },
      { decisions: [] },
      { sha256: "0".repeat(64) },
    ])
      expect(isNativeMcpProjectionOwnership({ ...ownership, ...replacement }, "cursor")).toBe(
        false,
      );
    expect(
      isNativeMcpProjectionOwnership(revokedNativeMcpProjectionOwnership(ownership), "cursor"),
    ).toBe(true);
  });
  it("hashes semantically identical entry objects deterministically", () => {
    const first = nativeMcpProjectionOwnership("cursor", expected, [decision]);
    const reordered = nativeMcpProjectionOwnership(
      "cursor",
      { entries: { approved: { args: ["server.js"], command: "node" } } },
      [decision],
    );
    expect(first.sha256).toBe(reordered.sha256);
  });
  it("keeps native ownership strict in runtime and published editor schemas", () => {
    const marker = {
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["cursor"],
      nativeMcpProjections: {
        cursor: nativeMcpProjectionOwnership("cursor", expected, [decision]),
      },
    };
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), "schemas/aih-config.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
    expect(AihConfigSchema.safeParse(marker).success).toBe(true);
    expect(validate(marker), JSON.stringify(validate.errors)).toBe(true);
    for (const nativeMcpProjections of [
      { cursor: { ...marker.nativeMcpProjections.cursor, unknown: true } },
      { unknown: marker.nativeMcpProjections.cursor },
      {
        cursor: {
          ...marker.nativeMcpProjections.cursor,
          expected: { entries: { approved: { command: "node", args: [], arbitrary: true } } },
        },
      },
      {
        cursor: {
          ...marker.nativeMcpProjections.cursor,
          decisions: [{ ...decision, target: "kimi" }],
        },
      },
    ]) {
      expect(AihConfigSchema.safeParse({ ...marker, nativeMcpProjections }).success).toBe(false);
      expect(validate({ ...marker, nativeMcpProjections })).toBe(false);
    }
  });
});
