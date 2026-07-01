import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/program.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

// The CLI reports VERSION from a hardcoded constant, separate from package.json. A release
// tags `vX.Y.Z` and publishes the package's version — if the constant drifts, `aih --version`
// lies. Keep the two locked; the release workflow additionally asserts the tag matches.
describe("version coherence", () => {
  it("src/program.ts VERSION matches package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
