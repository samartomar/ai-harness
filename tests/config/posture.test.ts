import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function orgPolicy(minimumPosture: string, path = join(dir, "aih-org-policy.json")): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      minimumPosture,
      references: { repoContract: "ai-coding/project.json" },
    }),
  );
}

describe("asPosture", () => {
  it("defaults absent posture to vibe and accepts the three v2 postures", () => {
    expect(asPosture(undefined)).toBe("vibe");
    expect(asPosture("vibe")).toBe("vibe");
    expect(asPosture("team")).toBe("team");
    expect(asPosture("enterprise")).toBe("enterprise");
  });

  it("rejects explicit invalid posture values instead of downgrading to vibe", () => {
    expect(() => asPosture("community")).toThrow(/invalid posture/);
    expect(() => asPosture("nonsense")).toThrow(/invalid posture/);
  });
});

describe("gradeVerdict", () => {
  it("keeps vibe advisory, hard-blocks secret controls at team, and preserves risk-gates as ask", () => {
    expect(gradeVerdict("warn", "secrets", "vibe")).toBe("warn");
    expect(gradeVerdict("warn", "secrets", "team")).toBe("deny");
    expect(gradeVerdict("warn", "path-portability", "team")).toBe("deny");
    expect(gradeVerdict("warn", "contract-freshness", "team")).toBe("deny");
    expect(gradeVerdict("warn", "secrets", "enterprise")).toBe("deny");
    expect(gradeVerdict("warn", "risk-gates", "enterprise")).toBe("warn");
    expect(gradeVerdict("allow", "secrets", "enterprise")).toBe("allow");
  });

  it("hard-blocks proven trust danger at every posture", () => {
    expect(gradeVerdict("warn", "trust-danger", "vibe")).toBe("deny");
    expect(gradeVerdict("warn", "trust-danger", "team")).toBe("deny");
    expect(gradeVerdict("warn", "trust-danger", "enterprise")).toBe("deny");
  });

  it("keeps trust origin advisory at vibe/team and blocking at enterprise", () => {
    expect(gradeVerdict("warn", "trust-origin", "vibe")).toBe("warn");
    expect(gradeVerdict("warn", "trust-origin", "team")).toBe("warn");
    expect(gradeVerdict("warn", "trust-origin", "enterprise")).toBe("deny");
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

  it("fails closed on legacy community posture from flag or env", () => {
    expect(() =>
      resolvePosture({
        root: dir,
        env: {},
        flag: "community",
        flagSource: "cli",
      }),
    ).toThrow(/invalid --posture/);

    expect(() => resolvePosture({ root: dir, env: { AIH_POSTURE: "community" } })).toThrow(
      /invalid AIH_POSTURE/,
    );
  });

  it("fails closed instead of downgrading when the marker posture is coupled to an invalid baseline", () => {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: [],
        posture: "enterprise",
        baseline: "missing",
      }),
    );

    expect(() => resolvePosture({ root: dir, env: {} })).toThrow(/invalid \.aih-config\.json/);
  });

  it("does not let flag or env posture override an invalid persisted baseline", () => {
    writeFileSync(
      join(dir, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: [],
        baseline: "missing",
      }),
    );

    expect(() =>
      resolvePosture({ root: dir, env: {}, flag: "enterprise", flagSource: "cli" }),
    ).toThrow(/invalid \.aih-config\.json/);
    expect(() => resolvePosture({ root: dir, env: { AIH_POSTURE: "enterprise" } })).toThrow(
      /invalid \.aih-config\.json/,
    );
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

  it("attributes posture to org-floor when the local choice equals the floor", () => {
    orgPolicy("enterprise");
    expect(
      resolvePosture({
        root: dir,
        env: {},
        flag: "enterprise",
        flagSource: "cli",
      }),
    ).toEqual({ posture: "enterprise", postureSource: "org-floor" });
  });

  it("uses AIH_ORG_POLICY as an exclusive floor source", () => {
    orgPolicy("team");
    const envPolicy = join(dir, "ops", "org-policy.json");
    orgPolicy("enterprise", envPolicy);

    expect(
      resolvePosture({
        root: dir,
        env: { AIH_ORG_POLICY: envPolicy },
        flag: "vibe",
        flagSource: "cli",
      }),
    ).toEqual({ posture: "enterprise", postureSource: "org-floor" });
  });

  it("fails closed on malformed or invalid org-policy files", () => {
    writeFileSync(join(dir, "aih-org-policy.json"), "{ broken");
    expect(() => resolvePosture({ root: dir, env: {} })).toThrow(/aih-org-policy/);

    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "oops",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );
    expect(() => resolvePosture({ root: dir, env: {} })).toThrow(/org-policy is invalid/);
  });
});
