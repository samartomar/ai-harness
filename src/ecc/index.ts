import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  writeText,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { execArgv } from "../tools/install.js";
import {
  CODEX_AGENTS_BLOCK_MARKER,
  codexHomeDir,
  codexInstallStateContents,
  codexInstallStatePath,
  codexMcpCollisionActions,
} from "./codex.js";
import {
  type EccInstallInputs,
  eccActionsForCli,
  eccSupplyChainDoc,
  eccToolsDoc,
  isAihDirectEccInstallTarget,
  normalizeEccInstallVersion,
} from "./install.js";
import { eccLanguages } from "./select.js";

const ECC_REPO_URL = "https://github.com/affaan-m/ECC.git";

export interface EccRepoCheckout {
  dir: string;
  posix: string;
  explicit: boolean;
  hasCache: boolean;
  ref?: string;
}

/** Cache dir for ECC's git checkout (Kiro isn't on npm, so it needs the repo). */
function eccCacheDir(ctx: PlanContext): string {
  const home = ctx.env.USERPROFILE || ctx.env.HOME || homedir();
  return join(home, ".claude", "ecc");
}

function eccRepoCheckout(ctx: PlanContext): EccRepoCheckout {
  const explicit = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  const dir = explicit || eccCacheDir(ctx);
  return {
    dir,
    posix: dir.replace(/\\/g, "/"),
    explicit: explicit.length > 0,
    hasCache: existsSync(join(dir, ".git")),
    ref: (ctx.env.AIH_ECC_REF ?? "").trim() || undefined,
  };
}

function eccRepoFetchActions(repo: EccRepoCheckout): Action[] {
  if (repo.explicit) return [];
  if (repo.ref) {
    return repo.hasCache
      ? [
          exec(
            `Fetch ECC ref ${repo.ref} — git -C ${repo.posix} fetch --depth 1 origin ${repo.ref} (under --apply)`,
            ["git", "-C", repo.dir, "fetch", "--depth", "1", "origin", repo.ref],
          ),
          exec(
            `Pin ECC to ${repo.ref} — git -C ${repo.posix} checkout --detach FETCH_HEAD (under --apply)`,
            ["git", "-C", repo.dir, "checkout", "--detach", "FETCH_HEAD"],
          ),
        ]
      : [
          exec(`Clone ECC pinned to ${repo.ref} (shallow) into ${repo.posix} (under --apply)`, [
            "git",
            "clone",
            "--depth",
            "1",
            "--branch",
            repo.ref,
            ECC_REPO_URL,
            repo.dir,
          ]),
        ];
  }
  return [
    repo.hasCache
      ? exec(
          `Update cached ECC to latest — git -C ${repo.posix} pull (under --apply)`,
          ["git", "-C", repo.dir, "pull", "--ff-only"],
          { allowFailure: true },
        )
      : exec(
          `Clone ECC (latest, shallow) into ${repo.posix} — git clone --depth 1 (under --apply)`,
          ["git", "clone", "--depth", "1", ECC_REPO_URL, repo.dir],
        ),
  ];
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
          "Bash, then re-run `aih ecc --cli kiro --apply`. Other ECC targets do not need",
          "Git Bash — only the Kiro installer does.",
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

export function kiroEccActions(ctx: PlanContext, repo: EccRepoCheckout): Action[] {
  const installActions = kiroInstallActions(ctx, repo.dir, repo.posix);
  if (repo.explicit) {
    return [
      ...installActions,
      doc(
        "ECC Kiro install (local checkout via --ecc-path)",
        lines(
          `Using the ECC checkout at \`${repo.posix}\`. \`.kiro/install.sh\` copies ECC's curated`,
          "Kiro agents/skills/steering/hooks/scripts/settings into this repo's `.kiro/`",
          "(idempotent). On Windows it runs via Git Bash.",
        ),
      ),
    ];
  }
  const checkoutStatus = repo.ref
    ? `pinned to \`${repo.ref}\` via shallow fetch/clone`
    : repo.hasCache
      ? "existing cached checkout; `git pull --ff-only` is attempted under `--apply` and any failure is reported by that exec action"
      : "cloned with `git clone --depth 1`";
  return [
    ...installActions,
    doc(
      "ECC Kiro install (cached git checkout)",
      lines(
        "Kiro content isn't on npm, so aih keeps a shallow git checkout of ECC at",
        `\`${repo.posix}\` — ${checkoutStatus}`,
        "on this run — and runs ECC's native `.kiro/install.sh` to copy its curated Kiro",
        "agents, skills, steering, hooks, scripts, and settings into this repo's `.kiro/`",
        "(idempotent). Requires git on PATH plus Git for Windows (Git Bash) installed; aih",
        "resolves bash.exe from the standard install path. Point at an existing checkout",
        "instead with `--ecc-path <dir>`.",
      ),
    ),
  ];
}

const CODEX_INSTALL_MERGE_SCRIPT = [
  'const child = require("child_process");',
  'const fs = require("fs");',
  'const path = require("path");',
  "const [repoRoot, profileId, homeDir, mergeCodexConfig, mergeMcpConfig, configPath, sourceAgents, targetAgents, statePath, stateB64] = process.argv.slice(1);",
  'if (!repoRoot || !profileId || !homeDir || !mergeCodexConfig || !mergeMcpConfig || !configPath || !sourceAgents || !targetAgents || !statePath || !stateB64) { console.error("usage: codex-install-merge <repo-root> <profile> <home-dir> <merge-config> <merge-mcp> <config> <source-agents> <target-agents> <state-path> <state-b64>"); process.exit(1); }',
  'const normalize = (value) => String(value || "").replace(/\\\\/g, "/");',
  "function isSharedCodexOperation(operation) {",
  "  const source = normalize(operation.sourceRelativePath);",
  '  return source === "AGENTS.md" || source === ".codex/AGENTS.md" || source === ".codex/config.toml";',
  "}",
  "function installCodexManagedFiles() {",
  '  const { createManifestInstallPlan } = require(path.join(repoRoot, "scripts", "lib", "install-executor.js"));',
  '  const { writeInstallState } = require(path.join(repoRoot, "scripts", "lib", "install-state.js"));',
  '  const plan = createManifestInstallPlan({ sourceRoot: repoRoot, target: "codex", profileId, homeDir });',
  "  const operations = plan.operations.filter((operation) => !isSharedCodexOperation(operation));",
  "  plan.operations = operations;",
  "  plan.statePreview.operations = operations;",
  "  for (const operation of operations) {",
  '    if (operation.kind !== "copy-file") { console.error("unsupported Codex managed operation: " + operation.kind); process.exit(1); }',
  "    fs.mkdirSync(path.dirname(operation.destinationPath), { recursive: true });",
  "    fs.copyFileSync(operation.sourcePath, operation.destinationPath);",
  "  }",
  "  writeInstallState(plan.installStatePath, plan.statePreview);",
  "}",
  "function normalizeCodexAgentsSource(text) {",
  '  const normalized = text.replace(/\\r\\n/g, "\\n");',
  '  let next = normalized.replace(/## Skills Discovery[\\s\\S]*?\\n\\nAvailable skills:/, "## Skills Discovery\\n\\nECC installs selected Codex skills under `~/.codex/skills/`. Invoke them on demand as `$<skill-name>`; for example `$tdd-workflow` reads `~/.codex/skills/tdd-workflow/SKILL.md`. They are not auto-loaded from `.agents/skills/`.\\n\\nAvailable skills:");',
  '  if (next === normalized) { throw new Error("ECC Codex AGENTS.md Skills Discovery section not recognized"); }',
  '  next = next.replace("| Skills | Skills loaded via plugin | `.agents/skills/` directory |", "| Skills | On-demand `$<skill-name>` invocation | `~/.codex/skills/<name>/SKILL.md` |");',
  "  return next;",
  "}",
  "for (const argv of [[process.execPath, mergeCodexConfig, configPath], [process.execPath, mergeMcpConfig, configPath]]) {",
  '  const result = child.spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });',
  "  if (result.error) { console.error(result.error.message); process.exit(1); }",
  "  if (result.status !== 0) process.exit(result.status || 1);",
  "}",
  'const source = normalizeCodexAgentsSource(fs.readFileSync(sourceAgents, "utf8")).replace(/\\s+$/, "");',
  `const marker = ${JSON.stringify(CODEX_AGENTS_BLOCK_MARKER)};`,
  'const begin = "<!-- BEGIN " + marker + " (generated from affaan-m/ECC .codex/AGENTS.md) -->";',
  'const end = "<!-- END " + marker + " -->";',
  'const rendered = begin + "\\n\\n" + source + "\\n\\n" + end;',
  'const existing = fs.existsSync(targetAgents) ? fs.readFileSync(targetAgents, "utf8") : "";',
  "const usesCrlf = /\\r\\n/.test(existing);",
  'const normalized = existing.replace(/\\r\\n/g, "\\n");',
  'const start = normalized.indexOf("<!-- BEGIN " + marker);',
  "const stop = start >= 0 ? normalized.indexOf(end, start) : -1;",
  "let next;",
  "if (start >= 0 && stop >= 0) {",
  "  next = normalized.slice(0, start) + rendered + normalized.slice(stop + end.length);",
  "} else {",
  '  const trimmed = normalized.replace(/\\n+$/, "");',
  '  next = trimmed.length > 0 ? trimmed + "\\n\\n" + rendered + "\\n" : rendered + "\\n";',
  "}",
  'if (!next.endsWith("\\n")) next += "\\n";',
  'if (usesCrlf) next = next.replace(/\\n/g, "\\r\\n");',
  "fs.mkdirSync(path.dirname(targetAgents), { recursive: true });",
  'fs.writeFileSync(targetAgents, next, "utf8");',
  "fs.mkdirSync(path.dirname(statePath), { recursive: true });",
  'fs.writeFileSync(statePath, Buffer.from(stateB64, "base64").toString("utf8"), "utf8");',
  "installCodexManagedFiles();",
].join("\n");

export function codexEccActions(
  ctx: PlanContext,
  repo: EccRepoCheckout,
  profile: string,
): Action[] {
  const codexDir = codexHomeDir(ctx);
  const codexConfig = join(codexDir, "config.toml");
  const codexAgents = join(codexDir, "AGENTS.md");
  const mergeCodexConfig = join(repo.dir, "scripts", "codex", "merge-codex-config.js");
  const mergeMcpConfig = join(repo.dir, "scripts", "codex", "merge-mcp-config.js");
  const sourceAgents = join(repo.dir, ".codex", "AGENTS.md");
  const statePath = codexInstallStatePath(ctx);
  const stateB64 = Buffer.from(codexInstallStateContents(ctx), "utf8").toString("base64");
  return [
    writeText(codexConfig, "", "seed Codex config.toml for ECC add-only merge", {
      external: true,
      once: true,
    }),
    exec(
      `Install ECC Node dependencies for Codex merge helpers — npm ci --omit=dev --ignore-scripts in ${repo.posix} (lockfile-based, under --apply)`,
      execArgv(ctx.host.platform, [
        "npm",
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]),
      { cwd: repo.dir, timeoutMs: 120000 },
    ),
    exec(
      `Install ECC for Codex — run safe merges and record prune state into ${statePath} (under --apply)`,
      [
        "node",
        "-e",
        CODEX_INSTALL_MERGE_SCRIPT,
        repo.dir,
        profile,
        dirname(codexDir),
        mergeCodexConfig,
        mergeMcpConfig,
        codexConfig,
        sourceAgents,
        codexAgents,
        statePath,
        stateB64,
      ],
      { cwd: repo.dir },
    ),
    doc(
      "ECC Codex install (safe merge path)",
      lines(
        "Codex uses ECC's git checkout instead of `ecc-install --target codex` because",
        "that upstream target copies shared `~/.codex/config.toml` and `AGENTS.md` files.",
        "aih runs ECC's add-only Codex TOML merge helpers, merges ECC's Codex AGENTS",
        "guidance into a fenced block, and installs the selected ECC Codex files while",
        "leaving shared config and AGENTS content co-owned.",
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
      `  • npm targets → npx --package ecc-universal ecc-install --target <cli> --profile ${inputs.profile}  (no clone)`,
      "  • Codex → cached git checkout of ECC + add-only config/MCP/AGENTS merge helpers",
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
 * use `npx --package ecc-universal ecc-install --target <cli>` (latest from npm,
 * no checkout needed); Codex uses ECC's add-only merge helpers from a cached git
 * checkout; Kiro uses the same checkout + ECC's native `.kiro/install.sh`;
 * CLIs ECC has no direct installer for are routed through the `consult` advisor.
 * Every network/install step is an `exec` that runs only under `--apply`.
 */
async function eccPlan(ctx: PlanContext): Promise<Plan> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const profile = String(ctx.options.profile ?? "core");
  const languageSelection = eccLanguages(stack);
  const installVersion = normalizeEccInstallVersion(ctx.env.AIH_ECC_INSTALL_VERSION);
  const eccRef = (ctx.env.AIH_ECC_REF ?? "").trim() || undefined;
  const inputs: EccInstallInputs = {
    profile,
    stackSummary: stackSummary(stack),
    platform: ctx.host.platform,
    installVersion,
    packs: languageSelection.packs,
  };

  const actions: Action[] = [];
  const hasKiro = clis.includes("kiro");
  const codexBlockers = clis.includes("codex") ? codexMcpCollisionActions(ctx) : [];
  const codexInstallPlanned = clis.includes("codex") && codexBlockers.length === 0;
  const needsEccRepo = hasKiro || codexInstallPlanned;
  const repo = needsEccRepo ? eccRepoCheckout(ctx) : undefined;
  if (repo) actions.push(...eccRepoFetchActions(repo));

  let npmInstallerPlanned = false;
  for (const cli of clis) {
    if (cli === "kiro") {
      if (repo) actions.push(...kiroEccActions(ctx, repo));
    } else if (cli === "codex") {
      if (codexBlockers.length > 0) actions.push(...codexBlockers);
      else if (repo) actions.push(...codexEccActions(ctx, repo, profile));
    } else {
      if (isAihDirectEccInstallTarget(cli)) npmInstallerPlanned = true;
      actions.push(...eccActionsForCli(cli, inputs));
    }
  }
  // Surface the supply-chain advisory whenever an upstream surface runs unpinned:
  // the npm installer (no install-version), the Codex/Kiro git checkout (no ref),
  // or the Codex merge-helper dependency install (npm ci still consumes upstream
  // registry bytes unless the operator mirrors the registry).
  const npmUnpinned = npmInstallerPlanned && installVersion === undefined;
  if (npmUnpinned || (hasKiro && eccRef === undefined) || codexInstallPlanned) {
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
    "Install affaan-m/ECC (latest) for the selected CLIs via ECC's own installer — npx --package ecc-universal ecc-install, or a cached git checkout for Codex/Kiro",
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
