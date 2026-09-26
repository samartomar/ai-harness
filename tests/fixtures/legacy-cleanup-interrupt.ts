import { resolve } from "node:path";
import { legacyManifestCleanupActions } from "../../packages/framework-ecc/src/legacy-cleanup/manifest.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const root = process.argv[2];
const boundary = Number(process.argv[3]);
if (root === undefined || !Number.isSafeInteger(boundary) || boundary < 1) process.exit(2);
const run = fakeRunner(() => undefined);
const ctx: PlanContext = {
  root: resolve(root),
  contextDir: "ai-coding",
  apply: true,
  verify: false,
  json: false,
  run,
  host: makeHostAdapter({ platform: "linux", run, env: {} }),
  env: {},
  options: {},
};
let effects = 0;
await executePlan(
  plan("interrupted legacy manifest cleanup", ...legacyManifestCleanupActions(ctx.root)),
  ctx,
  {
    skipWorktreeGate: true,
    onEffectCommitted: () => {
      effects += 1;
      if (effects === boundary) process.exit(77);
    },
  },
);
process.exit(0);
