import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAihConfig, readPolicyBinding } from "../../src/config/marker.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  applyPolicyBindingDefaults,
  applyPolicyBindingReadOnlyDiagnosticDefaults,
  assertPolicyBindingCurrent,
  policyBindCommand,
  policyRebindCommand,
  policyRevokeCommand,
  policyRootSha256,
} from "../../src/org-policy/binding.js";
import {
  executePolicyProjectCommand,
  policyProjectCommand,
} from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-policy-binding-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function policy(version = "1"): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: version,
      supportedClis: ["codex", "kiro", "copilot"],
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
    },
  })}\n`;
}

function ctx(options: Record<string, unknown>, apply = true): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

describe("durable project policy binding", () => {
  it("binds an explicit project and explicit target set to the canonical root and exact source", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex,kiro" });
    await executePlan(await policyBindCommand.plan(context), context);

    expect(readPolicyBinding(root)).toMatchObject({
      state: "active",
      projectId: "payments-api",
      rootSha256: policyRootSha256(realpathSync.native(root)),
      targets: ["codex", "kiro"],
      source: { path: realpathSync.native(join(root, "aih-org-policy.json")) },
    });
    expect(readAihConfig(root)).toMatchObject({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["codex", "kiro"],
    });
  });

  it("requires explicit targets instead of inferring grants from supportedClis", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    await expect(policyBindCommand.plan(ctx({ project: "payments-api" }, false))).rejects.toThrow(
      /explicit --cli/,
    );
  });

  it("binds a sanctioned non-ECC target when the policy has no ECC requirement", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "copilot" });
    await executePlan(await policyBindCommand.plan(context), context);
    expect(readPolicyBinding(root)?.targets).toEqual(["copilot"]);
  });

  it("requires rebind for an accepted policy update and refreshes the exact digest", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const initial = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(initial), initial);
    writeFileSync(join(root, "aih-org-policy.json"), policy("2"));

    expect(() => assertPolicyBindingCurrent(root, {}, ["codex"])).toThrow(/source digest changed/);
    await expect(policyBindCommand.plan(initial)).rejects.toThrow(/already bound.*rebind/);
    await executePlan(await policyRebindCommand.plan(initial), initial);
    expect(() => assertPolicyBindingCurrent(root, {}, ["codex"])).not.toThrow();
  });

  it("restores bound source and targets only when the invocation has no higher-precedence selection", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(context), context);

    const defaults = applyPolicyBindingDefaults(root, {}, {});
    expect(defaults.env.AIH_ORG_POLICY).toBe(
      realpathSync.native(join(root, "aih-org-policy.json")),
    );
    expect(defaults.targets).toEqual(["codex"]);

    const explicitSource = join(root, "other-policy.json");
    const explicit = applyPolicyBindingDefaults(
      root,
      { AIH_ORG_POLICY: explicitSource },
      { cli: "kiro" },
    );
    expect(explicit.env.AIH_ORG_POLICY).toBe(explicitSource);
    expect(explicit.targets).toBeUndefined();
    expect(() => assertPolicyBindingCurrent(root, explicit.env, ["kiro"])).toThrow(
      /source conflicts|targets conflict/,
    );
  });

  it("lets only the read-only diagnostic defaults bypass a malformed policy binding", () => {
    writeFileSync(join(root, ".aih-config.json"), "{ malformed marker");

    expect(() => applyPolicyBindingDefaults(root, {}, {})).toThrow(/invalid policyBinding/);
    expect(applyPolicyBindingReadOnlyDiagnosticDefaults(root, {}, {})).toEqual({ env: {} });
  });

  it("refuses a copied binding until explicit same-project rebind recovers this root", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(context), context);
    const binding = readPolicyBinding(root);
    expect(binding).toBeDefined();
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: [],
        policyBinding: {
          ...binding,
          rootSha256: "a".repeat(64),
          source: {
            ...binding?.source,
            path:
              process.platform === "win32"
                ? "/mnt/c/retired-checkout/aih-org-policy.json"
                : "C:\\retired-checkout\\aih-org-policy.json",
          },
        },
      }),
    );

    expect(() => assertPolicyBindingCurrent(root, {}, ["codex"])).toThrow(
      /different canonical root/,
    );
    await executePlan(await policyRebindCommand.plan(context), context);
    expect(() => assertPolicyBindingCurrent(root, {}, ["codex"])).not.toThrow();
  });

  it("retains a revoked binding and blocks later material mutation", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(context), context);
    await executePlan(await policyRevokeCommand.plan(context), context);
    expect(readPolicyBinding(root)?.state).toBe("revoked");
    expect(() => assertPolicyBindingCurrent(root, {}, ["codex"])).toThrow(/revoked/);
  });

  it("refuses a stale rebind plan after a concurrent revocation", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(context), context);

    const staleRebind = await policyRebindCommand.plan(context);
    const revoke = await policyRevokeCommand.plan(context);
    await executePlan(revoke, context);

    await expect(executePlan(staleRebind, context)).rejects.toThrow(/changed after the plan/);
    expect(readPolicyBinding(root)?.state).toBe("revoked");
  });

  it("refuses a stale project projection after a concurrent revocation", async () => {
    writeFileSync(join(root, "aih-org-policy.json"), policy());
    const context = ctx({ project: "payments-api", cli: "codex" });
    await executePlan(await policyBindCommand.plan(context), context);

    const staleProjection = await policyProjectCommand.plan(context);
    await executePlan(await policyRevokeCommand.plan(context), context);

    await expect(executePlan(staleProjection, context)).rejects.toThrow(/changed before commit/);
    expect(readPolicyBinding(root)?.state).toBe("revoked");
  });

  it("pins a bound marker write and refreshes the pin before prepared delivery", async () => {
    writeFileSync(
      join(root, "aih-org-policy.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowManagedOnly: true },
        governance: {
          policyVersion: "fixture",
          supportedClis: ["claude"],
          catalog: { reviewed: [], custom: [] },
          externalSelections: [{ framework: "ecc", items: [] }],
        },
      })}\n`,
    );
    const context = {
      ...ctx({ project: "payments-api", cli: "claude" }),
      posture: "enterprise" as const,
      targets: ["claude" as const],
    };
    await executePlan(await policyBindCommand.plan(context), context);

    await expect(executePolicyProjectCommand(context)).resolves.toMatchObject({
      capability: "policy project",
      applied: true,
    });
    expect(readPolicyBinding(root)).toMatchObject({
      state: "active",
      projectId: "payments-api",
      targets: ["claude"],
    });
  });

  it("keeps policy project preview effect-free when local ECC preparation is retained", async () => {
    writeFileSync(
      join(root, "aih-org-policy.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "fixture",
          supportedClis: ["claude"],
          catalog: { reviewed: [], custom: [] },
          externalSelections: [{ framework: "ecc", items: [] }],
        },
      })}\n`,
    );
    const applied = {
      ...ctx({ project: "payments-api", cli: "claude" }),
      posture: "enterprise" as const,
      targets: ["claude" as const],
    };
    await executePlan(await policyBindCommand.plan(applied), applied);
    const markerBefore = readFileSync(join(root, ".aih-config.json"), "utf8");

    const preview = await executePolicyProjectCommand({ ...applied, apply: false });

    expect(preview.applied).toBe(false);
    expect(readFileSync(join(root, ".aih-config.json"), "utf8")).toBe(markerBefore);
    expect(existsSync(join(root, ".aih", "ecc", "materialization-v1.json"))).toBe(false);
    expect(existsSync(join(root, "ai-coding", "policy-required-guidance.md"))).toBe(false);
    expect(existsSync(join(root, "ai-coding", "policy-required-guidance.receipt.json"))).toBe(
      false,
    );
  });

  it("refuses a public material mutation when ownership remains but its binding is missing", () => {
    mkdirSync(join(root, "ai-coding"));
    writeFileSync(join(root, "ai-coding", "policy-required-guidance.receipt.json"), "{}\n");

    expect(assertPolicyBindingCurrent(root, {})).toBeUndefined();
    expect(() => assertPolicyBindingCurrent(root, {}, undefined, { requireIfOwned: true })).toThrow(
      /binding is missing/,
    );
  });
});
