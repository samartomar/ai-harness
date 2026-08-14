import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOrgPolicyFloor } from "../../src/config/posture.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { verifiedOrgPolicyProjectionActions } from "../../src/org-policy/project.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import {
  localPolicyCheck,
  policyEvaluateCommand,
  policyProjectCommand,
  policyValidateCommand,
  policyVerifyCommand,
} from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usageRecorderScript } from "../../src/usage/capture.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-policy-validate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

function write(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function enterpriseGovernance(): Record<string, unknown> {
  return {
    policyVersion: "1",
    catalog: { reviewed: [], custom: [] },
    activations: [],
    authority: { approvals: [] },
    supportedClis: ["claude"],
  };
}

function validPolicy(): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: enterpriseGovernance(),
  })}\n`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validBundle(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    bundleVersion: "2026.07",
    issuer: "platform-team",
    issuedAt: "2026-07-01T00:00:00Z",
    policy: {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: enterpriseGovernance(),
    },
    ...overrides,
  })}\n`;
}

/** Run the plan's probes and return their Checks (the command is probes-only). */
async function checks(c: PlanContext): Promise<Check[]> {
  const p = await policyValidateCommand.plan(c);
  const out: Check[] = [];
  for (const a of p.actions) {
    expect(a.kind).toBe("probe"); // read-only: probes only, nothing else (#35)
    if (a.kind === "probe") out.push(await a.run(c));
  }
  return out;
}

async function verifyChecks(c: PlanContext): Promise<Check[]> {
  const p = await policyVerifyCommand.plan(c);
  const out: Check[] = [];
  for (const a of p.actions) {
    expect(a.kind).toBe("probe");
    if (a.kind === "probe") out.push(await a.run(c));
  }
  return out;
}

async function evaluateChecks(c: PlanContext): Promise<Check[]> {
  const p = await policyEvaluateCommand.plan(c);
  const out: Check[] = [];
  for (const action of p.actions) {
    if (action.kind === "probe") out.push(await action.run(c));
  }
  return out;
}

describe("policy validate — local aih-org-policy.json", () => {
  it("is a read-only spec", () => {
    expect(policyValidateCommand.readOnly).toBe(true);
  });

  it("passes a valid committed policy and summarizes it", async () => {
    write("aih-org-policy.json", validPolicy());
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
    expect(check?.detail).toContain("minimumPosture enterprise");
  });

  it("skips (never fails) when the policy file is absent", async () => {
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("skip");
    expect(check?.code).toBeUndefined();
    expect(check?.detail).toContain("absence is not a failure");
  });

  it("fails coded on malformed policy JSON", async () => {
    write("aih-org-policy.json", "{not json");
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.invalid");
    expect(check?.detail).toContain("could not be read");
  });

  it("rejects module-style policy files with JSON-only guidance", async () => {
    write(
      "policy.js",
      `export default ${validPolicy().trim()};
`,
    );
    const [check] = await checks(ctx({ env: { AIH_ORG_POLICY: "policy.js" } }));

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.invalid");
    expect(check?.detail).toContain("JSON-only");
    expect(check?.detail).toContain("JavaScript/module policy files are not executed");
  });

  it("fails coded with the zod issue list on a schema violation", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({ schemaVersion: 2, minimumPosture: "wild", references: {} }),
    );
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.invalid");
    expect(check?.detail).toContain("org-policy is invalid");
  });

  it("refuses schema-version-1 policy documents with the explicit migration", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );

    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.invalid");
    expect(check?.detail).toContain("set schemaVersion to 2");
    expect(check?.detail).toContain("replace team with vibe or enterprise");
  });

  it("round-trips a schema-version-2 enterprise policy through validation, projection, and evaluation", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          supportedClis: ["claude"],
          policyVersion: "2026.08.0",
          catalog: { reviewed: [], custom: [] },
          activations: [],
          authority: { approvals: [] },
        },
      }),
    );

    const [validation] = await checks(ctx());
    expect(validation?.verdict).toBe("pass");

    const projected = await policyProjectCommand.plan({
      ...ctx(),
      apply: true,
      targets: ["claude"],
    });
    await executePlan(projected, { ...ctx(), apply: true, targets: ["claude"] });

    const [evaluation] = await evaluateChecks(ctx());
    expect(evaluation?.verdict).toBe("pass");
  });

  it("policy project enforces the org supported-CLI allow-list on resolved targets", async () => {
    const policy = {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08.0",
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        supportedClis: ["codex"],
      },
    };
    write("aih-org-policy.json", JSON.stringify(policy));

    await expect(
      policyProjectCommand.plan({ ...ctx(), targets: ["codex"] }),
    ).resolves.toMatchObject({
      capability: "policy project",
    });

    write(
      "aih-org-policy.json",
      JSON.stringify({
        ...policy,
        governance: { ...policy.governance, supportedClis: ["claude"] },
      }),
    );
    await expect(policyProjectCommand.plan({ ...ctx(), targets: ["codex"] })).rejects.toThrow(
      /organization sanction gate.*codex.*Allowed: claude/,
    );
  });

  it("honors the AIH_ORG_POLICY env override", async () => {
    write("policies/org.json", validPolicy());
    const [check] = await checks(ctx({ env: { AIH_ORG_POLICY: "policies/org.json" } }));
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("policies/org.json");
  });
});

describe("policy validate — --bundle envelope mode", () => {
  it("passes a valid bundle and names issuer + embedded posture", async () => {
    write("org-bundle.json", validBundle({ rings: [{ name: "canary" }] }));
    const [check] = await checks(ctx({ options: { bundle: "org-bundle.json" } }));
    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("from platform-team");
    expect(check?.detail).toContain("minimumPosture enterprise");
    expect(check?.detail).toContain("1 ring(s)");
  });

  it("fails coded when the named bundle file is missing", async () => {
    const [check] = await checks(ctx({ options: { bundle: "missing-bundle.json" } }));
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.bundle-invalid");
    expect(check?.detail).toContain("not found");
  });

  it("fails coded on malformed bundle JSON", async () => {
    write("org-bundle.json", "{oops");
    const [check] = await checks(ctx({ options: { bundle: "org-bundle.json" } }));
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.bundle-invalid");
    expect(check?.detail).toContain("not valid JSON");
  });

  it("attributes an envelope-layer failure to the envelope", async () => {
    write("org-bundle.json", validBundle({ issuer: "" }));
    const [check] = await checks(ctx({ options: { bundle: "org-bundle.json" } }));
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.bundle-invalid");
    expect(check?.detail).toContain("bundle envelope is invalid");
  });

  it("attributes an embedded-policy failure to the org-policy layer", async () => {
    write(
      "org-bundle.json",
      validBundle({
        policy: { schemaVersion: 2, minimumPosture: "wild", references: {} },
      }),
    );
    const [check] = await checks(ctx({ options: { bundle: "org-bundle.json" } }));
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.bundle-invalid");
    expect(check?.detail).toContain("embedded org policy is invalid");
  });
});

describe("policy evaluate — effective governed candidates", () => {
  it("enforces the org supported-CLI allow-list before evaluating requested targets", async () => {
    write("aih-org-policy.json", validPolicy());

    await expect(policyEvaluateCommand.plan(ctx({ targets: ["codex"] }))).rejects.toThrow(
      /organization sanction gate.*codex.*Allowed: claude/,
    );
  });

  it("is read-only and exports a deterministic requested-versus-effective digest", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026.08.0",
          supportedClis: ["claude"],
          catalog: { reviewed: [], custom: [] },
          activations: [],
          authority: { approvals: [] },
        },
      }),
    );
    const p = await policyEvaluateCommand.plan(ctx());
    const report = p.actions.find((action) => action.kind === "digest");

    expect(policyEvaluateCommand.readOnly).toBe(true);
    expect(report).toMatchObject({
      kind: "digest",
      data: { policyVersion: "2026.08.0", blocking: false, candidates: [] },
    });
    expect((await evaluateChecks(ctx()))[0]).toMatchObject({ verdict: "pass" });
  });

  it("fails closed and reports the precise blocked candidate instead of projecting it", async () => {
    const source = {
      type: "mcp" as const,
      server: "missing-mcp",
      subject: `mcp-server-sha256:${"a".repeat(64)}`,
    };
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026.08.0",
          supportedClis: ["claude"],
          catalog: {
            reviewed: [
              {
                id: "missing-mcp",
                kind: "mcp",
                description: "Missing MCP catalog entry",
                capabilities: [],
                risks: [],
                source,
                targets: ["claude"],
                projector: "mcp-managed-settings",
                lifecycle: "supported",
                evidence: { record: "missing-evidence" },
              },
            ],
            custom: [],
          },
          activations: [{ candidate: "missing-mcp", state: "active", targets: ["claude"] }],
          authority: { approvals: [] },
        },
      }),
    );

    const p = await policyEvaluateCommand.plan(ctx());
    const report = p.actions.find((action) => action.kind === "digest");
    expect(report).toMatchObject({
      kind: "digest",
      data: {
        blocking: true,
        candidates: [expect.objectContaining({ id: "missing-mcp", effective: false })],
      },
    });
    expect((await evaluateChecks(ctx()))[0]).toMatchObject({
      verdict: "fail",
      code: "org-policy.effective-blocked",
    });
  });

  it("reports a retained hook receipt instead of deleting a no-longer-effective host hook", async () => {
    const scriptDigest = `sha256:${sha256(usageRecorderScript())}`;
    const active = parseOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08.0",
        supportedClis: ["claude"],
        catalog: {
          reviewed: [
            {
              id: "usage-metering",
              kind: "hook",
              description: "AIH-owned usage hook",
              capabilities: [],
              risks: [],
              source: { type: "hook", handler: "usage-metering", scriptDigest },
              targets: ["claude", "codex"],
              projector: "usage-hook",
              lifecycle: "supported",
              evidence: { record: "ignored-self-assertion" },
            },
          ],
          custom: [],
        },
        activations: [{ candidate: "usage-metering", state: "active", targets: ["claude"] }],
        authority: { approvals: [] },
      },
    });
    const applied = ctx({ apply: true });
    await executePlan(
      plan(
        "project valid governed usage hook",
        ...(await verifiedOrgPolicyProjectionActions(applied, active)),
      ),
      applied,
    );
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026.08.0",
          supportedClis: ["claude"],
          catalog: { reviewed: [], custom: [] },
          activations: [],
          authority: { approvals: [] },
        },
      }),
    );

    expect((await evaluateChecks(ctx()))[0]).toMatchObject({
      verdict: "fail",
      code: "org-policy.effective-blocked",
      detail: expect.stringContaining("conservative rollback"),
    });
  });
});

describe("policy verify — pinned policy integrity", () => {
  it("passes when the active policy matches a pinned sha256", async () => {
    const policy = validPolicy();
    write("aih-org-policy.json", policy);
    const [check] = await verifyChecks(ctx({ options: { against: sha256(policy) } }));

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("matches pinned sha256");
  });

  it("fails closed when the pinned sha256 does not match", async () => {
    write("aih-org-policy.json", validPolicy());
    const [check] = await verifyChecks(ctx({ options: { against: "0".repeat(64) } }));

    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.drift");
    expect(check?.detail).toContain("sha256 mismatch");
  });

  it("passes when the active policy semantically matches a policy-bundle envelope", async () => {
    write("aih-org-policy.json", validPolicy());
    write("org-bundle.json", validBundle());
    const [check] = await verifyChecks(ctx({ options: { against: "org-bundle.json" } }));

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("semantically matches policy bundle");
  });

  it("passes when the active policy matches a fleet-bundle policy copy", async () => {
    const policy = validPolicy();
    write("aih-org-policy.json", policy);
    write("bundle/files/aih-org-policy.json", policy);
    const [check] = await verifyChecks(ctx({ options: { against: "bundle" } }));

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("matches bundled files/aih-org-policy.json");
  });

  it("honors AIH_ORG_POLICY as the active source during pin verification", async () => {
    const override = validPolicy();
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "vibe",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );
    write("policies/org.json", override);
    const [check] = await verifyChecks(
      ctx({
        env: { AIH_ORG_POLICY: "policies/org.json" },
        options: { against: sha256(override) },
      }),
    );

    expect(check?.verdict).toBe("pass");
    expect(check?.detail).toContain("policies/org.json");
  });
});

/**
 * `aih policy evaluate --posture X` reported byte-identical output for every posture.
 * Posture gates projector availability, so evaluate's checks ARE posture-scoped — but the
 * spec omitted `honorReadOnlyPostureFlag`, so `runCapability` dropped the typed flag for
 * this read-only command and every invocation resolved the same posture.
 */
describe("policy evaluate — posture is honored", () => {
  function governedPolicy(): string {
    return JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp: { allowManagedOnly: true },
      governance: {
        policyVersion: "2026.08.0",
        supportedClis: ["claude"],
        catalog: {
          reviewed: [
            {
              id: "catalog-mcp",
              kind: "mcp",
              description: "AIH catalog MCP",
              capabilities: [],
              risks: [],
              source: {
                type: "mcp",
                server: "catalog-mcp",
                subject: `mcp-server-sha256:${"a".repeat(64)}`,
              },
              targets: ["claude"],
              projector: "mcp-managed-settings",
              lifecycle: "supported",
              evidence: { record: "catalog-evidence" },
            },
          ],
          custom: [],
        },
        activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude"] }],
        authority: { approvals: [] },
      },
    });
  }

  /**
   * The plumbing half: without this field `runCapability` discards a typed `--posture`
   * for read-only specs (see the posture precedence ladder in tests/commands/run.test.ts).
   * `aih doctor` already sets it for the identical downstream `orgPolicyEffectiveCheck`.
   */
  it("declares that it honors the read-only posture flag", () => {
    expect(policyEvaluateCommand.honorReadOnlyPostureFlag).toBe(true);
  });

  /** The behavior half: posture must actually change what evaluate reports. */
  it("reports the vibe projector block only at vibe posture", async () => {
    write("aih-org-policy.json", governedPolicy());
    const detailAt = async (posture: "vibe" | "enterprise"): Promise<string> => {
      const c = ctx({ posture, targets: ["claude"] });
      const p = await policyEvaluateCommand.plan(c);
      const out: string[] = [];
      for (const a of p.actions) {
        if (a.kind === "probe") out.push(JSON.stringify(await a.run(c)));
      }
      return out.join("\n");
    };
    expect(await detailAt("vibe")).toContain("projector-disabled-at-vibe-posture");
    expect(await detailAt("enterprise")).not.toContain("projector-disabled-at-vibe-posture");
  });
});

/**
 * `aih policy evaluate --cli claude,kiro` failed with `unknown option '--cli'`, so the
 * dry-run diagnostic could not model the very selection `aih policy project` requires for
 * an all-or-nothing multi-target activation. `policyEvaluatePlan` already resolves targets
 * through the same `resolveTargets` as project; only the flag registration was missing.
 */
describe("policy evaluate — target selection", () => {
  it("declares the --cli flag the read-only flag set omits", () => {
    const flags = (policyEvaluateCommand.options ?? []).map((o) => o.flags);
    expect(flags).toContain("--cli <list>");
  });

  it("routes a --cli selection through the same target resolution as policy project", async () => {
    write("aih-org-policy.json", validPolicy());
    // The org sanction gate names the rejected CLI only if `options.cli` actually reached
    // `resolveTargets`; a dropped flag would resolve the default and never mention codex.
    await expect(policyEvaluateCommand.plan(ctx({ options: { cli: "codex" } }))).rejects.toThrow(
      /organization sanction gate.*codex.*Allowed: claude/,
    );
  });
});

/**
 * A governance bootstrap exported `AIH_ORG_POLICY=/does-not-exist.json`. `readOrgPolicy`
 * returned `undefined` for BOTH "no policy anywhere" and "explicitly named file missing",
 * so `policy validate` reported a clean skip ("absence is not a failure") and exit 0 while
 * validating nothing — and every other caller silently lost the org posture floor and the
 * governed inventory with it. An explicitly named policy must resolve or fail closed.
 */
describe("org policy — explicit AIH_ORG_POLICY must resolve", () => {
  it("fails closed when AIH_ORG_POLICY points at a missing file", () => {
    const check = localPolicyCheck(ctx({ env: { AIH_ORG_POLICY: "missing/org.json" } }));
    expect(check.verdict).toBe("fail");
    expect(check.code).toBe("org-policy.invalid");
    expect(check.detail).toContain("AIH_ORG_POLICY");
    expect(check.detail).not.toContain("absence is not a failure");
  });

  it("still skips when no policy is configured at all (vibe repos carry none)", () => {
    const check = localPolicyCheck(ctx({ env: {} }));
    expect(check.verdict).toBe("skip");
    expect(check.detail).toContain("absence is not a failure");
  });

  it("still passes when AIH_ORG_POLICY points at a real policy", () => {
    write("policies/org.json", validPolicy());
    const check = localPolicyCheck(ctx({ env: { AIH_ORG_POLICY: "policies/org.json" } }));
    expect(check.verdict).toBe("pass");
  });

  /** The severe case: a dropped floor silently downgrades posture for every command. */
  it("does not silently drop the org posture floor when the path is broken", () => {
    expect(() => readOrgPolicyFloor(dir, { AIH_ORG_POLICY: "missing/org.json" })).toThrow(
      /AIH_ORG_POLICY/,
    );
    expect(readOrgPolicyFloor(dir, {})).toBeUndefined();
  });
});
