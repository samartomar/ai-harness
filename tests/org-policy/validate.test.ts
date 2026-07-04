import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { policyValidateCommand, policyVerifyCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

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

function validPolicy(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
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
      schemaVersion: 1,
      minimumPosture: "team",
      references: { repoContract: "ai-coding/project.json" },
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

describe("policy validate — local aih-org-policy.json", () => {
  it("is a read-only spec", () => {
    expect(policyValidateCommand.readOnly).toBe(true);
  });

  it("passes a valid committed policy and summarizes it", async () => {
    write("aih-org-policy.json", validPolicy());
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
    expect(check?.detail).toContain("minimumPosture team");
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

  it("fails coded with the zod issue list on a schema violation", async () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({ schemaVersion: 1, minimumPosture: "wild", references: {} }),
    );
    const [check] = await checks(ctx());
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.invalid");
    expect(check?.detail).toContain("org-policy is invalid");
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
    expect(check?.detail).toContain("minimumPosture team");
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
        policy: { schemaVersion: 1, minimumPosture: "wild", references: {} },
      }),
    );
    const [check] = await checks(ctx({ options: { bundle: "org-bundle.json" } }));
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("org-policy.bundle-invalid");
    expect(check?.detail).toContain("embedded org policy is invalid");
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
        schemaVersion: 1,
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
