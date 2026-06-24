import { basename, join, posix } from "node:path";
import { detectFallbackNotice, detectOne, resolveTargets } from "../internals/cli-detect.js";
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
  writeText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { scanRepo } from "../profile/scan.js";
import {
  adapterNote,
  agentBehaviorCoreDoc,
  bootloaderPaths,
  bootloaderPreamble,
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
      return { name, verdict: "fail", detail: "missing — run `aih bootstrap-ai --apply`" };
    }
    const onDisk = extractManagedBlock(text, SHARED_MARKER);
    if (onDisk === undefined) {
      return { name, verdict: "fail", detail: "no managed canonical block found" };
    }
    if (onDisk !== sharedCanonicalBlockBody(dir).trim()) {
      return { name, verdict: "fail", detail: "drifted from the canonical block — regenerate" };
    }
    if (!text.includes("RULE_ROUTER.md")) {
      return { name, verdict: "fail", detail: "does not reference RULE_ROUTER.md" };
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
    const p = await detectOne(ctx, cli);
    return p.present
      ? { name, verdict: "pass", detail: `detected via ${p.via} (${p.detail})` }
      : {
          name,
          verdict: "skip",
          detail: "not detected on this machine (bootloader still written)",
        };
  });
}

/** Probe that the router itself is present. */
function routerProbe(dir: string): Action {
  return probe(`${dir}/RULE_ROUTER.md present`, (ctx: PlanContext): Check => {
    const name = `${dir}/RULE_ROUTER.md present`;
    const text = readIfExists(join(ctx.root, dir, "RULE_ROUTER.md"));
    if (text === undefined) {
      return { name, verdict: "fail", detail: "missing — run `aih bootstrap-ai --apply`" };
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
  const stack = scanRepo(ctx.root, { maxDepth: 8 });
  const repoName = repoNameOf(ctx.root);
  const bootloaders = bootloaderPaths(clis);

  const actions: Action[] = [
    writeText(
      posix.join(dir, "RULE_ROUTER.md"),
      ruleRouterDoc(dir, repoName, stack, bootloaders),
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

  // Doctor probes (run under --verify): router present + every bootloader in sync,
  // plus a step-by-step confirm of which targeted CLIs are actually installed.
  actions.push(routerProbe(dir));
  for (const relPath of bootloaders) actions.push(bootloaderProbe(relPath, dir));
  for (const cli of clis) actions.push(presenceProbe(cli));

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
  options: [],
  plan: bootstrapAiPlan,
};
