import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../internals/merge.js";
import type { PlanContext } from "../../internals/plan.js";
import type { Check } from "../../internals/verify.js";
import { claudeHomeDir, isHomeScopedTarget } from "../hosts/claude/index.js";
import { type BindingLockRead, readBindingLock } from "../lock.js";

/**
 * ECC doctor probes (W4d) — two READ-ONLY diagnostics over the Claude
 * project-scope settings and the binding lock, wired into `aih doctor`
 * (`src/doctor.ts`):
 *
 *  - {@link eccDoubleInstallCheck}: upstream ECC explicitly warns that
 *    installing BOTH the plugin AND a manual rules copy stacks duplicates.
 *    FAILs only when both surfaces are present at once.
 *  - {@link eccModeExclusivityCheck}: the binding lock's declared ECC mode
 *    (lean/full) must match what is actually installed — an `ecc@`-prefixed
 *    `enabledPlugins` entry vs. home-scoped Lean component ownership recorded
 *    in the lock. A mismatch means the lock and the live state disagree.
 *
 * Both read tolerantly (a missing or malformed `.claude/settings.json` is "no
 * plugin enable found", never a crash) and are fully deterministic — no
 * timestamps, no randomness — so two consecutive runs against the same state
 * produce byte-identical `Check` output (the doctor stability rule). A
 * corrupt binding lock is a FINDING (`eccModeExclusivityCheck` catches
 * `BindingLockError` and fails with its message), never a thrown crash —
 * doctor is read-only diagnostics.
 */

const ECC_PLUGIN_ENABLE_PATTERN = /^ecc@/;

/** `enabledPlugins` keys from `<root>/.claude/settings.json`, read tolerantly (absent/malformed -> []). */
function projectEnabledPluginKeys(root: string): string[] {
  const raw = readIfExists(join(root, ".claude", "settings.json"));
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = parseJsoncText(raw);
  } catch {
    return [];
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.enabledPlugins)) return [];
  return Object.keys(parsed.enabledPlugins);
}

/** The subset of `keys` that are an ECC plugin enable (`ecc@<marketplace>`). */
function eccPluginKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => ECC_PLUGIN_ENABLE_PATTERN.test(key));
}

/** `.claude/rules/ecc/` locations that count as a manual ECC copy (project and/or home scope). */
function manualEccCopyLocations(root: string, home: string): string[] {
  const found: string[] = [];
  if (existsSync(join(root, ".claude", "rules", "ecc"))) found.push("project:.claude/rules/ecc");
  if (existsSync(join(home, ".claude", "rules", "ecc"))) found.push("home:.claude/rules/ecc");
  return found;
}

/**
 * FAIL when an `ecc@`-prefixed plugin enable AND a manual ECC rules copy are
 * BOTH present at once — upstream warns that stacking the two produces
 * duplicates. PASS otherwise, naming whichever of the two (if either) was
 * found.
 */
export function eccDoubleInstallCheck(ctx: PlanContext): Check {
  const name = "ecc-double-install";
  const pluginKeys = eccPluginKeys(projectEnabledPluginKeys(ctx.root));
  const manualLocations = manualEccCopyLocations(ctx.root, claudeHomeDir(ctx.env));

  if (pluginKeys.length > 0 && manualLocations.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `ECC plugin enabled (${pluginKeys.join(", ")}) AND a manual ECC rules copy present ` +
        `(${manualLocations.join(", ")}) — installing both stacks duplicates per upstream guidance; remove one`,
    };
  }
  if (pluginKeys.length > 0) {
    return {
      name,
      verdict: "pass",
      detail: `ECC plugin enabled (${pluginKeys.join(", ")}); no manual ECC rules copy found`,
    };
  }
  if (manualLocations.length > 0) {
    return {
      name,
      verdict: "pass",
      detail: `manual ECC rules copy present (${manualLocations.join(", ")}); no ECC plugin enabled`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: "no ECC plugin enable and no manual ECC rules copy found",
  };
}

/**
 * FAIL when the binding lock's declared ECC mode disagrees with what is
 * actually installed:
 *  - `mode: "lean"` but an `ecc@`-prefixed plugin is enabled (a plugin
 *    installed on top of a Lean bind);
 *  - `mode: "full"` but no `ecc@` plugin is enabled while home-scoped Lean
 *    component ownership (a `home:`-prefixed ownership target) is still
 *    recorded in the lock.
 * PASS when the lock is absent, the bound framework is not `ecc`, or the mode
 * and installed state agree — nothing to enforce either way.
 */
export function eccModeExclusivityCheck(ctx: PlanContext): Check {
  const name = "ecc-mode-exclusivity";
  let read: BindingLockRead;
  try {
    read = readBindingLock(ctx.root);
  } catch (err) {
    return { name, verdict: "fail", detail: (err as Error).message };
  }
  if (!read.present) {
    return { name, verdict: "pass", detail: "no binding lock present — nothing to enforce" };
  }

  const { declaration, ownership } = read.lock;
  if (declaration.framework.id !== "ecc") {
    return {
      name,
      verdict: "pass",
      detail: `bound framework is "${declaration.framework.id}", not ecc — nothing to enforce`,
    };
  }

  const mode = declaration.framework.mode ?? "lean";
  const pluginKeys = eccPluginKeys(projectEnabledPluginKeys(ctx.root));
  const homeOwnershipTargets = ownership
    .map((entry) => entry.target)
    .filter((target) => isHomeScopedTarget(target));

  if (mode === "lean" && pluginKeys.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `lean mode lock but an ecc@ plugin entry (${pluginKeys.join(", ")}) is enabled — ` +
        `mode/state mismatch (a plugin stacked on a Lean bind produces duplicates)`,
    };
  }
  if (mode === "full" && pluginKeys.length === 0 && homeOwnershipTargets.length > 0) {
    return {
      name,
      verdict: "fail",
      detail:
        `full mode lock but no ecc@ plugin entry is enabled while home-scoped Lean component ` +
        `ownership exists (${homeOwnershipTargets.join(", ")}) — mode/state mismatch`,
    };
  }
  if (mode === "lean") {
    return {
      name,
      verdict: "pass",
      detail: "lean mode lock with no ecc@ plugin entry — consistent",
    };
  }
  return pluginKeys.length > 0
    ? {
        name,
        verdict: "pass",
        detail: `full mode lock with an ecc@ plugin entry (${pluginKeys.join(", ")}) — consistent`,
      }
    : {
        name,
        verdict: "pass",
        detail:
          "full mode lock with no ecc@ plugin entry and no lean home-scoped ownership — consistent",
      };
}
