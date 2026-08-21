import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { runPolicyGenerate } from "../../src/org-policy/generate.js";

const command = (apply = true): Command => ({ optsWithGlobals: () => ({ apply, posture: "vibe" }) }) as unknown as Command;

describe("policy generate baseline evidence route", () => {
  it("does not construct the baseline stage without an applied administrator root", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-route-"));
    let calls = 0;
    const baseline = async () => { calls++; return { tier: "fresh", sourceIds: ["ecc", "superpowers"], schemaVersion: 1, digest: "a".repeat(64), ageSeconds: 0, resolvedAt: "2026-08-21T00:00:00Z", attestedAt: "2026-08-21T00:00:00Z", bootstrapProvenance: "local-admin-file" as const }; };
    await runPolicyGenerate(command(), { cwd: root, baseline, write: () => undefined });
    await runPolicyGenerate(command(false), { cwd: root, adminRoot: root, baseline, write: () => undefined });
    expect(calls).toBe(0);
    await runPolicyGenerate(command(), { cwd: root, adminRoot: root, baseline, write: () => undefined });
    expect(calls).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
