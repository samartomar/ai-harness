import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { command as bootstrapAiCommand } from "../../src/bootstrap-ai/index.js";
import { eccMcpAddCommand } from "../../src/ecc/index.js";
import { resolveTargets } from "../../src/internals/cli-detect.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { plan, writeText } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  verifiedPolicyAuthorityReceiptAssertionV1,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import {
  verifiedOrgPolicyProjection,
  verifiedOrgPolicySource,
} from "../../src/org-policy/project.js";
import { readOrgPolicy } from "../../src/org-policy/schema.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let targetRoot: string;
let adminRoot: string;
let policyPath: string;

function authorityBundle(
  expiresAt = "2026-09-01T00:00:00Z",
  repoContract = "ai-coding/project.json",
  eccMcp = false,
): string {
  return JSON.stringify({
    schemaVersion: 2,
    bundleVersion: "2026.08.1",
    issuer: "Acme platform security",
    issuedAt: "2026-08-25T00:00:00Z",
    policy: {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract },
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        supportedClis: ["claude"],
        ...(eccMcp
          ? {
              eccMcpApprovals: [
                {
                  id: "memxus",
                  sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
                  state: "approved",
                  approvedBy: "security-admin",
                  authenticationMode: "api-key",
                  allowedDataClasses: ["non-sensitive-context"],
                },
              ],
            }
          : {}),
      },
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
  adminRoot = realpathSync.native(
    mkdtempSync(join(realpathSync.native(tmpdir()), "aih-file-authority-admin-")),
  );
  policyPath = join(adminRoot, "policies", "policy-bundle.json");
  mkdirSync(dirname(policyPath));
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

  it("derives projected policy and authority from the same protected-file observation", async () => {
    const { ctx } = context();
    const stalePolicy = readOrgPolicy(ctx.root, ctx.env);
    if (stalePolicy === undefined) throw new Error("expected initial protected policy");

    writeFileSync(policyPath, authorityBundle("2026-09-01T00:00:00Z", "policy-b.json"));
    const projected = await verifiedOrgPolicyProjection(ctx, stalePolicy);
    const rendered = JSON.stringify(projected.actions);

    expect(projected.policy.references.repoContract).toBe("policy-b.json");
    expect(rendered).toContain("policy-b.json");
    expect(rendered).not.toContain("ai-coding/project.json");
    expect(projected.fileAssertions).toHaveLength(1);
  });

  it("admits the verified protected file as the policy-project managed mutation source", async () => {
    const { ctx } = context();
    const projectCtx: PlanContext = {
      ...ctx,
      apply: true,
      options: { cli: "claude" },
    };

    const planned = await policyProjectCommand.plan(projectCtx);

    expect(planned.fileAssertions).toHaveLength(1);
    expect(planned.commitLock).toBe(".aih/governance/policy-authority/v1/locks/authority.lock");
    expect(planned.commitNotAfter).toBe("2026-09-01T00:00:00.000Z");
  });

  it("sanctions CLI targets from the same protected-file observation as authority", async () => {
    const { ctx } = context();
    const stalePolicy = readOrgPolicy(ctx.root, ctx.env);
    if (stalePolicy === undefined) throw new Error("expected initial protected policy");

    writeFileSync(
      policyPath,
      authorityBundle().replace('"supportedClis":["claude"]', '"supportedClis":["codex"]'),
    );
    const source = await verifiedOrgPolicySource(ctx, stalePolicy);
    const resolution = await resolveTargets({ ...ctx, options: { cli: "codex" } }, source.policy);

    expect(source.policy.governance?.supportedClis).toEqual(["codex"]);
    expect(resolution.clis).toEqual(["codex"]);
    await expect(
      resolveTargets({ ...ctx, options: { cli: "claude" } }, source.policy),
    ).rejects.toThrow(/sanction gate refused selected CLI target/);
  });

  it("does not grant file authority to a developer-controlled bundle inside the target", async () => {
    const local = join(targetRoot, "policy-bundle.json");
    writeFileSync(local, authorityBundle());
    const { ctx, calls } = context(local);

    expect(readOrgPolicy(ctx.root, ctx.env)?.minimumPosture).toBe("enterprise");
    expect(await verifyPolicyAuthorityReceipt(ctx)).toEqual({
      problem:
        "protected policy bundle authority requires an absolute file outside the governed target",
      protectedPolicyFile: "problem",
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

  it("rejects ambiguous and oversized policy bytes before authority fallback", async () => {
    const duplicateKey = authorityBundle().replace(
      '"schemaVersion":2',
      '"schemaVersion":2,"schema\\u0056ersion":2',
    );
    writeFileSync(policyPath, duplicateKey);
    const duplicate = context();
    expect(() => readOrgPolicy(duplicate.ctx.root, duplicate.ctx.env)).toThrow(/duplicate JSON/);
    await expect(verifyPolicyAuthorityReceipt(duplicate.ctx)).resolves.toEqual({
      problem: "protected policy bundle authority is malformed",
      protectedPolicyFile: "problem",
    });
    expect(duplicate.calls).toEqual([]);

    writeFileSync(
      policyPath,
      Buffer.concat([
        Buffer.from(authorityBundle().slice(0, -1), "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from("}", "utf8"),
      ]),
    );
    const invalidUtf8 = context();
    expect(() => readOrgPolicy(invalidUtf8.ctx.root, invalidUtf8.ctx.env)).toThrow(
      /not valid UTF-8/,
    );
    await expect(verifyPolicyAuthorityReceipt(invalidUtf8.ctx)).resolves.toEqual({
      problem: "protected policy bundle authority is malformed",
      protectedPolicyFile: "problem",
    });
    expect(invalidUtf8.calls).toEqual([]);

    writeFileSync(
      policyPath,
      authorityBundle().replace(/}$/, `,"padding":"${"x".repeat(1_000_000)}"}`),
    );
    const oversized = context();
    expect(() => readOrgPolicy(oversized.ctx.root, oversized.ctx.env)).toThrow(
      /1,000,000-byte safety limit/,
    );
    await expect(verifyPolicyAuthorityReceipt(oversized.ctx)).resolves.toEqual({
      problem: "protected policy bundle authority exceeds the 1,000,000-byte safety limit",
      protectedPolicyFile: "problem",
    });
    expect(oversized.calls).toEqual([]);
  });

  it("rejects non-canonical Unicode, negative zero, and non-object policy roots", () => {
    writeFileSync(policyPath, authorityBundle().replace("Acme platform security", "Acme 😀"));
    expect(readOrgPolicy(targetRoot, { AIH_ORG_POLICY: policyPath })?.minimumPosture).toBe(
      "enterprise",
    );

    for (const invalidIssuer of ["\\ud800", "\\udc00", "Café"]) {
      writeFileSync(policyPath, authorityBundle().replace("Acme platform security", invalidIssuer));
      expect(() => readOrgPolicy(targetRoot, { AIH_ORG_POLICY: policyPath })).toThrow(
        /malformed Unicode|already be NFC/,
      );
    }

    writeFileSync(policyPath, authorityBundle().replace(/}$/, ',"padding":-0}'));
    expect(() => readOrgPolicy(targetRoot, { AIH_ORG_POLICY: policyPath })).toThrow(
      /negative zero/,
    );

    writeFileSync(policyPath, "[]");
    expect(() => readOrgPolicy(targetRoot, { AIH_ORG_POLICY: policyPath })).toThrow(
      /JSON root must be an object/,
    );
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
          commitLock: ".aih/file-authority/commit-lock",
        },
        { ...ctx, apply: true, options: { force: true } },
      ),
    ).rejects.toThrow(/verified policy authority .* changed before commit/);
    expect(existsSync(join(targetRoot, "effect.txt"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih"))).toBe(false);
  });

  it("refuses a protected-policy A-to-B replacement before standalone bootstrap effects", async () => {
    const { ctx } = context();
    const plannedCtx: PlanContext = { ...ctx, apply: true, options: { cli: "claude" } };
    const planned = await bootstrapAiCommand.plan(plannedCtx);
    expect(planned.fileAssertions).toHaveLength(1);
    expect(planned.commitLock).toBe(".aih/governance/policy-authority/v1/locks/authority.lock");

    writeFileSync(
      policyPath,
      authorityBundle().replace('"supportedClis":["claude"]', '"supportedClis":["codex"]'),
    );
    await expect(executePlan(planned, plannedCtx)).rejects.toThrow(
      /verified policy authority policy file changed before commit/,
    );
    expect(existsSync(join(targetRoot, "ai-coding", "RULE_ROUTER.md"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih"))).toBe(false);
  });

  it("pins protected policy approval across standalone explicit ECC MCP Add", async () => {
    writeFileSync(
      policyPath,
      authorityBundle("2026-09-01T00:00:00Z", "ai-coding/project.json", true),
    );
    writeFileSync(join(targetRoot, ".mcp.json"), '{"mcpServers":{}}\n');
    const { ctx } = context();
    const plannedCtx: PlanContext = {
      ...ctx,
      apply: true,
      options: { id: "memxus", cli: "claude" },
    };
    const planned = await eccMcpAddCommand.plan(plannedCtx);
    expect(planned.fileAssertions).toHaveLength(1);
    expect(planned.commitLock).toBe(".aih/governance/policy-authority/v1/locks/authority.lock");

    writeFileSync(
      policyPath,
      authorityBundle("2026-09-01T00:00:00Z", "ai-coding/project.json", true).replace(
        '"supportedClis":["claude"]',
        '"supportedClis":["codex"]',
      ),
    );
    await expect(executePlan(planned, plannedCtx)).rejects.toThrow(
      /verified policy authority policy file changed before commit/,
    );
    expect(existsSync(join(targetRoot, ".aih", "ecc-mcp-explicit-add-v1.json"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih", "governance"))).toBe(false);
  });

  it("refuses a same-byte replacement of the verified external policy file before lock or effects", async () => {
    const { ctx } = context();
    const verified = await verifyPolicyAuthorityReceipt(ctx);
    const authority = verified.authority;
    if (authority === undefined) throw new Error("expected file authority");
    const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
    if (assertion === undefined) throw new Error("expected file assertion");

    const replacement = join(adminRoot, "replacement.json");
    writeFileSync(replacement, authorityBundle());
    rmSync(policyPath);
    renameSync(replacement, policyPath);

    await expect(
      executePlan(
        {
          ...plan("file-authority-effect", writeText("effect.txt", "applied", "apply effect")),
          fileAssertions: [assertion],
          commitLock: ".aih/file-authority/commit-lock",
        },
        { ...ctx, apply: true, options: { force: true } },
      ),
    ).rejects.toThrow(/verified policy authority .* changed before commit/);
    expect(existsSync(join(targetRoot, "effect.txt"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih"))).toBe(false);
  });

  it("refuses a same-byte replacement of an external policy parent before lock or effects", async () => {
    const { ctx } = context();
    const verified = await verifyPolicyAuthorityReceipt(ctx);
    const authority = verified.authority;
    if (authority === undefined) throw new Error("expected file authority");
    const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
    if (assertion === undefined) throw new Error("expected file assertion");

    const policyParent = dirname(policyPath);
    const originalParent = join(adminRoot, "original-policies");
    renameSync(policyParent, originalParent);
    mkdirSync(policyParent);
    writeFileSync(policyPath, authorityBundle());

    await expect(
      executePlan(
        {
          ...plan("file-authority-effect", writeText("effect.txt", "applied", "apply effect")),
          fileAssertions: [assertion],
          commitLock: ".aih/file-authority/commit-lock",
        },
        { ...ctx, apply: true, options: { force: true } },
      ),
    ).rejects.toThrow(/verified policy authority .* changed before commit/);
    expect(existsSync(join(targetRoot, "effect.txt"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih"))).toBe(false);

    rmSync(originalParent, { recursive: true, force: true });
  });

  it("continues to refuse a symlinked external policy ancestor before lock or effects", async () => {
    if (process.platform === "win32") return;
    const { ctx } = context();
    const verified = await verifyPolicyAuthorityReceipt(ctx);
    const authority = verified.authority;
    if (authority === undefined) throw new Error("expected file authority");
    const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
    if (assertion === undefined) throw new Error("expected file assertion");

    const policyParent = dirname(policyPath);
    const originalParent = join(adminRoot, "original-policies");
    renameSync(policyParent, originalParent);
    symlinkSync(originalParent, policyParent, "dir");

    await expect(
      executePlan(
        {
          ...plan("file-authority-effect", writeText("effect.txt", "applied", "apply effect")),
          fileAssertions: [assertion],
          commitLock: ".aih/file-authority/commit-lock",
        },
        { ...ctx, apply: true, options: { force: true } },
      ),
    ).rejects.toThrow(/unsafe symlinked parent|trusted external base is not a real directory/);
    expect(existsSync(join(targetRoot, "effect.txt"))).toBe(false);
    expect(existsSync(join(targetRoot, ".aih"))).toBe(false);
  });
});
