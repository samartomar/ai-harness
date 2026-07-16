import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverInertProvider } from "../../src/methodology/discover.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-methodology-discover-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inert provider discovery", () => {
  it("reads manifest scripts as data without executing provider code", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "synthetic-provider",
        scripts: {
          install: "node scripts/install.js --apply",
          uninstall: "node scripts/uninstall.js",
          test: "node --test",
        },
      }),
      "utf8",
    );
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "install.js"), "throw new Error('must not run')", "utf8");

    expect(discoverInertProvider({ root, treeSha256: "a".repeat(64) })).toEqual({
      manifestPath: "package.json",
      packageName: "synthetic-provider",
      scripts: {
        install: "node scripts/install.js --apply",
        test: "node --test",
        uninstall: "node scripts/uninstall.js",
      },
      installerEntries: ["install", "uninstall"],
      installerContractFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      providerCodeExecuted: false,
    });
  });

  it("fails closed for malformed manifests and reports no manifest as unknown", () => {
    writeFileSync(join(root, "package.json"), "{not json", "utf8");
    expect(() => discoverInertProvider({ root, treeSha256: "a".repeat(64) })).toThrow(/manifest/i);

    rmSync(join(root, "package.json"));
    expect(discoverInertProvider({ root, treeSha256: "a".repeat(64) })).toMatchObject({
      manifestPath: undefined,
      scripts: {},
      installerEntries: [],
      providerCodeExecuted: false,
    });
  });

  it.each([
    ["non-object manifest", "[]"],
    ["non-object scripts", JSON.stringify({ scripts: [] })],
    ["non-string script", JSON.stringify({ scripts: { install: 1 } })],
  ])("fails closed for %s", (_label, contents) => {
    writeFileSync(join(root, "package.json"), contents, "utf8");
    expect(() => discoverInertProvider({ root, treeSha256: "a".repeat(64) })).toThrow(/manifest/i);
  });

  it("accepts a manifest without scripts as an unknown installer contract", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "synthetic-provider" }),
      "utf8",
    );
    expect(discoverInertProvider({ root, treeSha256: "a".repeat(64) })).toMatchObject({
      packageName: "synthetic-provider",
      scripts: {},
      installerEntries: [],
    });
  });
});
