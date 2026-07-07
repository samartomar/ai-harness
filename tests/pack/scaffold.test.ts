import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AihError } from "../../src/errors.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { PacksFile } from "../../src/pack/manifest.js";
import { packScaffoldCommand } from "../../src/pack/scaffold.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let workspace: string;
let home: string;

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
