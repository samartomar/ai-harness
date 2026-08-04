import { docsLintChecks } from "../docs-lint/index.js";
import { makeHostAdapter } from "../platform/detect.js";
import type { PlanContext } from "./plan.js";
import { defaultRunner } from "./proc.js";

const root = process.cwd();
const env: NodeJS.ProcessEnv = {};
const context: PlanContext = {
  root,
  contextDir: "ai-coding",
  apply: false,
  verify: true,
  json: false,
  run: defaultRunner,
  host: makeHostAdapter({ run: defaultRunner, env }),
  env,
  options: {},
};

const checks = await docsLintChecks(context);
for (const check of checks) {
  const detail = check.detail ? ` — ${check.detail}` : "";
  process.stdout.write(`${check.verdict.toUpperCase()}: ${check.name}${detail}\n`);
}

if (checks.some((check) => check.verdict === "fail")) process.exitCode = 1;
