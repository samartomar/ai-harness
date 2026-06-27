import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCanon, isAdoptable } from "../../src/adopt/classify.js";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { beginLine, endLine } from "../../src/internals/markers.js";

const DIR = "ai-coding";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-adopt-cls-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(rel: string, contents: string): void {
  const full = join(tmp, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/** A bootloader carrying an `ai-canonical:shared` block with the given body. */
function bootloaderWith(body: string): string {
  return `# Preamble\n\n${beginLine(SHARED_MARKER, "src")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`;
}

describe("classifyCanon", () => {
  it("greenfield: empty repo → init create path applies", () => {
    const cls = classifyCanon(tmp, DIR);
    expect(cls.kind).toBe("greenfield");
    expect(cls.bootloaders).toHaveLength(0);
    expect(isAdoptable(cls.kind)).toBe(false);
  });

  it("greenfield: a bare markerless bootloader is not canon", () => {
    // ai-os's bare CLAUDE.md case — content, but no router/marker/legacy.
    put("CLAUDE.md", "# Just a hand-written readme pointer\n");
    const cls = classifyCanon(tmp, DIR);
    expect(cls.kind).toBe("greenfield");
    expect(cls.bootloaders[0]?.hasMarker).toBe(false);
  });

  it("already-adopted: marker present and body matches the current canonical block", () => {
    put("CLAUDE.md", bootloaderWith(sharedCanonicalBlockBody(DIR).trim()));
    const cls = classifyCanon(tmp, DIR);
    expect(cls.kind).toBe("already-adopted");
    expect(cls.bootloaders[0]?.bodyMatches).toBe(true);
    expect(cls.bootloaders[0]?.preservedLines).toBe(0);
    expect(isAdoptable(cls.kind)).toBe(false);
  });

  it("marker-divergent (eicp): same marker, body carries a project extension to preserve", () => {
    const body = `${sharedCanonicalBlockBody(DIR).trim()}\n\n## EICP project extension\n\n- Honor the gateway enforcement contract.`;
    put("CLAUDE.md", bootloaderWith(body));
    const cls = classifyCanon(tmp, DIR);
    expect(cls.kind).toBe("marker-divergent");
    const cl = cls.bootloaders.find((b) => b.path === "CLAUDE.md");
    expect(cl?.hasMarker).toBe(true);
    expect(cl?.bodyMatches).toBe(false);
    // The extension lines are detected as content to preserve on reconcile.
    expect(cl?.preservedLines).toBeGreaterThan(0);
    expect(isAdoptable(cls.kind)).toBe(true);
  });

  it("foreign-scheme (syntegris): equivalent canon (router) but no aih marker in the bootloader", () => {
    put(`${DIR}/RULE_ROUTER.md`, "# Router (hand-rolled)\n");
    put("CLAUDE.md", "# Bootloader\n\nload the router\n"); // no managed block
    put(`${DIR}/RULE_BOOTLOADER_MIGRATION.md`, "# legacy migration bundle\n");
    const cls = classifyCanon(tmp, DIR);
    expect(cls.kind).toBe("foreign-scheme");
    expect(cls.routerPresent).toBe(true);
    expect(cls.legacyArtifacts).toContain(`${DIR}/RULE_BOOTLOADER_MIGRATION.md`);
    expect(isAdoptable(cls.kind)).toBe(true);
  });

  it("detects legacy regenerate scripts as retirable artifacts", () => {
    put(`${DIR}/RULE_ROUTER.md`, "# Router\n");
    put(`${DIR}/scripts/regenerate-adapters.ps1`, "# ps\n");
    put(`${DIR}/scripts/regenerate-adapters.sh`, "# sh\n");
    const cls = classifyCanon(tmp, DIR);
    expect(cls.legacyArtifacts).toEqual(
      expect.arrayContaining([
        `${DIR}/scripts/regenerate-adapters.ps1`,
        `${DIR}/scripts/regenerate-adapters.sh`,
      ]),
    );
  });

  it("a committed .aih-config marker flips a matching canon to already-adopted, not adoptable", () => {
    put("CLAUDE.md", bootloaderWith(sharedCanonicalBlockBody(DIR).trim()));
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: DIR, targets: ["claude"] }),
    );
    const cls = classifyCanon(tmp, DIR);
    expect(cls.configPresent).toBe(true);
    expect(cls.kind).toBe("already-adopted");
  });

  it("honors a custom context dir for router/legacy detection", () => {
    put("my-canon/RULE_ROUTER.md", "# Router\n");
    const cls = classifyCanon(tmp, "my-canon");
    expect(cls.kind).toBe("foreign-scheme");
    expect(cls.routerPresent).toBe(true);
  });
});
