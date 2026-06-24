import { join, posix } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import {
  type Action,
  type CommandSpec,
  doc,
  exec,
  type Plan,
  type PlanContext,
  plan,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanRepo } from "../profile/scan.js";
import { moduleFor } from "./rules.js";
import { selectModules } from "./select.js";

/** Subdirectory (under the context dir) where ECC rule modules live. */
const ECC_SUBDIR = "rules/ecc";

function moduleRelPath(ctx: PlanContext, slug: string): string {
  return posix.join(ctx.contextDir, ECC_SUBDIR, `${slug}.md`);
}
function routerRelPath(ctx: PlanContext): string {
  return posix.join(ctx.contextDir, ECC_SUBDIR, "RULE_ROUTER.md");
}
function manifestRelPath(ctx: PlanContext): string {
  return posix.join(ctx.contextDir, ECC_SUBDIR, "manifest.json");
}

/** The modules installed by a previous run (drives self-heal pruning). */
function previousModules(ctx: PlanContext): string[] {
  const raw = readIfExists(join(ctx.root, ctx.contextDir, ECC_SUBDIR, "manifest.json"));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { modules?: unknown }).modules)
    ) {
      return (parsed as { modules: unknown[] }).modules.filter(
        (m): m is string => typeof m === "string",
      );
    }
  } catch {
    // malformed manifest — treat as "nothing previously installed"
  }
  return [];
}

/** The RULE_ROUTER: the entry point an agent loads to know which rules apply. */
function routerDoc(modules: string[]): string {
  const rows = modules.map((slug) => {
    const m = moduleFor(slug);
    return m ? `- **${slug}.md** — ${m.summary} _(load: ${m.when})_` : `- **${slug}.md**`;
  });
  return lines(
    "# RULE_ROUTER — ECC",
    "",
    "Active engineering rules for this repo, customized to the DETECTED stack by",
    "`aih ecc`. Load `common.md` before any non-trivial change; load a stack module",
    "when its trigger matches. These are standards to follow, not suggestions.",
    "",
    rows,
    "",
    "Re-run `aih ecc` (or `aih init`) after the stack changes — the active set",
    "self-heals: new modules are added and modules that no longer apply are removed.",
  );
}

/** Human note summarizing what was installed. */
function summaryDoc(modules: string[], installedEverything: boolean): string {
  if (installedEverything) {
    return lines(
      "No stack was detected (empty/new repo), so the FULL ECC rule set was installed.",
      "Add your code, then re-run `aih ecc` (or `aih init`) — the rule set self-heals",
      "down to exactly the modules your stack needs.",
    );
  }
  return lines(
    `Installed ECC rules for the detected stack: ${modules.join(", ")}.`,
    "The RULE_ROUTER lists them and their load order. Re-run to self-heal after the",
    "stack changes.",
  );
}

/**
 * Install the ECC engineering-rule set CUSTOMIZED to the repo's detected stack:
 * `common` always, plus the language/framework modules that apply. On a repo with
 * no detectable stack, install everything (the user re-runs once there's code and
 * the set self-heals). Re-running prunes modules that no longer apply (a local
 * `rm`/`del` exec) and refreshes the router + manifest — all local, idempotent.
 */
function eccPlan(ctx: PlanContext): Plan {
  const stack = scanRepo(ctx.root, { maxDepth: 8 });
  const { modules, installedEverything } = selectModules(stack);
  const previous = previousModules(ctx);

  const actions: Action[] = [];
  for (const slug of modules) {
    const mod = moduleFor(slug);
    if (mod) actions.push(writeText(moduleRelPath(ctx, slug), mod.body, `ECC rule: ${slug}`));
  }
  actions.push(
    writeText(
      routerRelPath(ctx),
      routerDoc(modules),
      "ECC RULE_ROUTER (active modules + load order)",
    ),
  );
  actions.push(
    writeJson(
      manifestRelPath(ctx),
      { modules },
      "ECC install manifest (drives self-heal on re-run)",
    ),
  );

  // Self-heal: drop modules a previous run installed that no longer apply.
  for (const slug of previous.filter((p) => !modules.includes(p))) {
    const abs = join(ctx.root, ctx.contextDir, ECC_SUBDIR, `${slug}.md`);
    const argv =
      ctx.host.platform === "windows" ? ["cmd", "/c", "del", "/q", abs] : ["rm", "-f", abs];
    actions.push(exec(`self-heal: remove stale ECC module ${slug}`, argv, { allowFailure: true }));
  }

  actions.push(
    doc("ECC setup customized for the detected stack", summaryDoc(modules, installedEverything)),
  );
  return plan("ecc", ...actions);
}

export const command: CommandSpec = {
  name: "ecc",
  summary: "Install ECC engineering rules customized to the detected stack (self-heals on re-run)",
  options: [],
  plan: eccPlan,
};
