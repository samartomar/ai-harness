import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AIH_MARKETPLACE_FILE,
  MarketplaceManifestSchema,
  marketplaceRelPathSchema,
  readMarketplaceManifest,
} from "../../src/marketplace/manifest.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-marketplace-manifest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEX = "a".repeat(64);

/** A minimal schema-valid manifest body. */
function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name: "acme-skills",
    skills: [
      {
        name: "clean",
        source: `owner/repo@${"a".repeat(40)}`,
        commit: "a".repeat(40),
        verdict: "GREEN",
        license: "MIT License",
        riskClass: "green",
        card: "cards/clean.json",
        evidence: "evidence/owner-repo-aaaaaaaa.json",
        files: [{ path: "skills/clean/SKILL.md", sha256: HEX, bytes: 10 }],
      },
    ],
  };
}

describe("marketplaceRelPathSchema — the artifact path guard", () => {
  it("accepts forward-slash relative paths", () => {
    for (const path of ["SKILL.md", "skills/clean/SKILL.md", "cards/a/b.json"]) {
      expect(marketplaceRelPathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it("rejects traversal, absolute, drive, backslash, empty-segment, and control-char paths", () => {
    const hostile = [
      "../escape",
      "skills/../../escape",
      "/abs/path",
      "C:/windows/system32",
      "skills\\clean\\SKILL.md",
      "skills//clean",
      "skills/./clean",
      "skills/..",
      "",
      "skills/cle\u0000an",
    ];
    for (const path of hostile) {
      expect(marketplaceRelPathSchema.safeParse(path).success, JSON.stringify(path)).toBe(false);
    }
  });
});

/** The valid manifest with its single skill entry shallow-overridden. */
function manifestWithSkill(over: Record<string, unknown>): Record<string, unknown> {
  const base = validManifest();
  const first = (base.skills as Array<Record<string, unknown>>)[0];
  return { ...base, skills: [{ ...first, ...over }] };
}

describe("MarketplaceManifestSchema — strict shape", () => {
  it("accepts a valid manifest (stamp optional)", () => {
    expect(MarketplaceManifestSchema.safeParse(validManifest()).success).toBe(true);
    expect(
      MarketplaceManifestSchema.safeParse({ ...validManifest(), stamp: "2026-07-01T00:00:00Z" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown keys, a value that is not a vet verdict, and empty files", () => {
    expect(MarketplaceManifestSchema.safeParse({ ...validManifest(), extra: 1 }).success).toBe(
      false,
    );
    expect(
      MarketplaceManifestSchema.safeParse(manifestWithSkill({ verdict: "BLOCKED" })).success,
    ).toBe(false);
    expect(MarketplaceManifestSchema.safeParse(manifestWithSkill({ files: [] })).success).toBe(
      false,
    );
  });

  it("accepts every vet verdict as the skill's label", () => {
    for (const verdict of ["GREEN", "YELLOW", "RED", "UNKNOWN"]) {
      expect(MarketplaceManifestSchema.safeParse(manifestWithSkill({ verdict })).success).toBe(
        true,
      );
    }
  });

  it("rejects a traversal path inside files[]", () => {
    const bad = manifestWithSkill({ files: [{ path: "../outside", sha256: HEX, bytes: 1 }] });
    expect(MarketplaceManifestSchema.safeParse(bad).success).toBe(false);
  });
});

describe("readMarketplaceManifest — the fail-closed result read", () => {
  function write(body: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marketplace.json"), body, "utf8");
  }

  it("reports an absent manifest", () => {
    const read = readMarketplaceManifest(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("missing");
  });

  it("reports unparseable JSON as a reason, never a throw", () => {
    write("{ not json");
    const read = readMarketplaceManifest(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("not valid JSON");
  });

  it("reports a schema violation with the failing path", () => {
    write(JSON.stringify(manifestWithSkill({ verdict: "BLOCKED" })));
    const read = readMarketplaceManifest(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("schema validation");
  });

  it("returns the parsed manifest for a valid file", () => {
    write(JSON.stringify(validManifest()));
    const read = readMarketplaceManifest(dir);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.manifest.name).toBe("acme-skills");
      expect(read.manifest.skills[0]?.verdict).toBe("GREEN");
    }
  });
});

describe("marketplace manifest schema versions (D50 upgrade)", () => {
  function write(manifest: Record<string, unknown>): void {
    writeFileSync(join(dir, AIH_MARKETPLACE_FILE), JSON.stringify(manifest));
  }
  function withVerdict(schemaVersion: number, verdict: string): Record<string, unknown> {
    const manifest = validManifest();
    const [skill] = manifest.skills as Record<string, unknown>[];
    return { ...manifest, schemaVersion, skills: [{ ...skill, verdict }] };
  }

  it("still loads a 0.6.2-era version-1 manifest", () => {
    write(withVerdict(1, "YELLOW"));
    const read = readMarketplaceManifest(dir);
    expect(read.ok && read.manifest.schemaVersion).toBe(1);
  });

  it("refuses a version-1 manifest carrying a verdict outside version 1's value set", () => {
    for (const verdict of ["RED", "UNKNOWN"]) {
      write(withVerdict(1, verdict));
      expect(readMarketplaceManifest(dir)).toMatchObject({ ok: false });
    }
  });

  it("reads every vet verdict from a version-2 manifest", () => {
    write(withVerdict(2, "RED"));
    const read = readMarketplaceManifest(dir);
    expect(read.ok && read.manifest.skills[0]?.verdict).toBe("RED");
    expect(MarketplaceManifestSchema.safeParse(withVerdict(3, "GREEN")).success).toBe(false);
  });
});
