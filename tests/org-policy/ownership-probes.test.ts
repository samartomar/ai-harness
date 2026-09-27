import { mkdtempSync, rmSync } from "node:fs";
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
      "policy-required-guidance",
      "command-permissions",
    ]);
  });

  it("finds nothing at an empty root", () => {
    expect(governedOwnershipAt(root)).toEqual([]);
  });

  it("consults only the probes it is given", () => {
    expect(governedOwnershipAt(root, [{ id: "none", owned: () => false }])).toEqual([]);
  });
});
