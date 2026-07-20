import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  type AdapterType,
  BindingAdapterRegistryError,
} from "../../src/binding/adapter.js";
import {
  BindingScanError,
  bindingCacheHome,
  resolveGitSource,
  resolveNpmSource,
} from "../../src/binding/scan-gate.js";
import { safeParseBindingDeclaration } from "../../src/binding/schema.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { createFakeAdapter } from "./fake-adapter.js";

const INTEGRITY = `sha512-${"A".repeat(86)}==`;
const RESOLVED = {
  kind: "git" as const,
  repository: "o/r",
  commitSha: "c".repeat(40),
  treeDigest: "d".repeat(64),
  treePath: "/x",
};

let cacheHome: string;

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "aih-binding-cov-"));
});

afterEach(() => {
  rmSync(cacheHome, { recursive: true, force: true });
});

describe("home resolution (repo convention)", () => {
  it("prefers HOME, then USERPROFILE", () => {
    expect(bindingCacheHome({ HOME: "/home/u" })).toBe(join("/home/u", ".aih", "binding"));
    expect(bindingCacheHome({ USERPROFILE: "C:\\Users\\u" })).toBe(
      join("C:\\Users\\u", ".aih", "binding"),
    );
  });
});

describe("git resolver failure paths (fail closed)", () => {
  it("rejects a non-40-hex commitSha input", async () => {
    await expect(
      resolveGitSource(
        { repository: "o/r", commitSha: "abc" },
        { runner: fakeRunner(() => ({})), cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  it("rejects an empty repository", async () => {
    await expect(
      resolveGitSource(
        { repository: "  ", ref: "HEAD" },
        { runner: fakeRunner(() => ({})), cacheHome },
      ),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  it("fails closed when ls-remote itself errors", async () => {
    const runner = fakeRunner((argv) =>
      argv.includes("ls-remote") ? { code: 1, stderr: "boom" } : undefined,
    );
    await expect(
      resolveGitSource({ repository: "o/r", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  it("fails closed when the clone fails", async () => {
    const runner = fakeRunner((argv) => {
      if (argv.includes("ls-remote")) return { stdout: `${"a".repeat(40)}\tHEAD\n` };
      if (argv.includes("clone")) return { code: 1, stderr: "clone boom" };
      return undefined;
    });
    await expect(
      resolveGitSource({ repository: "o/r", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });

  it("fails closed when the checkout fails", async () => {
    const runner = fakeRunner((argv) => {
      if (argv.includes("ls-remote")) return { stdout: `${"a".repeat(40)}\tHEAD\n` };
      if (argv.includes("clone")) return { code: 0 };
      if (argv.includes("checkout")) return { code: 1, stderr: "checkout boom" };
      return undefined;
    });
    await expect(
      resolveGitSource({ repository: "o/r", ref: "HEAD" }, { runner, cacheHome }),
    ).rejects.toBeInstanceOf(BindingScanError);
  });
});

describe("npm resolver (async fetcher)", () => {
  it("awaits an async metadata fetcher", async () => {
    const resolved = await resolveNpmSource(
      { package: "x", version: "1.2.3" },
      { fetchMetadata: async () => ({ version: "1.2.3", integrity: INTEGRITY }) },
    );
    expect(resolved.exactVersion).toBe("1.2.3");
  });
});

describe("adapter registry edges", () => {
  it("reports membership and rejects an unknown adapter type", () => {
    const registry = new AdapterRegistry();
    expect(registry.has("ecc")).toBe(false);
    registry.register(
      createFakeAdapter({ framework: "ecc", adapterType: "host-plugin", resolved: RESOLVED }),
    );
    expect(registry.has("ecc")).toBe(true);
    expect(() =>
      registry.register(
        createFakeAdapter({
          framework: "gstack",
          adapterType: "bogus" as unknown as AdapterType,
          resolved: RESOLVED,
        }),
      ),
    ).toThrow(BindingAdapterRegistryError);
  });
});

describe("safeParseBindingDeclaration", () => {
  it("returns a discriminated result rather than throwing", () => {
    expect(safeParseBindingDeclaration({ nope: true }).success).toBe(false);
    expect(
      safeParseBindingDeclaration({
        schemaVersion: 1,
        framework: { id: "gstack", host: "claude" },
        source: {
          kind: "git",
          repository: "o/r",
          commitSha: "a".repeat(40),
          treeDigest: "b".repeat(64),
        },
      }).success,
    ).toBe(true);
  });
});
