import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import {
  type Action,
  type CommandSpec,
  doc,
  exec,
  type Plan,
  type PlanContext,
  plan,
  probe,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import {
  type EccInstallInputs,
  eccActionsForCli,
  eccSupplyChainDoc,
  eccToolsDoc,
} from "./install.js";
import { codexMcpCollisionActions } from "./codex.js";
import { eccLanguages } from "./select.js";

const ECC_REPO_URL = "https://github.com/affaan-m/ECC.git";

/** Cache dir for ECC's git checkout (Kiro isn't on npm, so it needs the repo). */
function eccCacheDir(ctx: PlanContext): string {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  return join(home, ".claude", "ecc");
}

/**
 * Resolve the Git Bash executable that runs ECC's `.kiro/install.sh`. POSIX has
 * `bash` on PATH, so it's returned as-is. Windows is the trap: a DEFAULT Git for
 * Windows install puts only `Git\cmd` (git.exe) on PATH — NOT `Git\bin` (bash.exe)
 * — so a bare `bash` argv ENOENTs to exit 127. We probe the standard install
 * locations on disk and return the ABSOLUTE `bash.exe` path (execFile runs an
 * absolute .exe regardless of PATH). Returns undefined when no Git Bash is
 * installed, so the caller escalates instead of spawning a doomed command.
 * Plan-time existsSync is already precedented below (the ECC cache `.git` probe).
 */
function resolveBash(ctx: PlanContext): string | undefined {
  if (ctx.host.platform !== "windows") return "bash";
  const bases = [
    ctx.env.ProgramFiles,
    ctx.env["ProgramFiles(x86)"],
    ctx.env.LocalAppData ? join(ctx.env.LocalAppData, "Programs") : undefined,
  ];
  for (const base of bases) {
    if (!base) continue;
    const candidate = join(base, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The action(s) that run ECC's `.kiro/install.sh` under Git Bash. With Git Bash
 * present we emit the exec with an ABSOLUTE bash path plus a `failureCheck`, so a
 * non-zero install lands in the verification report as a routable ticket instead of
 * a bare "(exit 127)" under a misleading "Applied ecc". When Windows has no Git Bash
 * we DON'T spawn a doomed `bash` (a guaranteed 127) — we name the fix in a printed
 * headline and emit a coded probe so `--verify` escalates it.
 */
function kiroInstallActions(ctx: PlanContext, dir: string, posix: string): Action[] {
  const bash = resolveBash(ctx);
  if (bash === undefined) {
    return [
      doc(
        "ECC Kiro install needs Git Bash — install Git for Windows or add Git\\bin to PATH",
        lines(
          "ECC's `.kiro/install.sh` runs under Git Bash, but no `bash.exe` was found in a",
          "standard Git for Windows location — so Git for Windows isn't installed here. (A",
          "default install puts only `Git\\cmd` on PATH, not `Git\\bin`, but aih probes the",
          "install dirs directly, so this means it's genuinely absent.)",
          "",
          "Fix: install Git for Windows (https://git-scm.com/download/win), which bundles Git",
          "Bash, then re-run `aih ecc --cli kiro --apply`. npm-target CLIs (claude/codex/…) do",
          "not need Git Bash — only the Kiro installer does.",
        ),
      ),
      probe("Kiro ECC install: Git Bash present (Windows)", () => ({
        name: "Kiro ECC install: Git Bash present (Windows)",
        verdict: "fail",
        code: "env.git-bash-missing",
        detail:
          "no Git Bash (bash.exe) found in a standard Git for Windows location; ECC's " +
          ".kiro/install.sh cannot run — install Git for Windows, then re-run " +
          "`aih ecc --cli kiro --apply`",
      })),
    ];
  }
  return [
    exec(
      `Install ECC for Kiro — run ${posix}/.kiro/install.sh into ${ctx.root}/.kiro/ (under --apply)`,
      [bash, join(dir, ".kiro", "install.sh"), ctx.root],
      {
        // A failed install otherwise renders as a bare "(exit 127)" under a misleading
        // "Applied ecc", with the exit code silently non-zero and the report showing
        // "0 failed". Land it IN the report so --verify escalates it (peer:
        // heal/cert-verify.ts's persist exec). Only a spawn failure / 127 is actually
        // "Git Bash missing" — a bash we resolved can still fail install.sh for its own
        // reason (interrupted clone, read-only root, an ECC installer bug); leave that
        // uncoded so it surfaces + flips the exit WITHOUT misrouting the "install Git
        // for Windows" self-fix guidance.
        failureCheck: (result) => {
          const bashMissing = result.spawnError === true || result.code === 127;
          const exit = result.code ?? "on a signal";
          return bashMissing
            ? {
                name: "Kiro ECC install (Git Bash)",
                verdict: "fail",
                code: "env.git-bash-missing",
                detail: `Git Bash could not run ECC's .kiro/install.sh (exit ${exit}); ensure Git for Windows is installed, then re-run \`aih ecc --cli kiro --apply\``,
              }
            : {
                name: "Kiro ECC install (Git Bash)",
                verdict: "fail",
                detail: `ECC's .kiro/install.sh exited ${exit}; re-run \`aih ecc --cli kiro --apply\` — if it persists, check the ECC installer output`,
              };
        },
      },
    ),
  ];
}

/**
 * ECC's Kiro path. Kiro content isn't on npm, so aih uses a git checkout of ECC
 * and runs its native `.kiro/install.sh` (which copies ECC's curated Kiro
 * agents/skills/steering/hooks/scripts/settings into the repo's `.kiro/`,
 * idempotent). To stay on the LATEST version with no pre-existing checkout: a
 * shallow `git clone` into a cache dir on first run, `git pull` to refresh on
 * later runs. `--ecc-path <dir>` overrides with an existing local checkout. Every
 * step is an `exec` that runs only under `--apply`; on Windows it uses Git Bash.
 */
function kiroEccActions(ctx: PlanContext): Action[] {
  const explicit = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  const dir = explicit || eccCacheDir(ctx);
  const posix = dir.replace(/\\/g, "/");
  const installActions = kiroInstallActions(ctx, dir, posix);

  if (explicit) {
    return [
      ...installActions,
      doc(
        "ECC Kiro install (local checkout via --ecc-path)",
        lines(
          `Using the ECC checkout at \`${posix}\`. \`.kiro/install.sh\` copies ECC's curated`,
          "Kiro agents/skills/steering/hooks/scripts/settings into this repo's `.kiro/`",
          "(idempotent). On Windows it runs via Git Bash.",
        ),
      ),
    ];
  }

  // Fresh machine: shallow-clone ECC into the cache on first run, refresh on later
  // runs, then run the native installer. `AIH_ECC_REF` pins the checkout to a
  // tag/branch (supply-chain control); unset tracks latest.
  const hasCache = existsSync(join(dir, ".git"));
  const ref = (ctx.env.AIH_ECC_REF ?? "").trim();
  const fetchExecs: Action[] = [];
  if (ref) {
    if (hasCache) {
      fetchExecs.push(
        exec(
          `Fetch ECC ref ${ref} — git -C ${posix} fetch --depth 1 origin ${ref} (under --apply)`,
          ["git", "-C", dir, "fetch", "--depth", "1", "origin", ref],
        ),
        exec(`Pin ECC to ${ref} — git -C ${posix} checkout --detach FETCH_HEAD (under --apply)`, [
          "git",
          "-C",
          dir,
          "checkout",
          "--detach",
          "FETCH_HEAD",
        ]),
      );
    } else {
      fetchExecs.push(
        exec(`Clone ECC pinned to ${ref} (shallow) into ${posix} (under --apply)`, [
          "git",
          "clone",
          "--depth",
          "1",
          "--branch",
          ref,
          ECC_REPO_URL,
          dir,
        ]),
      );
    }
  } else {
    fetchExecs.push(
      hasCache
        ? exec(
            `Update cached ECC to latest — git -C ${posix} pull (under --apply)`,
            ["git", "-C", dir, "pull", "--ff-only"],
            { allowFailure: true },
          )
        : exec(`Clone ECC (latest, shallow) into ${posix} — git clone --depth 1 (under --apply)`, [
            "git",
            "clone",
            "--depth",
            "1",
            ECC_REPO_URL,
            dir,
          ]),
    );
  }

  return [
    ...fetchExecs,
    ...installActions,
    doc(
      "ECC Kiro install (latest via cached git checkout)",
      lines(
        "Kiro content isn't on npm, so aih keeps a shallow git checkout of ECC at",
        `\`${posix}\` — ${hasCache ? "refreshed to the latest with `git pull`" : "cloned with `git clone --depth 1`"}`,
        "on this run — and runs ECC's native `.kiro/install.sh` to copy its curated Kiro",
        "agents, skills, steering, hooks, scripts, and settings into this repo's `.kiro/`",
        "(idempotent). Requires git on PATH plus Git for Windows (Git Bash) installed; aih",
        "resolves bash.exe from the standard install path. Point at an existing checkout",
        "instead with `--ecc-path <dir>`.",
      ),
    ),
  ];
}

/** A short, human-readable stack summary for the advisor + summary docs. */
function stackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function summaryDoc(clis: string[], inputs: EccInstallInputs, stack: RepoStack): Action {
  const { packs, installEverything } = eccLanguages(stack);
  const scope = installEverything
    ? "no stack detected yet (empty/new repo)"
    : packs.length > 0
      ? `stack packs: ${packs.join(", ")}`
      : "baseline stack (no language pack matched)";
  return doc(
    "ECC install summary (affaan-m/ECC — latest, via ECC's own installer)",
    lines(
      `Target CLIs: ${clis.join(", ")}.  Profile: ${inputs.profile}.  Detected ${scope}.`,
      "",
      "aih runs ECC's OWN installer at the LATEST version — it assembles nothing itself:",
      `  • npm targets → npx ecc-install --target <cli> --profile ${inputs.profile}  (no clone)`,
      "  • Kiro → cached git checkout of ECC (clone/pull to latest) + native .kiro/install.sh",
      "",
      "Re-run after the stack changes to re-scope. For finer component control (specific",
      `skills/agents/capabilities) ask the advisor:  npx ecc consult "${inputs.stackSummary}" --target <cli>`,
    ),
  );
}

/**
 * Install affaan-m/ECC — the agent-harness optimization system — for the user's
 * selected CLIs (`--cli claude,codex` / `--all-tools`, default `claude`), at the
 * LATEST published version, scoped by `--profile`.
 *
 * aih never assembles ECC content: it runs ECC's own installer. npm-target CLIs
 * use `npx ecc-install --target <cli>` (latest from npm, no checkout needed);
 * Kiro (not on npm) uses a cached git checkout + ECC's native `.kiro/install.sh`;
 * CLIs ECC has no direct installer for are routed through the `consult` advisor.
 * Every network/install step is an `exec` that runs only under `--apply`.
 */
async function eccPlan(ctx: PlanContext): Promise<Plan> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const profile = String(ctx.options.profile ?? "core");
  const installVersion = (ctx.env.AIH_ECC_INSTALL_VERSION ?? "").trim() || undefined;
  const eccRef = (ctx.env.AIH_ECC_REF ?? "").trim() || undefined;
  const inputs: EccInstallInputs = {
    profile,
    stackSummary: stackSummary(stack),
    platform: ctx.host.platform,
    installVersion,
  };

  const actions: Action[] = [];
  for (const cli of clis) {
    if (cli === "kiro") actions.push(...kiroEccActions(ctx));
    else if (cli === "codex") {
      const blockers = codexMcpCollisionActions(ctx);
      if (blockers.length > 0) actions.push(...blockers);
      else actions.push(...eccActionsForCli(cli, inputs));
    } else actions.push(...eccActionsForCli(cli, inputs));
  }
  // Surface the supply-chain advisory whenever an upstream surface runs unpinned:
  // the npm installer (no install-version) or the Kiro git checkout (no ref).
  const hasKiro = clis.includes("kiro");
  const npmUnpinned = clis.some((c) => c !== "kiro") && installVersion === undefined;
  if (npmUnpinned || (hasKiro && eccRef === undefined)) {
    actions.push(eccSupplyChainDoc());
  }
  actions.push(eccToolsDoc());
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }
  actions.push(summaryDoc(clis, inputs, stack));
  return plan("ecc", ...actions);
}

export const command: CommandSpec = {
  name: "ecc",
  summary:
    "Install affaan-m/ECC (latest) for the selected CLIs via ECC's own installer — npx ecc-install, or a cached git checkout for Kiro",
  options: [
    {
      flags: "--profile <profile>",
      description: "ECC install profile: minimal|core|full",
      default: "core",
    },
    {
      flags: "--ecc-path <dir>",
      description: "use an existing local ECC checkout for --cli kiro (instead of clone/pull)",
    },
  ],
  plan: eccPlan,
};
