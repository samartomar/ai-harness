import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { plan, writeText } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  verifiedPolicyAuthorityReceiptAssertionV1,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import { readOrgPolicy } from "../../src/org-policy/policy-source.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let targetRoot: string;
let adminRoot: string;
let policyPath: string;

function authorityBundle(expiresAt = "2026-09-01T00:00:00Z"): string {
  return JSON.stringify({
    schemaVersion: 2,
    bundleVersion: "2026.08.1",
    issuer: "Acme platform security",
    issuedAt: "2026-08-25T00:00:00Z",
    policy: {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
    },
    authorityReceipt: {
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-25T00:00:00Z",
      expiresAt,
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude"],
      decisions: [],
      decisionRevocations: [],
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
  targetRoot = mkdtempSync(join(tmpdir(), "aih-file-authority-target-"));
  adminRoot = mkdtempSync(join(tmpdir(), "aih-file-authority-admin-"));
  policyPath = join(adminRoot, "policy-bundle.json");
  writeFileSync(policyPath, authorityBundle());
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(targetRoot, { recursive: true, force: true });
  rmSync(adminRoot, { recursive: true, force: true });
});

function context(path = policyPath): { ctx: PlanContext; calls: string[][] } {
  const calls: string[][] = [];
  const run = fakeRunner((argv) => {
    calls.push(argv);
    return { code: 1 };
  });
  return {
    ctx: {
      root: targetRoot,
      contextDir: "ai-coding",
      posture: "enterprise",
      apply: false,
      verify: true,
      json: true,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: { AIH_ORG_POLICY: path },
      options: {},
    },
    calls,
  };
}

describe("administrator-protected policy-file authority", () => {
  it("loads the embedded policy and mints exact V3 decision authority without a workflow", async () => {
    const { ctx, calls } = context();

    expect(readOrgPolicy(ctx.root, ctx.env)).toMatchObject({
      schemaVersion: 2,
      minimumPosture: "enterprise",
    });
    const verified = await verifyPolicyAuthorityReceipt(ctx);

    expect(verified.problem).toBeUndefined();
    expect(verified.authority).toMatchObject({
      repository: "acme/governance",
      source: "policy-file",
      receipt: { version: 3, decisions: [], decisionRevocations: [] },
    });
    expect(calls).toEqual([]);
    const authority = verified.authority;
    expect(authority).toBeDefined();
    if (authority === undefined) throw new Error("expected file authority");
    const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
    expect(assertion).toMatchObject({
      path: policyPath,
      external: true,
      trustedBase: dirname(policyPath),
      maxBytes: 1_000_000,
    });
  });

  it("does not grant file authority to a developer-controlled bundle inside the target", async () => {
    const local = join(targetRoot, "policy-bundle.json");
    writeFileSync(local, authorityBundle());
    const { ctx, calls } = context(local);

    expect(readOrgPolicy(ctx.root, ctx.env)?.minimumPosture).toBe("enterprise");
    expect(await verifyPolicyAuthorityReceipt(ctx)).toEqual({
      problem:
        "protected policy bundle authority requires an absolute file outside the governed target",
    });
    expect(calls).toEqual([]);
  });

  it("refuses expired, hard-linked, and symlink-parent policy authority", async () => {
    writeFileSync(policyPath, authorityBundle("2026-08-26T12:00:00Z"));
    expect((await verifyPolicyAuthorityReceipt(context().ctx)).problem).toBe(
      "protected policy bundle authority is not currently valid",
    );

    writeFileSync(policyPath, authorityBundle());
    linkSync(policyPath, join(adminRoot, "policy-copy.json"));
    expect((await verifyPolicyAuthorityReceipt(context().ctx)).problem).toBe(
      "protected policy bundle authority has unsafe file custody",
    );
    rmSync(join(adminRoot, "policy-copy.json"));

    if (process.platform !== "win32") {
      const realParent = join(adminRoot, "real");
      const linkedParent = join(adminRoot, "linked");
      mkdirSync(realParent);
      writeFileSync(join(realParent, "policy.json"), authorityBundle());
      symlinkSync(realParent, linkedParent, "dir");
      expect(
        (await verifyPolicyAuthorityReceipt(context(join(linkedParent, "policy.json")).ctx))
          .problem,
      ).toBe("protected policy bundle authority has unsafe file custody");
    }
  });

  it("pins the exact external file inside a mutating transaction", async () => {
    const { ctx } = context();
    const verified = await verifyPolicyAuthorityReceipt(ctx);
    const authority = verified.authority;
    expect(authority).toBeDefined();
    if (authority === undefined) throw new Error("expected file authority");
    const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
    expect(assertion).toBeDefined();
    if (assertion === undefined) throw new Error("expected file assertion");

    writeFileSync(policyPath, authorityBundle("2026-08-31T00:00:00Z"));
    await expect(
      executePlan(
        {
          ...plan("file-authority-effect", writeText("effect.txt", "applied", "apply effect")),
          fileAssertions: [assertion],
        },
        { ...ctx, apply: true, options: { force: true } },
      ),
    ).rejects.toThrow(/verified policy authority .* changed before commit/);
    expect(existsSync(join(targetRoot, "effect.txt"))).toBe(false);
  });
});
