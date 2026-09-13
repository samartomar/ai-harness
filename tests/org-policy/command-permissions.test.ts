import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as guardrails } from "../../src/guardrails/index.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan, writeJson } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  COMMAND_PERMISSION_PATH,
  COMMAND_PERMISSION_RECEIPT,
  inspectCommandPermissions,
  projectCommandPermissions,
} from "../../src/org-policy/command-permissions.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-command-permissions-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function context(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    posture: "enterprise",
    targets: ["claude"],
    env: {},
    options: {},
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
  };
}
function policy(pattern = "rm -f harbor-forbidden.txt") {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    governance: { supportedClis: ["claude", "codex"] },
    command: { deny: { add: [{ pattern }] } },
  });
}
function put(path: string, value: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(value));
}
function settings(): {
  permissions: { deny: string[]; ask: string[]; allow: string[] };
  [key: string]: unknown;
} {
  return JSON.parse(readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8"));
}

describe("native organization command permissions", () => {
  it("reports policy loss as blocked even when every configured entry predated the ownership receipt", async () => {
    const ctx = context();
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [])),
      ctx,
    );
    rmSync(join(root, COMMAND_PERMISSION_RECEIPT));
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [])),
      ctx,
    );
    const owned = JSON.parse(readFileSync(join(root, COMMAND_PERMISSION_RECEIPT), "utf8")).owned;
    expect(owned).toEqual({ deny: [], ask: [], allow: [] });
    expect(inspectCommandPermissions(root, undefined, ["claude"]).state).toBe("invalid");
  });
  it("projects authored command rules through the real policy plan and preserves user settings", async () => {
    put("aih-org-policy.json", policy());
    put(COMMAND_PERMISSION_PATH, {
      permissions: { deny: ["Read(private/**)"] },
      model: "user-choice",
    });
    const ctx = context();
    await executePlan(await policyProjectCommand.plan(ctx), ctx);
    expect(settings().permissions.deny).toContain("Bash(rm -f harbor-forbidden.txt)");
    expect(settings().permissions.deny).toContain("Read(private/**)");
    expect(settings().permissions.allow).toContain("Bash(git status*)");
    expect(settings().model).toBe("user-choice");
    expect(inspectCommandPermissions(root, policy(), ["claude"])).toMatchObject({
      state: "current",
      nativeEnforcement: "unverified",
    });
  });

  it("updates and withdraws only owned rules while preserving hook writes and overlapping unowned entries", async () => {
    const ctx = context();
    put(COMMAND_PERMISSION_PATH, {
      permissions: { deny: ["Bash(rm -f harbor-forbidden.txt)", "Read(private/**)"] },
    });
    const hook = writeJson(
      COMMAND_PERMISSION_PATH,
      { hooks: { Stop: [{ hooks: [{ type: "command", command: "node user-hook.js" }] }] } },
      "existing hook owner",
      { merge: true },
    );
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [hook])),
      ctx,
    );
    const before = readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8");
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [])),
      ctx,
    );
    expect(readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8")).toBe(before);
    const updated = policy("rm -f cedar-forbidden.txt");
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, updated, ["claude"], [])),
      ctx,
    );
    expect(settings().permissions.deny).toContain("Bash(rm -f harbor-forbidden.txt)");
    expect(settings().permissions.deny).toContain("Bash(rm -f cedar-forbidden.txt)");
    const withdrawn = policy();
    delete withdrawn.command;
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, withdrawn, ["claude"], [])),
      ctx,
    );
    expect(settings().permissions.deny).toEqual([
      "Bash(rm -f harbor-forbidden.txt)",
      "Read(private/**)",
    ]);
    expect(settings().hooks).toBeDefined();
    expect(inspectCommandPermissions(root, withdrawn, ["claude"]).state).toBe("not-requested");
  });

  it("fails closed on edited ownership and on policy loss before guardrails can restore defaults", async () => {
    const ctx = context();
    put("aih-org-policy.json", policy());
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [])),
      ctx,
    );
    rmSync(join(root, "aih-org-policy.json"));
    expect(() => guardrails.plan(ctx)).toThrow(/policy is missing/);
    const edited = settings();
    edited.permissions.deny = edited.permissions.deny.filter(
      (value) => value !== "Bash(rm -f harbor-forbidden.txt)",
    );
    put(COMMAND_PERMISSION_PATH, edited);
    const before = readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8");
    expect(() => projectCommandPermissions(ctx, policy(), ["claude"], [])).toThrow(/drifted/);
    expect(inspectCommandPermissions(root, policy(), ["claude"]).state).toBe("drifted");
    expect(readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8")).toBe(before);
  });

  it("treats missing receipts conservatively and never claims another client's native enforcement", async () => {
    const advisory = projectCommandPermissions(context(), policy(), ["codex"], []);
    expect(advisory.some((action) => action.kind === "write")).toBe(false);
    expect(
      advisory
        .filter((action) => action.kind === "doc")
        .map((action) => action.text)
        .join("\n"),
    ).toContain("No native command restriction is applied");
    const ctx = context();
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], [])),
      ctx,
    );
    rmSync(join(root, COMMAND_PERMISSION_RECEIPT));
    const before = readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8");
    const withdrawn = policy();
    delete withdrawn.command;
    await executePlan(
      plan("fixture", ...projectCommandPermissions(ctx, withdrawn, ["claude"], [])),
      ctx,
    );
    expect(readFileSync(join(root, COMMAND_PERMISSION_PATH), "utf8")).toBe(before);
    expect(inspectCommandPermissions(root, policy(), ["codex"])).toMatchObject({
      state: "not-requested",
      nativeEnforcement: "unverified",
      advisoryTargets: ["codex"],
    });
  });

  it("pins settings before apply and refuses a concurrent replacement without changing receipt authority", async () => {
    const ctx = context();
    const planned = plan("fixture", ...projectCommandPermissions(ctx, policy(), ["claude"], []));
    put(COMMAND_PERMISSION_PATH, { model: "concurrent-customization" });
    await expect(executePlan(planned, ctx)).rejects.toThrow();
    expect(settings().model).toBe("concurrent-customization");
    expect(inspectCommandPermissions(root, policy(), ["claude"]).state).toBe("missing");
  });
});
