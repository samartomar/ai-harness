import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSingleMethodologyFramework,
  type BindingDeclaration,
  BindingDeclarationError,
  BindingDeclarationSchema,
  BindingFrameworkConflictError,
  parseBindingDeclaration,
  readBindingDeclaration,
} from "../../src/binding/schema.js";

const SHA40 = "a".repeat(40);
const SHA256 = "b".repeat(64);
const INTEGRITY = `sha512-${"A".repeat(86)}==`;

function gitDeclaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", mode: "lean", host: "claude", features: { rulesCore: true } },
    source: { kind: "git", repository: "affaan-m/ECC", commitSha: SHA40, treeDigest: SHA256 },
  };
}

function npmDeclaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "superpowers", host: "claude" },
    source: {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "6.0.0",
      integrity: INTEGRITY,
    },
  };
}

describe("binding declaration schema", () => {
  it("round-trips a git declaration through parse -> serialize -> parse", () => {
    const declaration = gitDeclaration();
    const first = parseBindingDeclaration(declaration);
    const serialized = JSON.stringify(first);
    const second = parseBindingDeclaration(JSON.parse(serialized));
    expect(second).toEqual(first);
    expect(second).toEqual(declaration);
  });

  it("round-trips an npm declaration through parse -> serialize -> parse", () => {
    const declaration = npmDeclaration();
    const first = parseBindingDeclaration(declaration);
    const second = parseBindingDeclaration(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(declaration);
  });

  it("rejects a short commit SHA", () => {
    const bad = gitDeclaration();
    bad.source = {
      ...bad.source,
      kind: "git",
      commitSha: "abc1234",
    } as BindingDeclaration["source"];
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an uppercase commit SHA (identity must be exact lowercase)", () => {
    const bad = { ...gitDeclaration() };
    bad.source = {
      kind: "git",
      repository: "affaan-m/ECC",
      commitSha: "A".repeat(40),
      treeDigest: SHA256,
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a ref/branch name in the commitSha identity field", () => {
    const bad = { ...gitDeclaration() };
    bad.source = { kind: "git", repository: "affaan-m/ECC", commitSha: "main", treeDigest: SHA256 };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a ref fragment smuggled into the repository identity field", () => {
    const bad = { ...gitDeclaration() };
    bad.source = {
      kind: "git",
      repository: "affaan-m/ECC#main",
      commitSha: SHA40,
      treeDigest: SHA256,
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-sha256 treeDigest", () => {
    const bad = { ...gitDeclaration() };
    bad.source = { kind: "git", repository: "affaan-m/ECC", commitSha: SHA40, treeDigest: "nope" };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a tag/dist-tag as the npm exactVersion", () => {
    const bad = { ...npmDeclaration() };
    bad.source = {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "latest",
      integrity: INTEGRITY,
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a semver range as the npm exactVersion", () => {
    const bad = { ...npmDeclaration() };
    bad.source = {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "^6.0.0",
      integrity: INTEGRITY,
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-SRI integrity value", () => {
    const bad = { ...npmDeclaration() };
    bad.source = {
      kind: "npm",
      package: "@obra/superpowers",
      exactVersion: "6.0.0",
      integrity: SHA256,
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects mode on a non-ecc framework", () => {
    const bad = { ...gitDeclaration() };
    bad.framework = { id: "superpowers", mode: "lean", host: "claude" };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts mode only on ecc", () => {
    const ok = gitDeclaration();
    ok.framework = { id: "ecc", mode: "full", host: "claude" };
    expect(BindingDeclarationSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects an unknown framework id", () => {
    const bad = { ...gitDeclaration(), framework: { id: "gsd", host: "claude" } };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a second framework smuggled via an extra framework key (strict, not stripped)", () => {
    const bad = {
      ...gitDeclaration(),
      framework: { id: "ecc", host: "claude", superpowers: { id: "superpowers" } },
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a second framework smuggled via an extra source key (ref-as-identity)", () => {
    const bad = { ...gitDeclaration() };
    (bad.source as unknown as Record<string, unknown>).ref = "v1.0.0";
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an array in place of the single framework object (co-enablement has no representation)", () => {
    const bad = {
      ...gitDeclaration(),
      framework: [
        { id: "ecc", host: "claude" },
        { id: "superpowers", host: "claude" },
      ],
    };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an array declaration outright (single object, never an array)", () => {
    expect(BindingDeclarationSchema.safeParse([gitDeclaration()]).success).toBe(false);
  });

  it("rejects an unknown top-level declaration key (strict)", () => {
    const bad = { ...gitDeclaration(), framework2: { id: "superpowers", host: "claude" } };
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown host", () => {
    const bad = { ...gitDeclaration() };
    bad.framework = { id: "ecc", host: "codex" } as unknown as BindingDeclaration["framework"];
    expect(BindingDeclarationSchema.safeParse(bad).success).toBe(false);
  });
});

describe("assertSingleMethodologyFramework (D8 shared guard)", () => {
  it("allows re-binding the same framework", () => {
    expect(() => assertSingleMethodologyFramework("ecc", "ecc")).not.toThrow();
    expect(() => assertSingleMethodologyFramework("ecc", undefined)).not.toThrow();
  });

  it("rejects binding a different framework (fail closed)", () => {
    expect(() => assertSingleMethodologyFramework("superpowers", "ecc")).toThrow(
      BindingFrameworkConflictError,
    );
  });
});

describe("readBindingDeclaration (committed authority)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aih-binding-decl-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined when the marker is absent", () => {
    expect(readBindingDeclaration(root)).toBeUndefined();
  });

  it("returns undefined when the marker has no binding field", () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: ".ai" }),
    );
    expect(readBindingDeclaration(root)).toBeUndefined();
  });

  it("reads a valid committed binding declaration", () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: ".ai",
        targets: [],
        binding: gitDeclaration(),
      }),
    );
    expect(readBindingDeclaration(root)).toEqual(gitDeclaration());
  });

  it("fails closed when the committed binding declaration is invalid", () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: ".ai",
        binding: { schemaVersion: 1, framework: { id: "gsd" } },
      }),
    );
    expect(() => readBindingDeclaration(root)).toThrow(BindingDeclarationError);
  });
});
