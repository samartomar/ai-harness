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
  trustVerifyCommand,
} from "../../src/trust/commands.js";

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
    const dry = await executePlan(
      await trustAllowCommand.plan(ctx({ source: "owner/repo", pin: "a".repeat(40) })),
      ctx({ source: "owner/repo", pin: "a".repeat(40) }),
    );
    expect(dry.writes).toHaveLength(1);
    expect(existsSync(join(root, "aih-org-policy.json"))).toBe(false);

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
    await executePlan(await trustPinCommand.plan(c), c);

    expect(readPolicy()).toMatchObject({
      trust: {
        approvedSources: [{ owner: "owner", repo: "repo", pinnedSha: "b".repeat(40) }],
      },
    });
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
    const result = await executePlan(await trustVerifyCommand.plan(c), c);

    expect(result.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-changed",
          detail: expect.stringContaining("local drift"),
        }),
      ]),
    );
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
});
