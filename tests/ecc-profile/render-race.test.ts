import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidence, profile, projectionRoots } from "./render-fixture.js";

const substitution = vi.hoisted(() => ({
  armed: false,
  target: "",
  replacement: "",
}));

vi.mock("../../src/internals/fsxn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/internals/fsxn.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    readRegularFileWithStats(path: string, options?: { maxBytes?: number }) {
      const targetsSubstitution =
        substitution.armed &&
        fs.realpathSync.native(path) === fs.realpathSync.native(substitution.target);
      if (targetsSubstitution) {
        substitution.armed = false;
        fs.rmSync(path);
        fs.linkSync(substitution.replacement, path);
      }
      return actual.readRegularFileWithStats(path, options);
    },
  };
});

const { renderEccProjectionWithTrust } = await import("../../src/ecc-profile/render.js");

afterEach(() => {
  substitution.armed = false;
  substitution.target = "";
  substitution.replacement = "";
});

describe("ECC projection open-once acquisition", () => {
  it("rejects a same-byte linked file substituted after inventory enumeration", async () => {
    const roots = await projectionRoots();
    try {
      const firstSkill = roots.resolved.skills[0];
      if (!firstSkill) throw new Error("fixture has no selected skill");
      const target = join(roots.sourceRoot, ...firstSkill.sourcePath.split("/"), "SKILL.md");
      const replacement = join(roots.evidenceRoot, "same-byte-replacement.md");
      await copyFile(target, replacement);
      const trust = await roots.createTrust();

      substitution.target = target;
      substitution.replacement = replacement;
      substitution.armed = true;

      await expect(renderEccProjectionWithTrust(profile, evidence, roots, trust)).rejects.toThrow(
        /linked|regular file|identity/i,
      );
    } finally {
      substitution.armed = false;
      await roots.cleanup();
    }
  }, 30_000);
});
