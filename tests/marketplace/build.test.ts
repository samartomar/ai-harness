import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plan, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { marketplaceBuildCommand } from "../../src/marketplace/build.js";
import type { MarketplaceManifest } from "../../src/marketplace/manifest.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const PIN = "a".repeat(40);
const CONTEXT_DIR = "ai-coding";

let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-marketplace-build-"));
  home = mkdtempSync(join(tmpdir(), "aih-marketplace-build-home-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A ctx over the temp workspace (like remove.test.ts): a no-op fake runner and
 * USERPROFILE/HOME isolated to a temp home so the machine skill root is hermetic.
 */
function ctx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: CONTEXT_DIR,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { USERPROFILE: home, HOME: home } }),
    env: { USERPROFILE: home, HOME: home },
    posture: "vibe",
    options,
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface LockEntryInput {
  name: string;
  evidenceSha256?: string;
}

/** Write a committed lockfile whose entries default to the seeded evidence hash. */
function writeLock(entries: LockEntryInput[]): void {
  write(
    "aih-skills.lock.json",
    JSON.stringify({
      schemaVersion: 1,
      skills: entries.map((e) => ({
        name: e.name,
        source: `owner/repo@${PIN}`,
        commit: PIN,
        verdict: "GREEN",
        scope: "repo",
        card: `${CONTEXT_DIR}/skill-cards/${e.name}.json`,
        evidenceSha256: e.evidenceSha256 ?? sha(evidenceBody(e.name)),
        approvedBy: "docs-platform",
        approvedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
}

/** A minimal valid committed SkillCard body (like remove.test.ts's). */
function validCard(name: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    source: `owner/repo@${PIN}`,
    commit: PIN,
    license: "MIT License",
    installScope: "repo",
    riskClass: "green",
    requiresMcp: false,
    requiresShell: false,
    scanEvidence: [`.aih/skill-reports/owner-repo-${name}.json`],
  };
}

/** Deterministic vet-evidence body for a skill (content-addressed by the lock). */
function evidenceBody(name: string): string {
  return `{"schemaVersion":1,"verdict":"GREEN","skill":"${name}"}\n`;
}

/** Skill files + committed card + vet evidence for one approved promoted skill. */
function seedInstalled(name: string): void {
  write(join(CONTEXT_DIR, "skills", "owner-repo", name, "SKILL.md"), `# ${name}\n`);
  write(`${CONTEXT_DIR}/skill-cards/${name}.json`, `${JSON.stringify(validCard(name))}\n`);
  write(`.aih/skill-reports/owner-repo-${name}.json`, evidenceBody(name));
}

/** The plan's write actions keyed by forward-slashed path. */
function writesByPath(plan: Plan): Record<string, WriteAction> {
  return Object.fromEntries(
    plan.actions
      .filter((a): a is WriteAction => a.kind === "write")
      .map((w) => [w.path.replace(/\\/g, "/"), w]),
  );
}

function manifestOf(plan: Plan, out = ".aih/marketplace"): MarketplaceManifest {
  return writesByPath(plan)[`${out}/marketplace.json`]?.json as MarketplaceManifest;
}

/** Await the plan through an async frame so a sync refusal becomes a rejection. */
const planOf = async (c: PlanContext) => marketplaceBuildCommand.plan(c);

describe("marketplace build — the packaged approval set", () => {
  it("packages every approved skill: vetted files, card, evidence, manifest, SHA256SUMS", async () => {
    // Seeded out of name order to prove the artifact is name-sorted, not lock-ordered.
    seedInstalled("beta");
    seedInstalled("alpha");
    write(join(CONTEXT_DIR, "skills", "owner-repo", "alpha", "notes", "usage.md"), "usage\n");
    writeLock([{ name: "beta" }, { name: "alpha" }]);

    const out = writesByPath(await planOf(ctx()));
    expect(out[".aih/marketplace/skills/alpha/SKILL.md"]?.contents).toBe("# alpha\n");
    expect(out[".aih/marketplace/skills/alpha/notes/usage.md"]?.contents).toBe("usage\n");
    expect(out[".aih/marketplace/skills/beta/SKILL.md"]?.contents).toBe("# beta\n");
    expect(out[".aih/marketplace/cards/alpha.json"]?.contents).toBe(
      `${JSON.stringify(validCard("alpha"))}\n`,
    );
    expect(out[".aih/marketplace/evidence/owner-repo-alpha.json"]?.contents).toBe(
      evidenceBody("alpha"),
    );

    const manifest = manifestOf(await planOf(ctx()));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    const alpha = manifest.skills[0];
    expect(alpha).toMatchObject({
      source: `owner/repo@${PIN}`,
      commit: PIN,
      verdict: "GREEN",
      license: "MIT License",
      riskClass: "green",
      card: "cards/alpha.json",
      evidence: "evidence/owner-repo-alpha.json",
    });
    expect(alpha?.files.map((f) => f.path).sort()).toEqual([
      "skills/alpha/SKILL.md",
      "skills/alpha/notes/usage.md",
    ]);
    const skillMd = alpha?.files.find((f) => f.path === "skills/alpha/SKILL.md");
    expect(skillMd).toEqual({
      path: "skills/alpha/SKILL.md",
      sha256: sha("# alpha\n"),
      bytes: Buffer.byteLength("# alpha\n", "utf8"),
    });

    // SHA256SUMS covers every emitted file except itself — bundle's line format.
    const sums = out[".aih/marketplace/SHA256SUMS"]?.contents ?? "";
    expect(sums).toContain(`${sha("# alpha\n")}  skills/alpha/SKILL.md`);
    expect(sums).toContain("  cards/beta.json");
    expect(sums).toContain("  evidence/owner-repo-beta.json");
    expect(sums).toContain("  marketplace.json");
    expect(sums).not.toContain("SHA256SUMS");
  });

  it("is byte-identical across two plans from identical inputs (reproducible)", async () => {
    seedInstalled("alpha");
    seedInstalled("beta");
    writeLock([{ name: "alpha" }, { name: "beta" }]);

    const serialize = (plan: Plan): string =>
      JSON.stringify(
        plan.actions
          .filter((a): a is WriteAction => a.kind === "write")
          .map((w) => [w.path, w.contents ?? JSON.stringify(w.json)]),
      );
    expect(serialize(await planOf(ctx()))).toBe(serialize(await planOf(ctx())));
  });

  it("records --stamp verbatim and omits the key when absent (never the clock)", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    expect(manifestOf(await planOf(ctx())).stamp).toBeUndefined();
    const stamped = manifestOf(await planOf(ctx({ stamp: "2026-07-01T00:00:00Z" })));
    expect(stamped.stamp).toBe("2026-07-01T00:00:00Z");
  });

  it("names the manifest after the repo root by default, --name overrides", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    expect(manifestOf(await planOf(ctx())).name).toBe(basename(workspace));
    expect(manifestOf(await planOf(ctx({ name: "acme-skills" }))).name).toBe("acme-skills");
  });

  it("marks every write external for an absolute --out", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    const outDir = join(workspace, "dist-market");
    const plan = await planOf(ctx({ out: outDir }));
    const writes = plan.actions.filter((a): a is WriteAction => a.kind === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.external).toBe(true);
      expect(w.path.includes("\\")).toBe(false);
    }
  });

  it("declares the command shape (write command, options only)", () => {
    expect(marketplaceBuildCommand.readOnly).toBeUndefined();
    expect(marketplaceBuildCommand.options?.map((o) => o.flags)).toEqual([
      "--out <dir>",
      "--name <name>",
      "--stamp <iso>",
    ]);
  });

  it("digests name-sorted per-skill rows and the consume-channel note", async () => {
    seedInstalled("beta");
    seedInstalled("alpha");
    writeLock([{ name: "beta" }, { name: "alpha" }]);
    const plan = await planOf(ctx());
    const digest = plan.actions.find((a) => a.kind === "digest");
    const text = digest?.kind === "digest" ? (digest.text ?? "") : "";
    expect(text).toContain("2 skill(s)");
    expect(text).toContain(`- alpha  GREEN  ${PIN.slice(0, 12)}  1 file(s)`);
    expect(text).toContain(`- beta  GREEN  ${PIN.slice(0, 12)}  1 file(s)`);
    expect(text.indexOf("- alpha")).toBeLessThan(text.indexOf("- beta"));
    expect(text).toContain("`aih workspace add`");
    expect(text).toContain("the vet gate still runs at consume time");
  });
});

describe("marketplace build — fail-closed refusals", () => {
  it("refuses an empty approval lock (nothing to package)", async () => {
    await expect(planOf(ctx())).rejects.toThrow(/nothing approved to package/);
  });

  it("refuses fail-closed when the only lock entry has a hostile traversal name", async () => {
    // The fail-soft lock read drops the unsafe entry, so the hostile name can
    // never steer a path — the build sees an empty approval set and refuses.
    write(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          {
            name: "../../escape",
            source: `owner/repo@${PIN}`,
            commit: PIN,
            verdict: "GREEN",
            scope: "repo",
            card: `${CONTEXT_DIR}/skill-cards/escape.json`,
            evidenceSha256: "0".repeat(64),
            approvedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await expect(planOf(ctx())).rejects.toThrow(/nothing approved to package/);
  });

  it("refuses an approved skill with no on-disk install", async () => {
    writeLock([{ name: "ghost" }]);
    await expect(planOf(ctx())).rejects.toThrow(/ghost is approved but not installed/);
  });

  it("treats a quarantined-only copy as not installed", async () => {
    writeLock([{ name: "parked" }]);
    write(`.aih/quarantine/${CONTEXT_DIR}/skills/owner-repo/parked/SKILL.md`, "# parked\n");
    await expect(planOf(ctx())).rejects.toThrow(/parked is approved but not installed/);
  });

  it("refuses a stale-pin skill (on-disk copy drifted from its approval)", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            pinnedSha: "b".repeat(40), // ≠ the approved commit → stale-pin
            promotedAt: "2026-01-01T00:00:00.000Z",
            promotedSkills: ["alpha"],
            analyzersRun: [],
            artifactHashes: [],
          },
        ],
      }),
    );
    await expect(planOf(ctx())).rejects.toThrow(/drifted from its approval/);
  });

  it("refuses an ambiguous name with more than one physical install", async () => {
    write(join(CONTEXT_DIR, "skills", "src-a", "dup", "SKILL.md"), "# dup\n");
    write(join(CONTEXT_DIR, "skills", "src-b", "dup", "SKILL.md"), "# dup\n");
    write(`${CONTEXT_DIR}/skill-cards/dup.json`, `${JSON.stringify(validCard("dup"))}\n`);
    write(".aih/skill-reports/owner-repo-dup.json", evidenceBody("dup"));
    writeLock([{ name: "dup" }]);
    await expect(planOf(ctx())).rejects.toThrow(/2 physical installs — ambiguous/);
  });

  it("refuses case-varying names whose artifact paths collide on case-insensitive filesystems", async () => {
    // `Greeter` (repo .claude root) and `greeter` (promoted root) are separately
    // valid, unambiguous installs — but `skills/Greeter/…` and `skills/greeter/…`
    // fold to ONE physical path on the case-insensitive filesystems (Windows/
    // macOS defaults) the artifact is built or consumed on, so the last write
    // would silently clobber the other skill. Shared content-addressed evidence
    // keeps the fixture valid on case-insensitive hosts too.
    const evidence = evidenceBody("shared");
    write(".aih/skill-reports/owner-repo-shared.json", evidence);
    write(join(CONTEXT_DIR, "skills", "owner-repo", "greeter", "SKILL.md"), "# greeter\n");
    write(join(".claude", "skills", "Greeter", "SKILL.md"), "# Greeter\n");
    write(`${CONTEXT_DIR}/skill-cards/greeter.json`, `${JSON.stringify(validCard("greeter"))}\n`);
    write(`${CONTEXT_DIR}/skill-cards/Greeter.json`, `${JSON.stringify(validCard("Greeter"))}\n`);
    writeLock([
      { name: "Greeter", evidenceSha256: sha(evidence) },
      { name: "greeter", evidenceSha256: sha(evidence) },
    ]);
    await expect(planOf(ctx())).rejects.toThrow(/case-insensitive/);
  });

  it("refuses when installed bytes differ from the vetted trust-lock hash", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            pinnedSha: PIN, // matches the approval → not stale-pin
            promotedAt: "2026-01-01T00:00:00.000Z",
            promotedSkills: ["alpha"],
            analyzersRun: [],
            // The vet recorded different bytes than what is installed now.
            artifactHashes: [{ path: "skills/alpha/SKILL.md", sha256: sha("# vetted alpha\n") }],
          },
        ],
      }),
    );
    await expect(planOf(ctx())).rejects.toThrow(/bytes differ from what was vetted/);
  });

  it("refuses when the committed card is missing (approval evidence incomplete)", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha" }]);
    rmSync(join(workspace, CONTEXT_DIR, "skill-cards", "alpha.json"));
    await expect(planOf(ctx())).rejects.toThrow(/committed card missing/);
  });

  it("refuses when no evidence file hashes to the approved evidenceSha256", async () => {
    seedInstalled("alpha");
    writeLock([{ name: "alpha", evidenceSha256: "f".repeat(64) }]);
    await expect(planOf(ctx())).rejects.toThrow(/no file under .aih\/skill-reports/);
  });
});
