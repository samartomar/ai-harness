import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { executePlan } from "../../../../src/internals/execute.js";
import { type PlanContext, plan } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";
import { planGovernedCodexRoleRegistration } from "../../src/profile/governed-codex-roles.js";

const root = mkdtempSync(join(tmpdir(), "aih-governed-codex-roles-"));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function context(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

it("retires a governed role receipt after its block is absent and preserves operator TOML bytes", async () => {
  const path = join(root, ".codex/config.toml");
  mkdirSync(dirname(path), { recursive: true });
  const operator = Buffer.from('model = "operator-choice"\r\n');
  writeFileSync(path, operator);
  const roles = [
    { id: "reviewer", description: "reviewer", configFile: ".codex/agents/reviewer.toml" },
  ];
  await executePlan(planGovernedCodexRoleRegistration(root, roles), context());
  await executePlan(
    plan("remove roles", ...planGovernedCodexRoleRegistration(root, []).actions),
    context(),
  );
  expect(readFileSync(path)).toEqual(operator);
  expect(existsSync(join(root, ".aih/ecc/codex-role-registration-v1.json"))).toBe(false);
});
