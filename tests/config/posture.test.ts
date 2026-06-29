import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asPosture, gradeVerdict, resolvePosture } from "../../src/config/posture.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-posture-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function marker(posture: string): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: [], posture }),
  );
}

function orgPolicy(minimumPosture: string): void {
  writeFileSync(
    join(dir, "aih-org-policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      minimumPosture,
      references: { repoContract: "ai-coding/project.json" },
    }),
  );
}

describe("asPosture", () => {
  it("normalizes legacy community to vibe and accepts the three v2 postures", () => {
    expect(asPosture(undefined)).toBe("vibe");
    expect(asPosture("community")).toBe("vibe");
    expect(asPosture("vibe")).toBe("vibe");
    expect(asPosture("team")).toBe("team");
    expect(asPosture("enterprise")).toBe("enterprise");
    expect(asPosture("nonsense")).toBe("vibe");
  });
});

describe("gradeVerdict", () => {
  it("keeps vibe advisory, hard-blocks secret controls at team, and preserves risk-gates as ask", () => {
    expect(gradeVerdict("warn", "secrets", "vibe")).toBe("warn");
    expect(gradeVerdict("warn", "secrets", "team")).toBe("deny");
    expect(gradeVerdict("warn", "path-portability", "team")).toBe("deny");
    expect(gradeVerdict("warn", "secrets", "enterprise")).toBe("deny");
    expect(gradeVerdict("warn", "risk-gates", "enterprise")).toBe("warn");
    expect(gradeVerdict("allow", "secrets", "enterprise")).toBe("allow");
  });
});

describe("resolvePosture", () => {
  it("uses flag > marker > env > default when no org floor is present", () => {
    marker("team");
    expect(
      resolvePosture({
        root: dir,
        env: { AIH_POSTURE: "enterprise" },
        flag: "vibe",
        flagSource: "cli",
      }),
    ).toEqual({ posture: "vibe", postureSource: "flag" });
    expect(resolvePosture({ root: dir, env: { AIH_POSTURE: "enterprise" } })).toEqual({
      posture: "team",
      postureSource: "marker",
    });
    rmSync(join(dir, ".aih-config.json"), { force: true });
    expect(resolvePosture({ root: dir, env: { AIH_POSTURE: "team" } })).toEqual({
      posture: "team",
      postureSource: "env",
    });
    expect(resolvePosture({ root: dir, env: {} })).toEqual({
      posture: "vibe",
      postureSource: "default",
    });
  });

  it("clamps upward to the org minimum posture without lowering a stricter local choice", () => {
    orgPolicy("team");
    expect(
      resolvePosture({
        root: dir,
        env: {},
        flag: "vibe",
        flagSource: "cli",
      }),
    ).toEqual({ posture: "team", postureSource: "org-floor" });
    expect(
      resolvePosture({
        root: dir,
        env: {},
        flag: "enterprise",
        flagSource: "cli",
      }),
    ).toEqual({ posture: "enterprise", postureSource: "flag" });
  });
});
