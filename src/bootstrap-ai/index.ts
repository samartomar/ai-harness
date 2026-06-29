import { basename, join, posix } from "node:path";
import { aihConfigJson } from "../config/marker.js";
import { detectFallbackNotice, detectInstall, resolveTargets } from "../internals/cli-detect.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import { extractManagedBlock, type ManagedBlock, mergeManagedBlock } from "../internals/markers.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type Plan,
  type PlanContext,
  plan,
  probe,
  writeJson,
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { agentToolsSteering, kiroHooks } from "../kiro/content.js";
import { type GeneratedDoc, lintProbes } from "../lint/run.js";
import { scanRepo } from "../profile/scan.js";
import {
  adapterNote,
  agentBehaviorCoreDoc,
  bootloaderPaths,
  bootloaderPreamble,
  harnessUpdateDoc,
  otherToolsDoc,
  regenerationDoc,
  ruleRouterDoc,
  SHARED_MARKER,
  sharedBlock,
  sharedCanonicalBlockBody,
} from "./canon.js";

/** A best-effort repo name for the router heading. */
function repoNameOf(root: string): string {
  const base = basename(root);
  return base.length > 0 ? base : "this repo";
}

/**
 * Probe one bootloader: it must exist, carry the shared canonical block, and the
 * on-disk block must match the freshly-generated one (no drift). Run WITHOUT
 * `--apply` this is the CI drift gate; run WITH `--apply` it confirms the write.
 */
function bootloaderProbe(relPath: string, dir: string): Action {
  return probe(`bootloader ${relPath} in sync`, (ctx: PlanContext): Check => {
    const name = `bootloader ${relPath} in sync`;
    const text = readIfExists(join(ctx.root, relPath));
    if (text === undefined) {
      return {
        name,
        verdict: "fail",
        detail: "missing — run `aih bootstrap-ai --apply`",
        code: "cli.bootloader-missing",
      };
    }
    const onDisk = extractManagedBlock(text, SHARED_MARKER);
    if (onDisk === undefined) {
      return {
        name,
        verdict: "fail",
        detail: "no managed canonical block found",
        code: "cli.bootloader-missing",
      };
    }
    if (onDisk !== sharedCanonicalBlockBody(dir).trim()) {
      return {
        name,
        verdict: "fail",
        detail: "drifted from the canonical block — regenerate",
        code: "cli.bootloader-drift",
      };
    }
    if (!text.includes("RULE_ROUTER.md")) {
      return {
        name,
        verdict: "fail",
        detail: "does not reference RULE_ROUTER.md",
        code: "cli.bootloader-drift",
      };
    }
    return { name, verdict: "pass", detail: "carries the current shared block" };
  });
}

/**
 * Confirm-step probe: is this CLI actually installed on the machine? Present →
 * pass; absent → `skip` (informational — the bootloader is still written, the
 * tool just isn't here yet), never a hard fail.
 */
function presenceProbe(cli: Cli): Action {
  return probe(`${cli} installed`, async (ctx: PlanContext): Promise<Check> => {
    const name = `${cli} installed`;
    const install = (await detectInstall(ctx)).find((i) => i.cli === cli);
    if (install?.binary) {
      return { name, verdict: "pass", detail: `runnable on PATH (${install.binaryDetail})` };
    }
    if (install?.config) {
      return {
        name,
        verdict: "skip",
        detail: `${install.configDetail} exists, but no CLI binary is on PATH (config-only; setup skipped by --detect)`,
        code: "cli.config-only",
      };
    }
    return {
      name,
      verdict: "skip",
      detail: "not detected on this machine (bootloader still written)",
      code: "cli.not-detected",
    };
  });
}

/** Probe that the router itself is present. */
function routerProbe(dir: string): Action {
  return probe(`${dir}/RULE_ROUTER.md present`, (ctx: PlanContext): Check => {
    const name = `${dir}/RULE_ROUTER.md present`;
    const text = readIfExists(join(ctx.root, dir, "RULE_ROUTER.md"));
    if (text === undefined) {
      return {
        name,
        verdict: "fail",
        detail: "missing — run `aih bootstrap-ai --apply`",
        code: "canon.router-missing",
      };
    }
    return { name, verdict: "pass", detail: "router present" };
  });
}

/**
 * `aih bootstrap-ai` — lay down the repo's Layer-2 `ai-coding/` canon and verify
 * it (the repo doctor). Emits the RULE_ROUTER, the shared canonical block source,
 * a per-CLI adapter note, the REGENERATION doc, and the root bootloaders
 * (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/Cursor/Windsurf/Copilot) — each a
 * tool-specific preamble plus the marker-delimited shared block, merged into any
 * existing file so hand-edits survive. Under `--verify` the doctor probes confirm
 * the router exists and every bootloader carries the current block (drift gate).
 * Honors `--cli`/`--all-tools` (default claude) and `--context-dir`.
 */
async function bootstrapAiPlan(ctx: PlanContext): Promise<Plan> {
  const dir = ctx.contextDir;
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const repoName = repoNameOf(ctx.root);
  const bootloaders = bootloaderPaths(clis);

  // Keep pointing at a carved project extension once `aih adopt` has written one,
  // so a standalone `bootstrap-ai` re-run doesn't drop the reference.
  const hasProjectExtension =
    readIfExists(join(ctx.root, dir, "rules", "project-canon-extension.md")) !== undefined;

  const actions: Action[] = [
    writeText(
      posix.join(dir, "RULE_ROUTER.md"),
      ruleRouterDoc(dir, repoName, stack, bootloaders, { projectExtension: hasProjectExtension }),
      "stack-aware routing entry point",
    ),
    writeText(
      posix.join(dir, "adapters", "_shared-canonical-block.md"),
      sharedCanonicalBlockBody(dir),
      "shared canonical block (single source for every bootloader)",
    ),
    writeText(
      posix.join(dir, "rules", "agent-behavior-core.md"),
      agentBehaviorCoreDoc(dir),
      "agent behavior core (the working discipline the router + bootloaders point to)",
    ),
    // Keep the harness's own backup/temp files out of git.
    aihIgnoreWrite(ctx.root),
  ];

  // One tool-specific adapter note per selected CLI.
  for (const cli of clis) {
    actions.push(
      writeText(
        posix.join(dir, "adapters", `${cli}.md`),
        adapterNote(cli, dir),
        `${cli} adapter note`,
      ),
    );
  }

  actions.push(
    writeText(
      posix.join(dir, "adapters", "other-tools.md"),
      otherToolsDoc(dir),
      "how to wire any AI tool aih doesn't natively target (Kiro, etc.)",
    ),
    writeText(
      posix.join(dir, "REGENERATION.md"),
      regenerationDoc(dir, bootloaders),
      "managed-block model + regenerate/doctor flow",
    ),
    writeText(
      posix.join(dir, "harness-update.md"),
      harnessUpdateDoc(dir),
      "update contract: harness-managed vs user-owned files + the update path",
    ),
  );

  // Root bootloaders: merge the shared block into any existing file (preserve hand-edits).
  const block = sharedBlock(dir);
  for (const relPath of bootloaders) {
    const existing = readIfExists(join(ctx.root, relPath));
    const merged = mergeBootloader(existing, relPath, dir, repoName, block);
    actions.push(
      writeText(relPath, merged, `bootloader ${relPath} (preamble + managed canonical block)`),
    );
  }

  // Persist the bootstrap intent (context-dir + resolved CLI targets) at the repo
  // root so `aih report` / `aih doctor` grade against the tools this repo was wired
  // for — not the `claude` default — even on a standalone `bootstrap-ai` run. Under
  // `aih init` the orchestrator resolves once and owns this write (ctx.targets set),
  // so skip it here to avoid a duplicate. Merge preserves adopt's acknowledged list.
  if (ctx.targets === undefined) {
    actions.push(
      writeJson(
        ".aih-config.json",
        aihConfigJson(dir, clis),
        "persist bootstrap intent (context-dir + CLI targets) so report/doctor read it",
        { merge: true },
      ),
    );
  }

  // Kiro-native extras (Kiro can't read ~/.claude): always-on agent-tools steering
  // + a small stack-aware hook set in Kiro's real `.kiro.hook` schema.
  if (clis.includes("kiro")) {
    actions.push(
      writeText(
        ".kiro/steering/agent-tools.md",
        agentToolsSteering(stack),
        "Kiro steering: stack-aware CLI tool usage",
      ),
    );
    for (const h of kiroHooks(stack)) {
      const label = h.path.replace(/^\.kiro\/hooks\//, "").replace(/\.kiro\.hook$/, "");
      actions.push(writeJson(h.path, h.hook, `Kiro hook: ${label} (.kiro.hook schema)`));
    }
  }

  // Doctor probes (run under --verify): router present + every bootloader in sync,
  // plus a step-by-step confirm of which targeted CLIs are actually installed.
  actions.push(routerProbe(dir));
  for (const relPath of bootloaders) actions.push(bootloaderProbe(relPath, dir));
  for (const cli of clis) actions.push(presenceProbe(cli));

  // Weak-model-safety lint of the canon this run authors (under --verify): every
  // `#[[file:…]]` / backtick path resolves, no leftover scaffolding, prose is
  // imperative. Lint the GENERATED content — for bootloaders that's the preamble
  // + managed block body, NOT the merged file, so a user's hand-edits outside the
  // markers are never policed. Refs resolve against the set this plan will write.
  const bootloaderSet = new Set<string>(bootloaders);
  const plannedPaths = new Set<string>();
  const generated: GeneratedDoc[] = [];
  for (const a of actions) {
    if (a.kind !== "write") continue;
    const p = a.path.replace(/\\/g, "/");
    plannedPaths.add(p);
    if (bootloaderSet.has(a.path) || a.path === ".gitignore") continue;
    if (typeof a.contents === "string") generated.push({ path: p, source: a.contents });
  }
  for (const relPath of bootloaders) {
    generated.push({
      path: relPath.replace(/\\/g, "/"),
      source: `${bootloaderPreamble(relPath, dir, repoName)}\n\n${block.body}`,
    });
  }
  actions.push(...lintProbes(generated, plannedPaths, ctx.root, dir));

  // If --detect found nothing and we defaulted to claude, say so plainly.
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }

  // A short orientation doc so the dry-run explains itself.
  actions.push(
    doc("bootstrap-ai summary (Layer-2 ai-coding canon)", summaryText(dir, clis, bootloaders)),
  );

  return plan("bootstrap-ai", ...actions);
}

function summaryText(dir: string, clis: string[], bootloaders: string[]): string {
  return [
    `Layered AI canon for ${clis.join(", ")}.`,
    "",
    `Layer 2 (this repo): ${dir}/RULE_ROUTER.md + ${dir}/adapters/ + ${dir}/REGENERATION.md`,
    `Bootloaders: ${bootloaders.join(", ")} (tool preamble + a regenerated shared block).`,
    "",
    "Layer 1 (user baseline): install ECC + Superpowers with `aih ecc` / `aih superpowers`.",
    "Context dir (INDEX/architecture/conventions): `aih scaffold`. Re-run `aih bootstrap-ai`",
    "to regenerate (idempotent); `aih bootstrap-ai --verify` is the drift gate.",
  ].join("\n");
}

function mergeBootloader(
  existing: string | undefined,
  relPath: string,
  dir: string,
  repoName: string,
  block: ManagedBlock,
): string {
  return mergeManagedBlock(existing, block, bootloaderPreamble(relPath, dir, repoName));
}

export const command: CommandSpec = {
  name: "bootstrap-ai",
  summary:
    "Emit and verify the repo's Layer-2 ai-coding canon (RULE_ROUTER + per-CLI adapters + bootloaders)",
  options: [
    {
      flags: "--sarif <file>",
      description:
        "write the --verify drift report as SARIF 2.1.0 for GitHub code-scanning (`-` → stdout)",
    },
  ],
  plan: bootstrapAiPlan,
};
