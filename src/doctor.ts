import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyCanon, isAdoptable } from "./adopt/classify.js";
import { enterpriseBaselineAttestationCheck } from "./baseline/attestation.js";
import {
  bindingContaminationCheck,
  bindingContextCostCheck,
  bindingFrameworkDriftCheck,
  bindingHookChainChecks,
  bindingHostTupleCheck,
  bindingMcpInventoryCheck,
  bindingSettingsDriftCheck,
  eccDoubleInstallCheck,
  eccModeExclusivityCheck,
} from "./binding/frameworks/binding-doctor.js";
import { readAihConfigDiagnostic } from "./config/marker.js";
import { contractTruthCheck } from "./contract/check.js";
import { readExplicitEccMcpReceiptStates } from "./ecc/mcp-explicit-add.js";
import { classifyTool, versionArgv } from "./heal/common.js";
import { detectInstall, homeDir } from "./internals/cli-detect.js";
import { REGISTRY_IDS } from "./internals/cli-registry.js";
import type { Cli } from "./internals/clis.js";
import { readIfExists } from "./internals/fsxn.js";
import { gitRead } from "./internals/git.js";
import {
  type Action,
  type CommandSpec,
  type PlanContext,
  plan,
  probe,
  probeMany,
  structuredChecksProbe,
} from "./internals/plan.js";
import { canonLintCheck } from "./lint/run.js";
import { mcpManagedAllowlistCheck } from "./mcp/allowlist.js";
import { mcpUvxPinAttestationProbe } from "./mcp/attest.js";
import { mcpPinCurrencyProbe } from "./mcp/currency.js";
import { orgPolicyIntegrityProbes, verifiedOrgPolicyDriftProbes } from "./org-policy/drift.js";
import { orgPolicyEffectiveCheck } from "./org-policy/evaluate.js";
import { resolveTargetSet } from "./report/cli-coverage.js";
import { loadabilityForWithDryRun, loadReason } from "./report/cli-loadability.js";
import { scaleSafetyCheck } from "./scale-safety.js";
import { trustLockLocalDriftChecks } from "./trust/commands.js";
import { metricsToolCheck, usageRecorderCheck } from "./usage/hook-health.js";
import { vdiCompatibilityCheck } from "./vdi/index.js";
import { checkWorkspaceChildPath } from "./workspace/detect.js";
import { workspaceGitignoreMissing, workspaceGitignoreRequiredRepos } from "./workspace/git.js";
import { readWorkspaceManifest } from "./workspace/manifest.js";

function safeProbeLabel(value: string): string {
  const safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-/ ";
  const label = [...value]
    .map((char) => (safe.includes(char) ? char : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return label.length > 0 ? label : "<unsafe>";
}

function safeProbeList(values: readonly string[]): string {
  return values.map(safeProbeLabel).join(", ");
}

function explicitEccMcpReceiptChecks(ctx: PlanContext) {
  return readExplicitEccMcpReceiptStates({
    root: ctx.root,
    home: homeDir(ctx),
  }).map((result) => {
    const identity =
      result.target !== undefined && result.id !== undefined
        ? `${safeProbeLabel(result.target)}/${safeProbeLabel(result.id)}`
        : "receipt";
    const noReceipt = result.state === "absent" && result.target === undefined;
    return {
      name: `explicit-ecc-mcp:${identity}`,
      verdict: result.state === "clean" ? "pass" : noReceipt ? "skip" : "fail",
      detail: `${result.state}: ${safeProbeLabel(result.detail)} — local receipt/config state only; endpoint reachability and tool surface were not checked`,
    } as const;
  });
}

/**
 * Fail-closed preflight. Returns probe actions; the read-only command path forces
 * `verify`, so probes run and the verification report drives the exit code. A
 * `skip` (tool/artifact absent) never fails the run — only a hard `fail` does. In a
 * multi-repo workspace root (a `.aih-workspace.json` marker), it also validates
 * that each child repo has been scaffolded.
 */
export const command: CommandSpec = {
  name: "doctor",
  summary: "Verify the harness / workstation / repo configuration (fail-closed)",
  readOnly: true,
  honorReadOnlyPostureFlag: true,
  options: [
    {
      flags: "--sarif <file>",
      description: "write the health report as SARIF 2.1.0 for GitHub code-scanning (`-` → stdout)",
    },
    {
      flags: "--attest-mcp-pins",
      description:
        "launch each exactly-pinned uvx MCP server once (MCP initialize handshake) and compare its self-reported serverInfo.version to the pin — executes the pinned artifact, so it is opt-in",
    },
    {
      flags: "--check-pin-currency",
      description:
        "compare each exactly-pinned npx/uvx MCP package launch against its registry's latest release (npm/PyPI metadata only; nothing is downloaded or executed) — network egress, so it is opt-in",
    },
  ],
  plan: async (ctx) => {
    // The committed bootstrap marker is the source of truth for which context dir
    // to verify: a repo scaffolded with a custom `--context-dir` must be checked
    // against THAT dir, not the `ai-coding` default doctor would otherwise re-derive
    // (the silent-wrong-path gap). `cfg?.contextDir ?? ctx.contextDir` keeps the
    // marker authoritative while falling back to the resolved setting when absent.
    const marker = readAihConfigDiagnostic(ctx.root);
    const cfg = marker.present && !marker.invalid ? marker.config : undefined;
    const contextDir = cfg?.contextDir ?? ctx.contextDir;
    // Tool-specific probes must be scoped to the tools this repo actually targets.
    // `aih doctor` runs standalone, so nothing injects `ctx.targets` the way `aih init`
    // does — leaving `isTargeted` open and failing e.g. a Kiro-only repo for a Claude
    // projection whose repair writes nothing there (issue #554).
    //
    // Narrowing a governance probe SUPPRESSES findings, so it takes the strongest
    // evidence this repo has: the COMMITTED marker, and only when every id in it is
    // recognized. Deliberately not `resolveTargetSet` — its weaker fallbacks (a `--cli`
    // flag, `--detect`, or inferring targets from `<contextDir>/adapters/*.md` on disk)
    // are fine for grading a report, but they would let a deleted adapter file or a
    // command-line flag silence an org-policy finding. No marker, an invalid marker, an
    // empty list, or an unrecognized id all narrow NOTHING and keep the strict default;
    // the config-marker probe reports the marker itself.
    const declared = cfg?.targets ?? [];
    const scopedCtx: PlanContext =
      declared.length > 0 && declared.every((t) => REGISTRY_IDS.includes(t))
        ? { ...ctx, targets: declared as Cli[] }
        : ctx;
    const base: Action[] = [
      probe("node runtime >= 20", () => {
        const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        return major >= 20
          ? { name: "node-version", verdict: "pass", detail: `node ${process.versions.node}` }
          : {
              name: "node-version",
              verdict: "fail",
              detail: `node ${process.versions.node} < 20 — install Node 20+ (nvm/winget/brew) and re-run`,
              code: "env.node-runtime",
            };
      }),
      probe("git available", async () => {
        const res = await ctx.run(["git", "--version"]);
        return res.spawnError
          ? {
              name: "git",
              verdict: "skip",
              detail: "git not found on PATH — install git (winget/apt/brew) and re-run",
              code: "env.git-missing",
            }
          : { name: "git", verdict: "pass", detail: res.stdout.trim() };
      }),
      probe("platform adapter", () => ({
        name: "platform",
        verdict: ctx.host.verified ? "pass" : "skip",
        detail: ctx.host.verified
          ? `${ctx.host.platform} (verified)`
          : `${ctx.host.platform} (unverified path) — proceeding on the generic path; file an issue if a step misbehaves`,
      })),
      probe("canonical context dir", () => {
        const dir = join(ctx.root, contextDir);
        return existsSync(dir)
          ? { name: "context-dir", verdict: "pass", detail: `${contextDir} present` }
          : {
              name: "context-dir",
              verdict: "skip",
              detail: `${contextDir} not scaffolded — run: aih scaffold --apply`,
              code: "canon.context-dir-missing",
            };
      }),
      probe("bootstrap config marker", () => {
        if (marker.invalid) {
          return {
            name: "config-marker",
            verdict: "skip",
            detail:
              "invalid .aih-config.json — context dir derived from flags/env/default; fix or regenerate the marker",
            code: "config.marker-invalid",
          };
        }
        if (!cfg) {
          return {
            name: "config-marker",
            verdict: "skip",
            detail: "no .aih-config.json — context dir derived from flags/env/default",
          };
        }
        // A flag/env override different from the committed marker means doctor is
        // about to verify the wrong dir — surface the conflict instead of silently
        // checking it (never a hard fail; the operator may be overriding on purpose).
        return cfg.contextDir === ctx.contextDir
          ? {
              name: "config-marker",
              verdict: "pass",
              detail: `context-dir \`${cfg.contextDir}\`, targets: ${cfg.targets.join(", ") || "none"}`,
            }
          : {
              name: "config-marker",
              verdict: "skip",
              detail: `checking \`${ctx.contextDir}\` but this repo was bootstrapped with \`${cfg.contextDir}\` — omit --context-dir to use the committed value`,
            };
      }),
      probe("canon markdown lint", () => canonLintCheck(ctx.root, contextDir)),
      // Brownfield advisory: a repo with EXISTING AI canon that isn't yet on aih's
      // managed model (and has no committed marker) should be `aih adopt`-ed, not
      // bulldozed by `bootstrap-ai --apply`. Skip (never a hard fail) — it routes
      // via `canon.adoptable` like every other finding.
      probe("adoptable canon", () => {
        const cls = classifyCanon(ctx.root, contextDir);
        if (isAdoptable(cls.kind) && !cls.configPresent) {
          return {
            name: "adoptable-canon",
            verdict: "skip",
            detail: `existing AI canon detected (${cls.kind}) — run \`aih adopt\` to converge it onto the managed model`,
            code: "canon.adoptable",
          };
        }
        return {
          name: "adoptable-canon",
          verdict: "pass",
          detail:
            cls.kind === "already-adopted"
              ? "canon on the managed model"
              : "no foreign canon to adopt",
        };
      }),
      probe("AI CLIs detected", async () => {
        const installs = await detectInstall(ctx);
        const detected = installs.filter((i) => i.binary);
        const configOnly = installs.filter((i) => i.config && !i.binary).map((i) => i.cli);
        // "binary resolves on PATH" is not "CLI usable": a binary that hard-fails
        // even its own `--version` exec fails EVERY invocation (broken or too-old
        // install), so it must not count as runnable (issue #502). The cheap
        // sanity exec reuses heal's version-probe grammar; anything but a clean
        // exit-0 keeps the CLI OUT of the runnable set and SURFACES it as broken
        // — a relabel, never a dropped detection.
        const isWindows = ctx.host.platform === "windows";
        const states = await Promise.all(
          detected.map(async (install) => {
            const res = await ctx.run(
              versionArgv(ctx.host.platform, install.binaryDetail ?? install.cli),
              { timeoutMs: 10_000 },
            );
            return { cli: install.cli, usable: classifyTool(res, isWindows) === "ok" };
          }),
        );
        const runnable = states.filter((s) => s.usable).map((s) => s.cli);
        const broken = states.filter((s) => !s.usable).map((s) => s.cli);
        const configNote =
          configOnly.length > 0
            ? `; config-only traces (not runnable): ${configOnly.join(", ")}`
            : "";
        const brokenNote =
          broken.length > 0
            ? `; broken (binary on PATH but its --version exec fails — reinstall/update): ${broken.join(", ")}`
            : "";
        if (runnable.length > 0) {
          return {
            name: "ai-clis",
            verdict: "pass",
            detail: `runnable: ${runnable.join(", ")}${brokenNote}${configNote}`,
          };
        }
        if (broken.length > 0) {
          return {
            name: "ai-clis",
            verdict: "fail",
            code: "cli.binary-broken",
            detail: `no usable AI CLI: every detected binary fails its --version exec ("binary launches" is not "CLI usable"): ${broken.join(", ")} — reinstall or update${configNote}`,
          };
        }
        return {
          name: "ai-clis",
          verdict: "skip",
          detail:
            configOnly.length > 0
              ? `no runnable CLIs; config-only traces are not enough to target setup: ${configOnly.join(", ")}`
              : "none runnable — target explicitly with --cli or --all-tools",
          code: "cli.not-detected",
        };
      }),
      // Present file != loaded: fail closed when a targeted CLI's bootloader is on
      // disk but won't auto-load. Tier-2 dry-run probes prove runtime load only
      // for CLIs with a registered non-interactive context dump; other tools stay
      // manual/unverified rather than being counted as loaded.
      probe("CLI context loadability", async () => {
        const probeCtx: PlanContext = { ...ctx, contextDir };
        const results = await Promise.all(
          resolveTargetSet(probeCtx).targeted.map((cli) => loadabilityForWithDryRun(probeCtx, cli)),
        );
        const broken = results.filter((r) => r.verdict === "wontLoad");
        if (broken.length > 0) {
          return {
            name: "cli-loadability",
            verdict: "fail",
            code: "cli.wont-load",
            // Surface each broken tool's exact remediation command, not a generic one.
            detail: broken
              .map((b) => `${b.cli}: ${loadReason(b)} → ${b.fix ?? "aih bootstrap-ai --apply"}`)
              .join("; "),
          };
        }
        const loads = results.filter((r) => r.verdict === "loads").map((r) => r.cli);
        const runtimeUnverified = results.filter(
          (r) => r.verdict === "unverified" && r.checks.some((c) => c.name === "dry-run-probe"),
        );
        if (runtimeUnverified.length > 0) {
          const proven = loads.length > 0 ? `runtime-proven: ${loads.join(", ")}; ` : "";
          return {
            name: "cli-loadability",
            verdict: "skip",
            detail: `${proven}manual checks: ${runtimeUnverified
              .map((r) => `${r.cli}: ${loadReason(r)}`)
              .join("; ")}`,
          };
        }
        return loads.length > 0
          ? { name: "cli-loadability", verdict: "pass", detail: `loads: ${loads.join(", ")}` }
          : {
              name: "cli-loadability",
              verdict: "skip",
              detail: "no targeted bootloaders on disk to verify",
            };
      }),
      probe("dev tools (rg/fd/jq)", async () => {
        const tools = ["rg", "fd", "jq"];
        const found: string[] = [];
        for (const t of tools) {
          const argv = ctx.host.platform === "windows" ? ["where", t] : ["which", t];
          const res = await ctx.run(argv);
          if (!res.spawnError && res.code === 0 && res.stdout.trim().length > 0) found.push(t);
        }
        const missing = tools.filter((t) => !found.includes(t));
        return missing.length === 0
          ? { name: "dev-tools", verdict: "pass", detail: "rg, fd, jq present" }
          : {
              name: "dev-tools",
              verdict: "skip",
              detail: `missing: ${missing.join(", ")} — install (winget/scoop/brew) or, on a locked-down VDI, add your local bundle to PATH`,
              code: "env.dev-tool-missing",
            };
      }),
      probe("ECC double-install", () => eccDoubleInstallCheck(ctx)),
      probe("ECC mode exclusivity", () => eccModeExclusivityCheck(ctx)),
      // W7 §B — binding doctor probes. Read-only, deterministic,
      // posture-graded where noted; each self-skips when no binding is present.
      probe("binding contamination", () => bindingContaminationCheck(ctx)),
      probe("binding context cost", () => bindingContextCostCheck(ctx)),
      probe("binding host tuple", () => bindingHostTupleCheck(ctx)),
      probe("binding framework drift", () => bindingFrameworkDriftCheck(ctx)),
      probeMany("binding hook chain", (probeCtx) => bindingHookChainChecks(probeCtx)),
      probe("binding settings drift", () => bindingSettingsDriftCheck(ctx)),
      probe("binding mcp inventory", () => bindingMcpInventoryCheck(ctx)),
      probe("large-repo graph safety", () => scaleSafetyCheck(ctx)),
      probe("VDI compatibility matrix", () => vdiCompatibilityCheck(ctx)),
      probe("MCP managed allowlist", () => mcpManagedAllowlistCheck(scopedCtx)),
      // Resolved-artifact attestation for uvx pins (issue #502): the allowlist
      // proves config SHAPE; this row proves (or honestly refuses to claim) what
      // the pinned artifact self-reports at runtime. Live launch is opt-in.
      probe("MCP uvx pin attestation", (probeCtx) => mcpUvxPinAttestationProbe(probeCtx)),
      // Pin currency for the wired MCP tool pins (issue #504): re-projection lag
      // vs THIS build's catalog is reported offline; the registry latest-release
      // comparison is opt-in (network) via --check-pin-currency.
      probe("MCP pin currency", (probeCtx) => mcpPinCurrencyProbe(probeCtx)),
      probeMany("explicit ECC MCP receipt state", (probeCtx) =>
        explicitEccMcpReceiptChecks(probeCtx),
      ),
      structuredChecksProbe("trust-lock local drift", (probeCtx) =>
        trustLockLocalDriftChecks(probeCtx),
      ),
      ...orgPolicyIntegrityProbes({ ...ctx, contextDir }),
      // Target-scoped like its allowlist/drift siblings above and below: this probe
      // resolves activation targets against the invocation's selected CLIs, and doctor
      // has no `--cli` flag to supply them. Unscoped, `ctx.targets` is undefined and
      // collapses to `["claude"]`, so a repo whose marker declares e.g. Kiro reports a
      // permanent `target-not-selected:kiro` on a correctly projected repo — in the same
      // run whose baseline attestation reads those Kiro servers off disk and passes.
      probe("org policy effective resolution", () => orgPolicyEffectiveCheck(scopedCtx)),
      ...(await verifiedOrgPolicyDriftProbes({ ...scopedCtx, contextDir })),
      probe("enterprise baseline attestation", () =>
        enterpriseBaselineAttestationCheck({ ...ctx, contextDir }),
      ),
      probe("contract truth", () => contractTruthCheck(ctx)),
      // Usage-capture hook health: a committed hook that references an absent recorder
      // errors on every event (the `.aih/` gitignore trap); the Kiro metrics hook
      // degrades when `aih` isn't on PATH. Both self-skip when their hooks aren't present.
      probe("usage recorder present", () => usageRecorderCheck(ctx)),
      probe("metrics hook tool on PATH", () => metricsToolCheck(ctx)),
    ];

    // Workspace mode: validate each child repo is scaffolded.
    const workspace = readWorkspaceManifest(ctx.root, contextDir);
    const repos = workspace?.repos ?? [];
    const repoPaths = repos.map((repo) => repo.path);
    const gitProbes: Action[] = workspace?.git
      ? [
          probe("workspace root git", async () => {
            const inside = (await gitRead(ctx, ["rev-parse", "--is-inside-work-tree"])) === "true";
            return inside
              ? {
                  name: "workspace-git",
                  verdict: "pass",
                  detail: "workspace marker has git:true and root is a git worktree",
                }
              : {
                  name: "workspace-git",
                  verdict: "fail",
                  detail:
                    "workspace marker has git:true but root is not a git repo — run `aih workspace --apply --git`",
                };
          }),
          probe("workspace child repos gitignored", () => {
            const requiredRepos = workspaceGitignoreRequiredRepos(ctx.root, repoPaths);
            const missing = workspaceGitignoreMissing(
              requiredRepos,
              readIfExists(join(ctx.root, ".gitignore")),
            );
            return missing.length === 0
              ? {
                  name: "workspace-child-gitignore",
                  verdict: "pass",
                  detail:
                    requiredRepos.length > 0
                      ? `gitignored: ${safeProbeList(requiredRepos)}`
                      : "no child repos in marker",
                }
              : {
                  name: "workspace-child-gitignore",
                  verdict: "skip",
                  detail: `missing .gitignore entries: ${safeProbeList(missing)}`,
                };
          }),
        ]
      : [];
    const wsProbes: Action[] = repos.map((repo) =>
      probe(`workspace child ${repo.id} scaffolded`, () => {
        const present = existsSync(join(ctx.root, repo.path, repo.router));
        return present
          ? {
              name: `child:${repo.id}`,
              verdict: "pass",
              detail: `${repo.path}/${repo.router} canon present`,
            }
          : {
              name: `child:${repo.id}`,
              verdict: "skip",
              detail: "not scaffolded — run `aih init --apply` inside the child repo",
              code: "canon.context-dir-missing",
            };
      }),
    );
    const childGraphProbes: Action[] = repos.map((repo) =>
      probe(`workspace child ${repo.id} graph safety`, () => {
        let checked: ReturnType<typeof checkWorkspaceChildPath>;
        try {
          checked = checkWorkspaceChildPath(ctx.root, repo.path);
        } catch (err) {
          return {
            name: `child:${repo.id}:graph`,
            verdict: "fail",
            detail: `${repo.path}: ${(err as Error).message}`,
          };
        }
        if (!checked.exists) {
          return {
            name: `child:${repo.id}:graph`,
            verdict: "skip",
            detail: `${repo.path} absent — run \`aih workspace hydrate --apply\` or create the child repo`,
          };
        }
        return scaleSafetyCheck(ctx, {
          detailPrefix: repo.path,
          mcpRoot: ctx.root,
          name: `child:${repo.id}:graph`,
          requireGraph: true,
          repoRoot: join(ctx.root, checked.path),
        });
      }),
    );

    return plan("doctor", ...base, ...gitProbes, ...wsProbes, ...childGraphProbes);
  },
};
