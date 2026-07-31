import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseOutputManifest,
  verifyOutputManifest,
  writeVerifiedOutputManifest,
} from "../../src/baseline-evidence/output-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-output-manifest-"));
  roots.push(root);
  writeFileSync(join(root, "a.json"), '{"a":1}\n');
  writeFileSync(join(root, "b.csv"), "b\n");
  return root;
}

describe("final output manifest", () => {
  it("writes only after all outputs exist and independently verifies every digest", () => {
    const root = fixtureRoot();
    const manifest = join(root, "final-output-sha256.txt");

    const result = writeVerifiedOutputManifest({
      root,
      manifestPath: manifest,
      outputPaths: ["b.csv", "a.json"],
    });

    expect(result.ok).toBe(true);
    expect(result.entries.map((entry) => entry.path)).toEqual(["a.json", "b.csv"]);
    expect(verifyOutputManifest(root, readFileSync(manifest, "utf8"))).toEqual(result);
  });

  it("fails closed when an output changes after the manifest is written", () => {
    const root = fixtureRoot();
    const manifest = join(root, "final-output-sha256.txt");
    writeVerifiedOutputManifest({
      root,
      manifestPath: manifest,
      outputPaths: ["a.json", "b.csv"],
    });
    writeFileSync(join(root, "a.json"), '{"a":2}\n');

    expect(() => verifyOutputManifest(root, readFileSync(manifest, "utf8"))).toThrow(
      /digest mismatch for a\.json/,
    );
  });

  it("rejects missing, escaping, duplicate, and self-referential entries", () => {
    const root = fixtureRoot();
    const manifest = join(root, "final-output-sha256.txt");

    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: manifest,
        outputPaths: ["missing.json"],
      }),
    ).toThrow();
    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: manifest,
        outputPaths: ["../a.json"],
      }),
    ).toThrow(/unsafe|escapes/);
    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: manifest,
        outputPaths: ["a.json", "a.json"],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: manifest,
        outputPaths: ["final-output-sha256.txt"],
      }),
    ).toThrow(/cannot hash itself/);
  });

  it("rewrites an existing regular manifest atomically", () => {
    const root = fixtureRoot();
    const manifest = join(root, "final-output-sha256.txt");
    writeVerifiedOutputManifest({
      root,
      manifestPath: manifest,
      outputPaths: ["a.json"],
    });

    const result = writeVerifiedOutputManifest({
      root,
      manifestPath: manifest,
      outputPaths: ["a.json", "b.csv"],
    });

    expect(result.entries.map((entry) => entry.path)).toEqual(["a.json", "b.csv"]);
  });

  it("rejects malformed, empty, duplicate, non-file, and invalid-target manifests", () => {
    const root = fixtureRoot();
    const manifest = join(root, "final-output-sha256.txt");
    const digest = "a".repeat(64);
    mkdirSync(join(root, "directory"));

    expect(() => parseOutputManifest("not a manifest row\n")).toThrow(/malformed/);
    expect(() => parseOutputManifest(`${digest}  a.json\n${digest}  a.json\n`)).toThrow(
      /duplicate/,
    );
    expect(() => verifyOutputManifest(root, "")).toThrow(/at least one entry/);
    expect(() => verifyOutputManifest(root, `${digest}  directory\n`)).toThrow(
      /not a regular file/,
    );
    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: join(root, "..", "outside.txt"),
        outputPaths: ["a.json"],
      }),
    ).toThrow(/inside its output root/);
    mkdirSync(manifest);
    expect(() =>
      writeVerifiedOutputManifest({
        root,
        manifestPath: manifest,
        outputPaths: ["a.json"],
      }),
    ).toThrow(/target must be a regular file/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a manifest entry whose symlink resolves outside the output root",
    () => {
      const root = fixtureRoot();
      const outside = fixtureRoot();
      symlinkSync(join(outside, "a.json"), join(root, "linked.json"), "file");

      expect(() => verifyOutputManifest(root, `${"a".repeat(64)}  linked.json\n`)).toThrow(
        /resolves outside root/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a manifest parent whose symlink resolves outside the output root",
    () => {
      const root = fixtureRoot();
      const outside = fixtureRoot();
      symlinkSync(outside, join(root, "linked"), "dir");

      expect(() =>
        writeVerifiedOutputManifest({
          root,
          manifestPath: join(root, "linked", "final-output-sha256.txt"),
          outputPaths: ["a.json"],
        }),
      ).toThrow(/parent resolves outside/);
    },
  );
});
