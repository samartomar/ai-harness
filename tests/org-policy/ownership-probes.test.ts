import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOVERNED_OWNERSHIP_PROBES,
  governedOwnershipAt,
} from "../../src/org-policy/ownership-probes.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ownership-probes-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("governed ownership probes", () => {
  it("names each kind of governed state aih can own at a project root", () => {
    expect(GOVERNED_OWNERSHIP_PROBES.map((probe) => probe.id)).toEqual([
      "framework-materialization-receipt",
      "policy-required-guidance",
      "command-permissions",
    ]);
  });

  it("finds nothing at an empty root", () => {
    expect(governedOwnershipAt(root)).toEqual([]);
  });

  it("reports a materialization receipt as owned, even when it is malformed", () => {
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    writeFileSync(join(root, ".aih", "ecc", "materialization-v1.json"), "{not json");
    expect(governedOwnershipAt(root)).toEqual(["framework-materialization-receipt"]);
  });

  it("consults only the probes it is given", () => {
    mkdirSync(join(root, ".aih", "ecc"), { recursive: true });
    writeFileSync(join(root, ".aih", "ecc", "materialization-v1.json"), "{}");
    expect(governedOwnershipAt(root, [{ id: "none", owned: () => false }])).toEqual([]);
  });
});
