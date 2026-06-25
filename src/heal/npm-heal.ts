import { type Action, digest, type PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { captured, classifyTool, type HealShared, type HealStep, versionArgv } from "./common.js";
import { nodeMissingDoc, npmOfflineDoc, npmReinstallDoc } from "./templates.js";

/** First non-empty trimmed line of `text` (for terse error details). */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

/** Is `node` resolvable on PATH? (aih runs under Node, but the user's PATH may differ.) */
async function nodeCheck(ctx: PlanContext): Promise<Check> {
  const win = ctx.host.platform === "windows";
  const res = await ctx.run(versionArgv(ctx.host.platform, "node"));
  if (classifyTool(res, win) === "absent") {
    return { name: "node: runtime", verdict: "fail", detail: "node not found on PATH" };
  }
  return { name: "node: runtime", verdict: "pass", detail: `node ${res.stdout.trim()}` };
}

/** Is `npm` present and runnable? A non-zero exit (e.g. a missing module) = broken. */
async function npmCheck(ctx: PlanContext, nodeOk: boolean): Promise<Check> {
  if (!nodeOk) {
    return {
      name: "npm: runtime",
      verdict: "skip",
      detail: "blocked on node (install Node first)",
    };
  }
  const win = ctx.host.platform === "windows";
  const res = await ctx.run(versionArgv(ctx.host.platform, "npm"));
  const state = classifyTool(res, win);
  if (state === "absent") {
    return { name: "npm: runtime", verdict: "fail", detail: "npm not found on PATH" };
  }
  if (state === "broken") {
    const why = firstLine(res.stderr) || `exit ${res.code}`;
    return { name: "npm: runtime", verdict: "fail", detail: `\`npm --version\` failed: ${why}` };
  }
  return { name: "npm: runtime", verdict: "pass", detail: `npm ${res.stdout.trim()}` };
}

/**
 * The npm self-heal ladder, doc-only (no action contacts a remote):
 *   L0 npm works               → no fix
 *   L1 npm broken, registry OK → emit the Node-https reinstall script
 *   L2 npm broken, registry NO → emit the offline reinstall guidance
 *   L3 node missing            → emit "install Node >= 20"
 */
async function planNpmHeal(ctx: PlanContext, shared: HealShared): Promise<Action[]> {
  const node = await nodeCheck(ctx);
  const npm = await npmCheck(ctx, node.verdict === "pass");
  const actions: Action[] = [captured(node), captured(npm)];

  if (node.verdict === "fail") {
    actions.push(digest("heal: install Node.js", nodeMissingDoc())); // L3
    return actions;
  }
  if (npm.verdict !== "fail") return actions; // L0

  if (shared.tlsRegistry.verdict === "pass") {
    actions.push(digest("heal: reinstall npm via Node's TLS", npmReinstallDoc())); // L1
  } else {
    actions.push(digest("heal: reinstall npm offline", npmOfflineDoc(ctx.host.npmCliPath()))); // L2
  }
  return actions;
}

export const npmStep: HealStep = {
  key: "npm",
  title: "npm runtime",
  plan: planNpmHeal,
};
