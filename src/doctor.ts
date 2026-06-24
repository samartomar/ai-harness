import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectClis, presentClis } from "./internals/cli-detect.js";
import { type CommandSpec, plan, probe } from "./internals/plan.js";

/**
 * Fail-closed preflight. Returns probe actions; the read-only command path forces
 * `verify`, so probes run and the verification report drives the exit code. A
 * `skip` (tool/artifact absent) never fails the run — only a hard `fail` does.
 */
export const command: CommandSpec = {
  name: "doctor",
  summary: "Verify the harness / workstation / repo configuration (fail-closed)",
  readOnly: true,
  options: [],
  plan: (ctx) =>
    plan(
      "doctor",
      probe("node runtime >= 20", () => {
        const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        return major >= 20
          ? { name: "node-version", verdict: "pass", detail: `node ${process.versions.node}` }
          : { name: "node-version", verdict: "fail", detail: `node ${process.versions.node} < 20` };
      }),
      probe("git available", async () => {
        const res = await ctx.run(["git", "--version"]);
        return res.spawnError
          ? { name: "git", verdict: "skip", detail: "git not found on PATH" }
          : { name: "git", verdict: "pass", detail: res.stdout.trim() };
      }),
      probe("platform adapter", () => ({
        name: "platform",
        verdict: ctx.host.verified ? "pass" : "skip",
        detail: `${ctx.host.platform}${ctx.host.verified ? " (verified)" : " (unverified path)"}`,
      })),
      probe("canonical context dir", () => {
        const dir = join(ctx.root, ctx.contextDir);
        return existsSync(dir)
          ? { name: "context-dir", verdict: "pass", detail: dir }
          : {
              name: "context-dir",
              verdict: "skip",
              detail: `${ctx.contextDir} not scaffolded — run: aih scaffold --apply`,
            };
      }),
      probe("AI CLIs detected", async () => {
        const present = presentClis(await detectClis(ctx));
        return present.length > 0
          ? { name: "ai-clis", verdict: "pass", detail: present.join(", ") }
          : {
              name: "ai-clis",
              verdict: "skip",
              detail: "none detected — target explicitly with --cli or --all-tools",
            };
      }),
    ),
};
