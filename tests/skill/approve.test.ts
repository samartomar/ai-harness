import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { skillApproveCommand, skillCardCommand } from "../../src/skill/approve.js";
import { readSkillCard, type SkillCard } from "../../src/skill/card.js";
import type { SkillsLock } from "../../src/skill/lockfile.js";
import type { SkillVetEvidence } from "../../src/skill/vet.js";

const PIN = "a".repeat(40);
const EVIDENCE_REL = `.aih/skill-reports/owner-repo-${PIN.slice(0, 8)}.json`;
const CARD_REL = "ai-coding/skill-cards/clean.json";
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "aih-skill-approve-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown>, apply = false): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: workspace,
    contextDir: "ai-coding",
    apply,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    posture: "vibe",
    options,
  };
}

function write(rel: string, body: string): void {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function evidence(overrides: Partial<SkillVetEvidence> = {}): SkillVetEvidence {
  return {
    schemaVersion: 1,
    source: `owner/repo@${PIN}`,
    pinnedSha: PIN,
    shape: {
      skillDirs: ["clean"],
      installScripts: false,
      mcpConfig: false,
      packageManifests: [],
      fullCodebaseAnalysis: false,
    },
    checks: [{ name: "skill license", verdict: "pass", detail: "LICENSE: MIT License" }],
    analyzersRun: ["aih-native", "skillspector@docker"],
    verdict: "GREEN",
    reasons: [],
    ...overrides,
  };
}

function writeEvidence(body: SkillVetEvidence, rel = EVIDENCE_REL): void {
  write(rel, JSON.stringify(body, null, 2));
}

function evidenceSha(rel = EVIDENCE_REL): string {
  return createHash("sha256")
    .update(readFileSync(join(workspace, rel)))
    .digest("hex");
}

function approveOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { source: "owner/repo", pin: PIN, owner: "docs-platform", ...extra };
}

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(workspace, rel), "utf8")) as T;
}

describe("skillApproveCommand", () => {
  it("approves a GREEN GitHub source — card, lockfile, and org-policy written under --apply", async () => {
    writeEvidence(evidence());
    const sha = evidenceSha();
    const c = ctx(
      approveOptions({
        pack: "docs-quality",
        intendedUse: "Docs hygiene review.",
        mode: "review-only",
      }),
      true,
    );

    const result = await executePlan(await skillApproveCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
    const card = readJson<SkillCard>(CARD_REL);
    expect(card).toMatchObject({
      schemaVersion: 1,
      name: "clean",
      source: `owner/repo@${PIN}`,
      commit: PIN,
      license: "MIT License",
      owner: "docs-platform",
      pack: "docs-quality",
      intendedUse: "Docs hygiene review.",
      installScope: "repo",
      riskClass: "green",
      mode: "review-only",
      requiresMcp: false,
      requiresShell: false,
      scanEvidence: [EVIDENCE_REL],
    });
    expect(card.approval).toMatchObject({ verdict: "GREEN", approvedBy: "docs-platform" });
    expect(card.approval?.approvedAt).toMatch(ISO_TIMESTAMP);

    const lock = readJson<SkillsLock>("aih-skills.lock.json");
    expect(lock.schemaVersion).toBe(1);
    expect(lock.skills).toHaveLength(1);
    expect(lock.skills[0]).toMatchObject({
      name: "clean",
      source: `owner/repo@${PIN}`,
      commit: PIN,
      verdict: "GREEN",
      pack: "docs-quality",
      scope: "repo",
      card: CARD_REL,
      evidenceSha256: sha,
      approvedBy: "docs-platform",
    });
    expect(lock.skills[0]?.approvedAt).toMatch(ISO_TIMESTAMP);

    const policy = readJson<{ trust?: { approvedSources?: unknown[] } }>("aih-org-policy.json");
    expect(policy.trust?.approvedSources).toEqual([
      expect.objectContaining({ owner: "owner", repo: "repo", pinnedSha: PIN }),
    ]);
  });

  it("approves a YELLOW verdict — approve IS the manual review", async () => {
    writeEvidence(
      evidence({
        verdict: "YELLOW",
        reasons: ["shape: install scripts present"],
        shape: {
          skillDirs: ["clean"],
          installScripts: true,
          mcpConfig: false,
          packageManifests: [],
          fullCodebaseAnalysis: false,
        },
      }),
    );
    const c = ctx(approveOptions(), true);

    const result = await executePlan(await skillApproveCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
    const card = readJson<SkillCard>(CARD_REL);
    expect(card.riskClass).toBe("yellow");
    expect(card.requiresShell).toBe(true);
    expect(card.approval?.verdict).toBe("YELLOW");
    expect(readJson<SkillsLock>("aih-skills.lock.json").skills[0]?.verdict).toBe("YELLOW");
  });

  it("refuses a RED verdict as blocked", () => {
    writeEvidence(
      evidence({
        verdict: "RED",
        reasons: ["proven-dangerous finding trust.prompt-injection: exfil prompt"],
      }),
    );

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      /RED — blocked[\s\S]*trust\.prompt-injection/,
    );
  });

  it("refuses an UNKNOWN verdict and names the evidence gaps", () => {
    writeEvidence(
      evidence({
        verdict: "UNKNOWN",
        reasons: [
          "source was not fetched; scan evidence is insufficient",
          "no license was found at the source root",
        ],
      }),
    );

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      /UNKNOWN — evidence insufficient[\s\S]*source was not fetched[\s\S]*no license was found/,
    );
  });

  it("refuses when no evidence artifact exists, pointing at skill vet --apply", () => {
    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      `no vet evidence at ${EVIDENCE_REL} for owner/repo@${PIN}; run \`aih skill vet owner/repo --pin ${PIN} --apply\` first`,
    );
  });

  it("refuses unreadable evidence with the regenerate hint", () => {
    write(EVIDENCE_REL, "{ not json");

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(/is unreadable/);
  });

  it("refuses evidence recorded for a different commit than --pin", () => {
    writeEvidence(evidence({ pinnedSha: "b".repeat(40) }));

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      /records commit b{40}, not --pin a{40}/,
    );
  });

  it("refuses without --owner", () => {
    writeEvidence(evidence());

    expect(() => skillApproveCommand.plan(ctx({ source: "owner/repo", pin: PIN }))).toThrow(
      /--owner <team>/,
    );
  });

  it("refuses an unpinned GitHub source", () => {
    expect(() =>
      skillApproveCommand.plan(ctx({ source: "owner/repo", owner: "docs-platform" })),
    ).toThrow(/--pin <full-sha>/);
  });

  it("refuses when org-policy requiredChecks are unmet", () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        trust: { requiredChecks: ["no-exec", "skillspector"] },
      }),
    );
    writeEvidence(
      evidence({
        verdict: "YELLOW",
        reasons: ["shape: install scripts present"],
        shape: {
          skillDirs: ["clean"],
          installScripts: true,
          mcpConfig: false,
          packageManifests: [],
          fullCodebaseAnalysis: false,
        },
        analyzersRun: ["aih-native"],
      }),
    );

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      /requiredChecks are unmet[\s\S]*no-exec — shape records install scripts[\s\S]*skillspector — detector missing/,
    );
  });

  it("approves when every org-policy requiredCheck is met", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        trust: { requiredChecks: ["license", "pin", "no-exec", "no-mcp", "skillspector"] },
      }),
    );
    writeEvidence(evidence());
    const c = ctx(approveOptions(), true);

    const result = await executePlan(await skillApproveCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
    const digest = result.digests.find((d) => d.describe === "skill approve summary");
    expect(digest?.text).toContain(
      "org-policy required checks: license, pin, no-exec, no-mcp, skillspector — all met",
    );
  });

  it("refuses a multi-skill source without --name and lists the candidates", () => {
    writeEvidence(
      evidence({
        shape: {
          skillDirs: ["clean", "extra"],
          installScripts: false,
          mcpConfig: false,
          packageManifests: [],
          fullCodebaseAnalysis: false,
        },
      }),
    );

    expect(() => skillApproveCommand.plan(ctx(approveOptions()))).toThrow(
      /holds 2 skills — pass --name to pick one of: clean, extra/,
    );
  });

  it("approves a multi-skill source when --name picks one", async () => {
    writeEvidence(
      evidence({
        shape: {
          skillDirs: ["clean", "extra"],
          installScripts: false,
          mcpConfig: false,
          packageManifests: [],
          fullCodebaseAnalysis: false,
        },
      }),
    );
    const c = ctx(approveOptions({ name: "extra" }), true);

    const result = await executePlan(await skillApproveCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
    expect(readJson<SkillCard>("ai-coding/skill-cards/extra.json").name).toBe("extra");
    expect(readJson<SkillsLock>("aih-skills.lock.json").skills[0]?.name).toBe("extra");
  });

  it("approves a local source with commit 'local' and no org-policy write", async () => {
    const parent = mkdtempSync(join(tmpdir(), "aih-skill-approve-src-"));
    const sourceRoot = join(parent, "clean-skill");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "SKILL.md"), "# Clean\n", "utf8");
    try {
      writeEvidence(
        evidence({ source: sourceRoot, pinnedSha: undefined }),
        ".aih/skill-reports/clean-skill-local.json",
      );
      const c = ctx({ source: sourceRoot, owner: "docs-platform" }, true);

      const result = await executePlan(await skillApproveCommand.plan(c), c);

      expect(result.report?.ok).toBe(true);
      const card = readJson<SkillCard>(CARD_REL);
      expect(card.commit).toBe("local");
      expect(card.scanEvidence).toEqual([".aih/skill-reports/clean-skill-local.json"]);
      expect(readJson<SkillsLock>("aih-skills.lock.json").skills[0]?.commit).toBe("local");
      expect(existsSync(join(workspace, "aih-org-policy.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("dry-run writes nothing and keeps the digest byte-stable with no clock", async () => {
    writeEvidence(evidence());
    const c = ctx(approveOptions());

    const result = await executePlan(await skillApproveCommand.plan(c), c);

    expect(result.applied).toBe(false);
    expect(result.writes.map((w) => w.path)).toEqual([
      CARD_REL,
      "aih-skills.lock.json",
      "aih-org-policy.json",
    ]);
    expect(existsSync(join(workspace, "ai-coding"))).toBe(false);
    expect(existsSync(join(workspace, "aih-skills.lock.json"))).toBe(false);
    expect(existsSync(join(workspace, "aih-org-policy.json"))).toBe(false);
    const digest = result.digests.find((d) => d.describe === "skill approve summary");
    expect(digest?.text).toContain("Approved at: (set at apply)");
    expect(digest?.text).toContain("Enforcement:");
    expect(digest?.text).not.toMatch(ISO_TIMESTAMP);
    expect(JSON.stringify(digest?.data)).not.toMatch(ISO_TIMESTAMP);

    const again = ctx(approveOptions());
    const rerun = await executePlan(await skillApproveCommand.plan(again), again);
    expect(rerun.digests.find((d) => d.describe === "skill approve summary")?.text).toBe(
      digest?.text,
    );
  });

  it("replaces the lockfile entry by name and preserves other skills", async () => {
    write(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${"b".repeat(40)}`,
            commit: "b".repeat(40),
            verdict: "YELLOW",
            scope: "repo",
            card: CARD_REL,
            evidenceSha256: "0".repeat(64),
            approvedBy: "old-team",
            approvedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            name: "other",
            source: `acme/other@${"c".repeat(40)}`,
            commit: "c".repeat(40),
            verdict: "GREEN",
            scope: "repo",
            card: "ai-coding/skill-cards/other.json",
            evidenceSha256: "1".repeat(64),
            approvedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    writeEvidence(evidence());
    const c = ctx(approveOptions(), true);

    await executePlan(await skillApproveCommand.plan(c), c);

    const lock = readJson<SkillsLock>("aih-skills.lock.json");
    expect(lock.skills.map((s) => s.name)).toEqual(["clean", "other"]);
    const clean = lock.skills.find((s) => s.name === "clean");
    expect(clean?.commit).toBe(PIN);
    expect(clean?.verdict).toBe("GREEN");
    expect(clean?.approvedBy).toBe("docs-platform");
    expect(lock.skills.find((s) => s.name === "other")?.commit).toBe("c".repeat(40));
  });
});

describe("skillCardCommand", () => {
  it("previews the card JSON without an approval block in dry-run", async () => {
    writeEvidence(evidence());
    const c = ctx({ source: "owner/repo", pin: PIN });

    const result = await executePlan(await skillCardCommand.plan(c), c);

    expect(result.applied).toBe(false);
    expect(existsSync(join(workspace, "ai-coding"))).toBe(false);
    const digest = result.digests.find((d) => d.describe === "skill card");
    expect(digest?.text).toContain(`Card: ${CARD_REL}`);
    expect(digest?.text).toContain('"name": "clean"');
    expect(digest?.text).toContain('"riskClass": "green"');
    expect(digest?.text).not.toContain('"approval"');
    const data = digest?.data as { path: string; card: SkillCard };
    expect(data.path).toBe(CARD_REL);
    expect(data.card.approval).toBeUndefined();
  });

  it("writes the card under --apply without requiring --owner and touches nothing else", async () => {
    writeEvidence(evidence());
    const c = ctx({ source: "owner/repo", pin: PIN, pack: "docs-quality" }, true);

    const result = await executePlan(await skillCardCommand.plan(c), c);

    expect(result.report?.ok).toBe(true);
    const card = readJson<SkillCard>(CARD_REL);
    expect(card.owner).toBeUndefined();
    expect(card.approval).toBeUndefined();
    expect(card.pack).toBe("docs-quality");
    expect(existsSync(join(workspace, "aih-skills.lock.json"))).toBe(false);
    expect(existsSync(join(workspace, "aih-org-policy.json"))).toBe(false);
  });

  it("refuses an unpinned GitHub source (evidence cannot be located)", () => {
    expect(() => skillCardCommand.plan(ctx({ source: "owner/repo" }))).toThrow(/--pin <full-sha>/);
  });

  it("refuses evidence whose license is missing", () => {
    writeEvidence(
      evidence({
        checks: [
          {
            name: "skill license",
            verdict: "fail",
            code: "trust.license-missing",
            detail: "no LICENSE file at the source root",
          },
        ],
        verdict: "YELLOW",
        reasons: ["finding requires manual review — example"],
      }),
    );

    expect(() => skillCardCommand.plan(ctx({ source: "owner/repo", pin: PIN }))).toThrow(
      /no license recorded/,
    );
  });
});

describe("readSkillCard", () => {
  it("reads a written card and fail-softs on missing or malformed ones", async () => {
    writeEvidence(evidence());
    const c = ctx(approveOptions(), true);
    await executePlan(await skillApproveCommand.plan(c), c);

    expect(readSkillCard(workspace, "ai-coding", "clean")?.name).toBe("clean");
    expect(readSkillCard(workspace, "ai-coding", "missing")).toBeUndefined();
    write("ai-coding/skill-cards/broken.json", "{ nope");
    expect(readSkillCard(workspace, "ai-coding", "broken")).toBeUndefined();
  });
});
