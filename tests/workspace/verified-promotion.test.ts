import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { VerificationReport } from "../../src/internals/verify.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { AIH_SKILLS_LOCK_FILE } from "../../src/skill/lockfile.js";
import { cleanupQuarantine, resolveTrustSource } from "../../src/trust/fetch.js";
import { TRUST_LOCK_FILE } from "../../src/trust/lock.js";
import {
  captureClearedWorkspaceAddTrustGate,
  issueVerifiedWorkspacePromotion,
  readVerifiedWorkspacePromotion,
} from "../../src/workspace/acquire.js";
import {
  createVerifiedPromotionChannel,
  type VerifiedPromotionSnapshot,
} from "../../src/workspace/verified-promotion.js";

describe("verified promotion channel", () => {
  const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
  const snapshot = (): VerifiedPromotionSnapshot => {
    const contents = Buffer.from("# Clean\n");
    const approval = Buffer.from("{}\n");
    const artifactSha = digest(contents);
    const nextTrustLockBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-08-10T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: artifactSha }],
            findings: [],
          },
        ],
      }),
    );
    return {
      source: {
        id: "owner-repo",
        kind: "github",
        repository: "owner/repo",
        ref: "main",
        pinnedSha: "a".repeat(40),
      },
      selectedSkills: ["clean"],
      files: [
        {
          sourceRel: "skills/clean/SKILL.md",
          targetRel: "ai-coding/skills/owner-repo/clean/SKILL.md",
          contents,
          sha256: artifactSha,
        },
      ],
      artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: artifactSha }],
      nextTrustLockBytes,
      trustLockPreimage: { state: "absent" },
      approvalLockPreimage: {
        sourceBytes: approval,
        sourceSha256: digest(approval),
        mode: 0o644,
      },
    };
  };

  it("does not accept a handle forged outside its issuing channel", () => {
    const left = createVerifiedPromotionChannel();
    const right = createVerifiedPromotionChannel();
    const handle = left.issue(snapshot());
    expect(right.read(handle)).toBeUndefined();
    expect(left.read({ ...handle })).toBeUndefined();
    expect(left.read(new Proxy(handle, {}))).toBeUndefined();
  });

  it("validates hashes and returns fresh deeply isolated snapshots", () => {
    const channel = createVerifiedPromotionChannel();
    const input = snapshot();
    const handle = channel.issue(input);
    input.files[0]?.contents.fill(0);
    const first = channel.read(handle);
    expect(first?.files[0]?.contents.toString()).toBe("# Clean\n");
    first?.files[0]?.contents.fill(0);
    const second = channel.read(handle);
    expect(second?.files[0]?.contents.toString()).toBe("# Clean\n");
    expect(second?.files[0]?.contents).not.toBe(first?.files[0]?.contents);

    const inconsistent = snapshot();
    const inconsistentFile = inconsistent.files[0];
    if (inconsistentFile === undefined) throw new Error("missing fixture file");
    inconsistentFile.sha256 = "f".repeat(64);
    expect(() => channel.issue(inconsistent)).toThrow("invalid verified promotion snapshot");
  });

  it("accepts authority preimages without synthetic platform modes", () => {
    const channel = createVerifiedPromotionChannel();
    const input = snapshot();
    const trustBytes = Buffer.from("{}\n");
    input.trustLockPreimage = {
      state: "present",
      sourceBytes: trustBytes,
      sourceSha256: digest(trustBytes),
    };
    delete input.approvalLockPreimage.mode;

    const result = channel.read(channel.issue(input));
    expect(result?.trustLockPreimage).toMatchObject({ state: "present", mode: undefined });
    expect(result?.approvalLockPreimage.mode).toBeUndefined();
  });

  it("rejects accessors and proxies without invoking hostile input", () => {
    const channel = createVerifiedPromotionChannel();
    let calls = 0;
    const hostile = snapshot() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "files", {
      enumerable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    expect(() => channel.issue(hostile as never)).toThrow("invalid verified promotion snapshot");
    expect(calls).toBe(0);

    const proxy = new Proxy(snapshot(), {
      get() {
        calls += 1;
        return undefined;
      },
    });
    expect(() => channel.issue(proxy)).toThrow("invalid verified promotion snapshot");
    expect(calls).toBe(0);

    const nested = snapshot();
    Object.defineProperty(nested.trustLockPreimage, "state", {
      enumerable: true,
      get() {
        calls += 1;
        return "absent";
      },
    });
    expect(() => channel.issue(nested)).toThrow("invalid verified promotion snapshot");
    const nestedProxy = snapshot();
    nestedProxy.trustLockPreimage = new Proxy(nestedProxy.trustLockPreimage, {
      get() {
        calls += 1;
        return "absent";
      },
    });
    expect(() => channel.issue(nestedProxy)).toThrow("invalid verified promotion snapshot");
    expect(calls).toBe(0);
  });

  it("issues only from a genuine cleared GitHub gate and uses authoritative scan findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-verified-promotion-root-"));
    const sha = "a".repeat(40);
    const source = resolveTrustSource("Owner/Repo", { root, ref: "main", pin: sha });
    if (source.kind !== "github") throw new Error("expected github source");
    try {
      const skillName = basename(source.treePath);
      mkdirSync(source.treePath, { recursive: true });
      writeFileSync(join(source.treePath, "SKILL.md"), "# Clean\n");
      writeFileSync(
        source.metadataPath,
        JSON.stringify({
          kind: "github",
          owner: source.owner,
          repo: source.repo,
          ref: source.ref,
          pinnedSha: sha,
          source: source.source,
          treePath: source.treePath,
        }),
      );
      writeFileSync(
        join(root, AIH_SKILLS_LOCK_FILE),
        JSON.stringify({
          schemaVersion: 1,
          skills: [
            {
              name: skillName,
              source: `owner/repo@${sha}`,
              commit: sha,
              verdict: "GREEN",
              scope: "repo",
              card: "ai-coding/skill-cards/clean.json",
              evidenceSha256: "0".repeat(64),
              approvedAt: "2026-08-10T00:00:00.000Z",
              sourceScope: {
                selectedSkillNames: [skillName],
                includedPaths: ["."],
                excludedSkillPaths: [],
              },
            },
          ],
        }),
      );
      const run = fakeRunner(() => undefined);
      const ctx: PlanContext = {
        root,
        contextDir: "ai-coding",
        apply: false,
        verify: true,
        json: false,
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
        env: {},
        posture: "vibe",
        options: { source: "Owner/Repo", pin: sha, ref: "main", force: true },
      };
      const report = new VerificationReport().pass("caller-only-finding", "must not persist");
      const gate = await captureClearedWorkspaceAddTrustGate(
        ctx,
        report,
        source,
        new Set([skillName]),
      );
      await expect(issueVerifiedWorkspacePromotion({ ...gate })).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );
      const handle = await issueVerifiedWorkspacePromotion(gate);
      const verified = readVerifiedWorkspacePromotion(handle);
      expect(verified?.files[0]?.contents.toString()).toBe("# Clean\n");
      expect(verified?.selectedSkills).toEqual([skillName]);
      expect(verified?.trustLockPreimage).toEqual({ state: "absent" });
      expect(verified?.approvalLockPreimage.sourceBytes.byteLength).toBeGreaterThan(0);
      expect(verified?.nextTrustLockBytes.toString()).not.toContain("caller-only-finding");
      expect(existsSync(join(root, "ai-coding", "skills"))).toBe(false);
      const approvalPath = join(root, AIH_SKILLS_LOCK_FILE);
      const approvedLock = JSON.parse(
        verified?.approvalLockPreimage.sourceBytes.toString() ?? "{}",
      ) as { skills: Array<Record<string, unknown>> };
      const unscopedLock = structuredClone(approvedLock);
      delete unscopedLock.skills[0]?.sourceScope;
      writeFileSync(approvalPath, JSON.stringify(unscopedLock));
      await expect(issueVerifiedWorkspacePromotion(gate)).resolves.toBeDefined();

      mkdirSync(join(root, ".aih"), { recursive: true });
      writeFileSync(join(root, TRUST_LOCK_FILE), verified?.nextTrustLockBytes ?? "");
      await expect(issueVerifiedWorkspacePromotion(gate)).resolves.toBeDefined();

      const invalidSourceLock = structuredClone(approvedLock);
      const invalidSourceEntry = invalidSourceLock.skills[0];
      if (invalidSourceEntry === undefined) throw new Error("missing fixture approval");
      invalidSourceEntry.source = "not-a-github-source";
      writeFileSync(approvalPath, JSON.stringify(invalidSourceLock));
      await expect(issueVerifiedWorkspacePromotion(gate)).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );

      const wrongRepositoryLock = structuredClone(approvedLock);
      const wrongRepositoryEntry = wrongRepositoryLock.skills[0];
      if (wrongRepositoryEntry === undefined) throw new Error("missing fixture approval");
      wrongRepositoryEntry.source = `other/repo@${sha}`;
      writeFileSync(approvalPath, JSON.stringify(wrongRepositoryLock));
      await expect(issueVerifiedWorkspacePromotion(gate)).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );

      const wrongPin = "b".repeat(40);
      const wrongPinLock = structuredClone(approvedLock);
      const wrongPinEntry = wrongPinLock.skills[0];
      if (wrongPinEntry === undefined) throw new Error("missing fixture approval");
      wrongPinEntry.source = `owner/repo@${wrongPin}`;
      wrongPinEntry.commit = wrongPin;
      writeFileSync(approvalPath, JSON.stringify(wrongPinLock));
      await expect(issueVerifiedWorkspacePromotion(gate)).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );

      const lockWithWrongScope = structuredClone(approvedLock);
      const scopedEntry = lockWithWrongScope.skills[0];
      if (scopedEntry === undefined) throw new Error("missing fixture approval");
      scopedEntry.sourceScope = {
        selectedSkillNames: [skillName],
        includedPaths: ["."],
        excludedSkillPaths: ["skills/other"],
      };
      writeFileSync(approvalPath, JSON.stringify(lockWithWrongScope));
      await expect(issueVerifiedWorkspacePromotion(gate)).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );

      rmSync(join(source.treePath, "SKILL.md"));
      mkdirSync(join(source.treePath, "skills", "clean"), { recursive: true });
      writeFileSync(join(source.treePath, "skills", "clean", "SKILL.md"), "# Clean\n");
      scopedEntry.name = "clean";
      scopedEntry.sourceScope = {
        selectedSkillNames: ["clean"],
        includedPaths: ["skills/clean"],
        excludedSkillPaths: ["."],
      };
      writeFileSync(approvalPath, JSON.stringify(lockWithWrongScope));
      const nestedGate = await captureClearedWorkspaceAddTrustGate(
        ctx,
        report,
        source,
        new Set(["clean"]),
      );
      await expect(issueVerifiedWorkspacePromotion(nestedGate)).rejects.toThrow(
        "verified workspace promotion could not be issued",
      );
    } finally {
      cleanupQuarantine(source);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
