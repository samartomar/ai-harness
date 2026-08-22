import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { runPolicyGenerate } from "../../src/org-policy/generate.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const command = (apply = true): Command =>
  ({ optsWithGlobals: () => ({ apply, posture: "vibe" }) }) as unknown as Command;

describe("policy generate baseline evidence route", () => {
  it("does not construct the baseline stage without an applied administrator root", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-route-"));
    let calls = 0;
    const baseline = async () => {
      calls++;
      return {
        tier: "fresh" as const,
        sourceIds: ["ecc", "superpowers"],
        schemaVersion: 1,
        digest: "a".repeat(64),
        ageSeconds: 0,
        resolvedAt: "2026-08-21T00:00:00Z",
        attestedAt: "2026-08-21T00:00:00Z",
        bootstrapProvenance: "local-admin-file" as const,
      };
    };
    await runPolicyGenerate(command(), { cwd: root, baseline, write: () => undefined });
    await runPolicyGenerate(command(false), {
      cwd: root,
      adminRoot: root,
      baseline,
      write: () => undefined,
    });
    expect(calls).toBe(0);
    await runPolicyGenerate(command(), {
      cwd: root,
      adminRoot: root,
      baseline,
      write: () => undefined,
    });
    expect(calls).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the real baseline stage before catalog resolution when no test seam is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-baseline-default-route-"));
    const output: string[] = [];
    try {
      const code = await runPolicyGenerate(command(), {
        adminRoot: root,
        catalog: {
          fetchHttps: async () => {
            throw new Error("catalog must not fetch before baseline authority");
          },
          now: "2026-08-21T00:00:00Z",
        },
        cwd: root,
        write: (text) => output.push(text),
      });
      expect(code).toBe(1);
      expect(output.join("")).toContain("AIH_ADMIN_BASELINE_EVIDENCE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects only fixed baseline provenance fields and rejects hostile supplied projections", () => {
    const secret = "credential://should-not-render";
    const supplied = {
      ageSeconds: 0,
      attestationBytes: Buffer.from(secret),
      bootstrapLocator: secret,
      cachePath: secret,
      digest: "a".repeat(64),
      resolvedAt: "2026-08-21T00:00:00Z",
      schemaVersion: 1,
      signature: secret,
      sourceIds: ["ecc", "superpowers"],
      tier: "fresh" as const,
    };
    const model = policyStudioModel(undefined, supplied);
    expect(model.baselineEvidenceProvenance).toEqual({
      ageSeconds: 0,
      digest: "a".repeat(64),
      resolvedAt: "2026-08-21T00:00:00Z",
      schemaVersion: 1,
      sourceIds: ["ecc", "superpowers"],
      tier: "fresh",
    });
    expect(Object.isFrozen(model.baselineEvidenceProvenance)).toBe(true);
    supplied.sourceIds.push("injected");
    expect(model.baselineEvidenceProvenance?.sourceIds).toEqual(["ecc", "superpowers"]);
    expect(policyStudioHtml(model)).not.toContain(secret);

    let traps = 0;
    const proxied = new Proxy(supplied, {
      get() {
        traps += 1;
        throw new Error("trap");
      },
    });
    expect(() => policyStudioModel(undefined, proxied)).toThrow(/baseline evidence provenance/);
    expect(traps).toBe(0);
    expect(() =>
      policyStudioModel(
        undefined,
        Object.defineProperty({ ...supplied }, "tier", {
          enumerable: true,
          get: () => "fresh",
        }),
      ),
    ).toThrow(/baseline evidence provenance/);
  });

  it.each([
    ["duplicate source IDs", { sourceIds: ["ecc", "ecc"] }],
    ["unordered source IDs", { sourceIds: ["superpowers", "ecc"] }],
    ["non-current schema", { schemaVersion: 2 }],
    ["fresh nonzero age", { ageSeconds: 1 }],
    ["packaged numeric age", { ageSeconds: 0, tier: "packaged" as const }],
    ["cached null age", { ageSeconds: null, tier: "last-downloaded" as const }],
    ["cached excessive age", { ageSeconds: 31_536_001, tier: "last-downloaded" as const }],
  ])("rejects internally inconsistent baseline provenance: %s", (_label, change) => {
    expect(() =>
      policyStudioModel(undefined, {
        ageSeconds: 0,
        digest: "a".repeat(64),
        resolvedAt: "2026-08-21T00:00:00Z",
        schemaVersion: 1,
        sourceIds: ["ecc", "superpowers"],
        tier: "fresh" as const,
        ...change,
      }),
    ).toThrow(/baseline evidence provenance/);
  });
});
