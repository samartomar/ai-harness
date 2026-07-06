import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  trustAllowCommand,
  trustListCommand,
  trustPinCommand,
  trustSkillspectorPinCommand,
  trustVerifyCommand,
} from "../../src/trust/commands.js";
import {
  SKILLSPECTOR_IMAGE,
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
} from "../../src/trust/images.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-trust-cmd-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function ctx(options: Record<string, unknown>, apply = false, run?: Runner): PlanContext {
  const env: NodeJS.ProcessEnv = {};
  const runner = run ?? fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: true,
    json: false,
    run: runner,
    host: makeHostAdapter({ platform: "linux", run: runner, env }),
    env,
    posture: "enterprise",
    options,
  };
}

function readPolicy(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "aih-org-policy.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("trust allow/list/pin commands", () => {
  it("allow appends an approved source only when applied", async () => {
    const dryCtx = ctx({ source: "owner/repo", pin: "a".repeat(40) });
    const dryPlan = await trustAllowCommand.plan(dryCtx);
    expect(
      dryPlan.actions.some((action) => action.kind === "probe" && "runStructuredLegacy" in action),
    ).toBe(true);

    const dry = await executePlan(dryPlan, dryCtx);
    expect(dry.writes).toHaveLength(1);
    expect(existsSync(join(root, "aih-org-policy.json"))).toBe(false);
    expect(dry.verification?.results.some((entry) => entry.passName === "trust allow policy")).toBe(
      true,
    );

    const appliedCtx = ctx({ source: "owner/repo", pin: "a".repeat(40) }, true);
    const applied = await executePlan(await trustAllowCommand.plan(appliedCtx), appliedCtx);

    expect(applied.report?.ok).toBe(true);
    expect(readPolicy()).toMatchObject({
      trust: {
        approvedSources: [{ owner: "owner", repo: "repo", pinnedSha: "a".repeat(40) }],
      },
    });
  });

  it("pin refreshes an existing approved source pin", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        trust: { approvedSources: [{ owner: "owner", repo: "repo" }] },
      }),
    );

    const c = ctx({ source: "owner/repo", pin: "b".repeat(40) }, true);
    const pinPlan = await trustPinCommand.plan(c);
    expect(
      pinPlan.actions.some((action) => action.kind === "probe" && "runStructuredLegacy" in action),
    ).toBe(true);

    const result = await executePlan(pinPlan, c);

    expect(readPolicy()).toMatchObject({
      trust: {
        approvedSources: [{ owner: "owner", repo: "repo", pinnedSha: "b".repeat(40) }],
      },
    });
    expect(
      result.verification?.results.some((entry) => entry.passName === "trust pin policy"),
    ).toBe(true);
  });

  it("surfaces malformed policy writes as AIH_TRUST errors", () => {
    write("aih-org-policy.json", "{ broken");

    expect(() => trustAllowCommand.plan(ctx({ source: "owner/repo" }))).toThrow(
      /cannot update aih-org-policy\.json/i,
    );
  });

  it("list labels committed policy and local evidence sources", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        trust: { approvedSources: [{ owner: "owner", repo: "repo", reason: "reviewed" }] },
      }),
    );
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [],
            findings: [],
          },
        ],
      }),
    );

    const result = await executePlan(await trustListCommand.plan(ctx({})), ctx({}));

    expect(result.digests[0]?.text).toContain("Committed policy approved sources");
    expect(result.digests[0]?.text).toContain("owner/repo");
    expect(result.digests[0]?.text).toContain("Local trust-lock evidence");
    expect(result.digests[0]?.text).toContain("owner-repo");
  });

  it("drops malformed legacy trust-lock entries instead of throwing during list", async () => {
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "missing-promoted-skills",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            analyzersRun: ["aih-native"],
            artifactHashes: [],
          },
          {
            id: "missing-artifact-hashes",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
          },
        ],
      }),
    );

    const result = await executePlan(await trustListCommand.plan(ctx({})), ctx({}));

    expect(result.digests[0]?.text).toContain("Local trust-lock evidence");
    expect(result.digests[0]?.text).toContain("  (none)");
  });
});

describe("trust skillspector-pin command", () => {
  it("reports the pinned SkillSpector image tag, upstream commit, and digest", async () => {
    const result = await executePlan(await trustSkillspectorPinCommand.plan(ctx({})), ctx({}));

    expect(result.report?.ok).toBe(true);
    expect(result.digests[0]?.text).toContain(SKILLSPECTOR_IMAGE);
    expect(result.digests[0]?.text).toContain(SKILLSPECTOR_SOURCE_REVISION);
    expect(result.digests[0]?.text).toContain(SKILLSPECTOR_IMAGE_DIGEST);
  });

  it("flags candidate pin bumps with the upstream diff URL before acceptance", async () => {
    const candidateRevision = "b".repeat(40);
    const result = await executePlan(
      await trustSkillspectorPinCommand.plan(
        ctx({
          candidateRevision,
          candidateTag: "skillspector:aih-bbbbbbbbbb",
        }),
      ),
      ctx({
        candidateRevision,
        candidateTag: "skillspector:aih-bbbbbbbbbb",
      }),
    );

    expect(result.report?.exitCode()).toBe(1);
    expect(result.digests[0]?.text).toContain(
      `https://github.com/NVIDIA/SkillSpector/compare/${SKILLSPECTOR_SOURCE_REVISION}...${candidateRevision}`,
    );
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-drift",
          detail: expect.stringContaining("review upstream diff"),
        }),
      ]),
    );
  });

  it("fails candidate pin bumps that omit the upstream revision", async () => {
    const result = await executePlan(
      await trustSkillspectorPinCommand.plan(
        ctx({
          candidateDigest: `sha256:${"e".repeat(64)}`,
          candidateTag: "skillspector:aih-eeeeeeeeee",
        }),
      ),
      ctx({
        candidateDigest: `sha256:${"e".repeat(64)}`,
        candidateTag: "skillspector:aih-eeeeeeeeee",
      }),
    );

    expect(result.report?.exitCode()).toBe(1);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-drift",
          detail: expect.stringContaining("--candidate-revision is required"),
        }),
      ]),
    );
  });

  it("allows a new candidate tag when the upstream revision is unchanged", async () => {
    const candidateTag = "skillspector:aih-same-source";
    const result = await executePlan(
      await trustSkillspectorPinCommand.plan(
        ctx({
          candidateRevision: SKILLSPECTOR_SOURCE_REVISION,
          candidateTag,
        }),
      ),
      ctx({
        candidateRevision: SKILLSPECTOR_SOURCE_REVISION,
        candidateTag,
      }),
    );

    expect(result.report?.ok).toBe(true);
    expect(result.digests[0]?.text).toContain(candidateTag);
    expect(result.digests[0]?.text).not.toContain("Upstream diff:");
    expect(result.report?.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "trust.source-drift",
        }),
      ]),
    );
  });

  it("flags retagging a newer checkout onto the current SkillSpector tag", async () => {
    const candidateRevision = "c".repeat(40);
    const result = await executePlan(
      await trustSkillspectorPinCommand.plan(
        ctx({
          candidateRevision,
          candidateTag: SKILLSPECTOR_IMAGE,
        }),
      ),
      ctx({
        candidateRevision,
        candidateTag: SKILLSPECTOR_IMAGE,
      }),
    );

    expect(result.report?.exitCode()).toBe(1);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-changed",
          detail: expect.stringContaining("retagging existing SkillSpector image tag"),
        }),
      ]),
    );
  });

  it("flags retagging different SkillSpector image bytes onto the current tag", async () => {
    const candidateDigest = `sha256:${"d".repeat(64)}`;
    const result = await executePlan(
      await trustSkillspectorPinCommand.plan(
        ctx({
          candidateDigest,
          candidateTag: SKILLSPECTOR_IMAGE,
        }),
      ),
      ctx({
        candidateDigest,
        candidateTag: SKILLSPECTOR_IMAGE,
      }),
    );

    expect(result.report?.exitCode()).toBe(1);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-changed",
          detail: expect.stringContaining("retagging existing SkillSpector image tag"),
        }),
      ]),
    );
    expect(result.report?.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "trust.source-drift",
          fingerprint: "trust-skillspector-pin:bump:missing-revision",
        }),
      ]),
    );
  });
});

describe("trust verify command", () => {
  function writePromotedLock(sha = "a".repeat(40)): void {
    write("ai-coding/skills/owner-repo/clean/SKILL.md", "# Clean\n");
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: sha,
            promotedAt: "2026-06-30T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [
              {
                path: "skills/clean/SKILL.md",
                sha256: "not-the-current-hash",
              },
            ],
            findings: [],
          },
        ],
      }),
    );
  }

  it("flags changed promoted artifacts as local drift", async () => {
    writePromotedLock();
    const c = ctx({ id: "owner-repo" }, true);
    const verifyPlan = await trustVerifyCommand.plan(c);
    expect(
      verifyPlan.actions
        .filter((action) => action.kind === "probe")
        .every((action) => "runStructuredLegacy" in action),
    ).toBe(true);

    const result = await executePlan(verifyPlan, c);

    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-changed",
          detail: expect.stringContaining("local drift"),
        }),
      ]),
    );
    expect(
      result.verification?.results.some((entry) => entry.passName === "trust local drift"),
    ).toBe(true);
  });

  it("flags moved upstream refs as source drift", async () => {
    writePromotedLock();
    const c = ctx(
      { id: "owner-repo" },
      true,
      fakeRunner((argv) =>
        argv[0] === "git" ? { code: 0, stdout: `${"b".repeat(40)}\trefs/heads/main\n` } : undefined,
      ),
    );
    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-drift",
          detail: expect.stringContaining("main now resolves"),
        }),
      ]),
    );
    expect(
      result.verification?.results.some(
        (entry) => entry.passName === "trust upstream drift" && entry.verdict === "fail",
      ),
    ).toBe(true);
  });

  it("skips upstream drift when ls-remote is blocked", async () => {
    writePromotedLock();
    const c = ctx(
      { id: "owner-repo" },
      true,
      fakeRunner((argv) =>
        argv[0] === "git" ? { code: 127, stderr: "not found", spawnError: true } : undefined,
      ),
    );
    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "skip",
          code: "trust.fetch-blocked",
        }),
      ]),
    );
  });

  it("skips upstream drift without invoking git ls-remote in dry-run", async () => {
    writePromotedLock();
    const gitCalls: string[][] = [];
    const c = ctx(
      { id: "owner-repo" },
      false,
      fakeRunner((argv) => {
        if (argv[0] === "git") gitCalls.push(argv);
        return undefined;
      }),
    );

    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(gitCalls).toEqual([]);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "skip",
          code: "trust.fetch-blocked",
          detail: expect.stringContaining("git ls-remote is skipped in dry-run"),
        }),
      ]),
    );
    expect(
      result.verification?.results.some(
        (entry) => entry.passName === "trust upstream drift" && entry.verdict === "warn",
      ),
    ).toBe(true);
  });

  it("drops malformed legacy trust-lock entries instead of throwing during verify", async () => {
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "legacy",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            analyzersRun: ["aih-native"],
          },
        ],
      }),
    );

    const c = ctx({}, true);
    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(result.report?.checks).toEqual([]);
  });

  it("skips unsafe stored refs before invoking git ls-remote", async () => {
    write(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            ref: "--upload-pack=evil",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [],
            findings: [],
          },
        ],
      }),
    );
    const gitCalls: string[][] = [];
    const c = ctx(
      {},
      true,
      fakeRunner((argv) => {
        if (argv[0] === "git") gitCalls.push(argv);
        return undefined;
      }),
    );

    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(gitCalls).toEqual([]);
    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "skip",
          code: "trust.fetch-blocked",
          detail: expect.stringContaining("unsafe Git ref"),
        }),
      ]),
    );
  });
});
