import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import {
  canonicalGovernanceDoctorProfileV1Bytes,
  parseGovernanceDoctorProfileV1Json,
} from "../../src/governance-doctor/profile-v1.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { PacksFile } from "../../src/pack/manifest.js";
import { packScaffoldCommand } from "../../src/pack/scaffold.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let workspace: string;
let home: string;
const repositoryRoot = resolve(__dirname, "..", "..");

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-pack-scaffold-"));
  home = mkdtempSync(join(tmpdir(), "aih-pack-scaffold-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(opts: { apply?: boolean; options?: Record<string, unknown> } = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: "ai-coding",
    apply: opts.apply ?? false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options: opts.options ?? {},
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function manifestOnDisk(): PacksFile {
  return JSON.parse(readFileSync(join(workspace, "aih-packs.json"), "utf8")) as PacksFile;
}

async function applyScaffold(): Promise<Awaited<ReturnType<typeof executePlan>>> {
  const c = ctx({ apply: true, options: { pack: "docs-quality" } });
  return executePlan(await packScaffoldCommand.plan(c), c);
}

function expectRefusal(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    throw new Error("expected an AIH_TRUST refusal");
  } catch (e) {
    expect(e).toBeInstanceOf(AihError);
    expect((e as AihError).code).toBe("AIH_TRUST");
    expect((e as AihError).message).toMatch(pattern);
  }
}

describe("pack scaffold", () => {
  it("ships the governance Audit/Guide source and profile without inventing lifecycle evidence", async () => {
    const sourceProfile = readFileSync(
      resolve(
        repositoryRoot,
        "packs/governance-quality/governance-doctor-audit-guide/profile.json",
      ),
    );
    const sourceSkill = readFileSync(
      resolve(repositoryRoot, "packs/governance-quality/governance-doctor-audit-guide/SKILL.md"),
      "utf8",
    );
    const sourceLicense = readFileSync(
      resolve(repositoryRoot, "packs/governance-quality/governance-doctor-audit-guide/LICENSE"),
    );
    expect(sourceSkill).toContain("license: Apache-2.0");
    expect(sourceSkill).not.toMatch(
      /allowed-tools:|\b(?:shell|mcp|network|process|scan|signing)\b/i,
    );
    expect(sourceSkill).not.toMatch(/`[^`]*`|\baih\s+(?:doctor|status|policy|pack|skill)\b/i);
    const parsed = parseGovernanceDoctorProfileV1Json(sourceProfile);
    expect(parsed.governanceDoctorProfileSha256).toBe(
      "a9bcdad3ab14d82a08b01e42ec78d154b57f9e987c5d4c0824002ad3f0e8b632",
    );
    expect(canonicalGovernanceDoctorProfileV1Bytes(parsed).equals(sourceProfile)).toBe(true);

    const preview = await executePlan(
      await packScaffoldCommand.plan(ctx({ options: { pack: "governance-quality" } })),
      ctx({ options: { pack: "governance-quality" } }),
    );
    expect(preview.applied).toBe(false);
    expect(
      existsSync(
        join(workspace, "packs/governance-quality/governance-doctor-audit-guide/SKILL.md"),
      ),
    ).toBe(false);

    const applyContext = ctx({ apply: true, options: { pack: "governance-quality" } });
    await executePlan(await packScaffoldCommand.plan(applyContext), applyContext);
    expect(
      existsSync(
        join(workspace, "packs/governance-quality/governance-doctor-audit-guide/SKILL.md"),
      ),
    ).toBe(true);
    expect(
      readFileSync(
        join(workspace, "packs/governance-quality/governance-doctor-audit-guide/SKILL.md"),
      ).equals(Buffer.from(sourceSkill, "utf8")),
    ).toBe(true);
    expect(
      readFileSync(
        join(workspace, "packs/governance-quality/governance-doctor-audit-guide/profile.json"),
      ).equals(sourceProfile),
    ).toBe(true);
    expect(
      readFileSync(
        join(workspace, "packs/governance-quality/governance-doctor-audit-guide/LICENSE"),
      ).equals(sourceLicense),
    ).toBe(true);
    expect(existsSync(join(workspace, "aih-skills.lock.json"))).toBe(false);
    expect(existsSync(join(workspace, ".aih/skill-reports"))).toBe(false);
    expect(
      existsSync(join(workspace, "ai-coding/skill-cards/governance-doctor-audit-guide.md")),
    ).toBe(false);
    expect(manifestOnDisk().packs.find((pack) => pack.name === "governance-quality")).toEqual(
      expect.objectContaining({ name: "governance-quality" }),
    );
  });

  it("previews first-party pack files and manifest curation without writing", async () => {
    const c = ctx({ options: { pack: "docs-quality" } });
    const result = await executePlan(await packScaffoldCommand.plan(c), c);

    expect(result.applied).toBe(false);
    expect(result.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "packs/docs-quality/betterdoc/SKILL.md",
          effect: "create",
        }),
        expect.objectContaining({ path: "aih-packs.json", effect: "create" }),
      ]),
    );
    expect(existsSync(join(workspace, "packs/docs-quality/betterdoc/SKILL.md"))).toBe(false);
    const digest = result.digests.find((d) => d.describe === "pack scaffold");
    expect(digest?.text).toContain("aih skill vet packs/docs-quality/betterdoc --apply");
    expect(digest?.text).toContain("aih pack install --pack docs-quality --apply");
  });

  it("applies the first-party pack files and manifest without inventing approvals", async () => {
    const result = await applyScaffold();

    expect(result.applied).toBe(true);
    expect(
      readFileSync(join(workspace, "packs/docs-quality/betterdoc/SKILL.md"), "utf8"),
    ).toContain("BetterDoc");
    expect(manifestOnDisk().packs).toEqual([
      expect.objectContaining({
        name: "docs-quality",
        skills: [{ name: "betterdoc", source: "packs/docs-quality/betterdoc", commit: "local" }],
      }),
    ]);
    expect(existsSync(join(workspace, "aih-skills.lock.json"))).toBe(false);
  });

  it("is idempotent once the pack has already been scaffolded", async () => {
    await applyScaffold();
    const result = await applyScaffold();

    expect(result.backups).toEqual([]);
    expect(result.writes.every((write) => write.effect === "unchanged")).toBe(true);
  });

  it("refuses when the requested first-party pack is unknown", () => {
    expectRefusal(
      () => packScaffoldCommand.plan(ctx({ options: { pack: "ghost" } })),
      /unknown first-party pack ghost[\s\S]*docs-quality/,
    );
  });

  it("refuses when the scaffolded skill is already curated by another pack", () => {
    write(
      "aih-packs.json",
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            name: "other",
            skills: [{ name: "betterdoc", source: "somewhere", commit: "local" }],
          },
        ],
      }),
    );

    expectRefusal(
      () => packScaffoldCommand.plan(ctx({ options: { pack: "docs-quality" } })),
      /skill betterdoc is already curated in pack other/,
    );
  });
});
