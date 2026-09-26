import { resolve } from "node:path";
import { legacyCleanupActions } from "../../packages/framework-ecc/src/legacy-cleanup/index.js";
import { legacyManifestCleanupActions } from "../../packages/framework-ecc/src/legacy-cleanup/manifest.js";
import { materializationPruneActions } from "../../packages/framework-ecc/src/legacy-cleanup/materialization.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const root = process.argv[2];
const boundary = Number(process.argv[3]);
const family = process.argv[4] ?? "manifest";
if (
  root === undefined ||
  !Number.isSafeInteger(boundary) ||
  boundary < 0 ||
  !["manifest", "materialization", "multi"].includes(family)
)
  process.exit(2);
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
const kinds = new Set<string>();
let scratchRemovals = 0;
const actions =
  family === "manifest"
    ? legacyManifestCleanupActions(ctx.root)
    : family === "materialization"
      ? materializationPruneActions(ctx.root, ["claude"])
      : [
          ...legacyCleanupActions(ctx, "uninstall"),
          ...materializationPruneActions(ctx.root, ["claude"]),
        ];
await executePlan(plan(`interrupted legacy ${family} cleanup`, ...actions), ctx, {
  skipWorktreeGate: true,
  onEffectCommitted: (kind, path) => {
    effects += 1;
    kinds.add(kind);
    if (kind === "remove" && /\.aih\.(?:tmp|bak)$/.test(path)) scratchRemovals += 1;
    if (effects === boundary) process.exit(77);
  },
});
process.stdout.write(JSON.stringify({ effects, kinds: [...kinds].sort(), scratchRemovals }));
process.exit(0);
