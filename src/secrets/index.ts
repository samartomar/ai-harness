import { postureFromContext } from "../config/posture.js";
import { homeDir, isTargeted } from "../internals/cli-detect.js";
import { entry } from "../internals/cli-registry.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  writeJson,
  writeText,
} from "../internals/plan.js";
import { acceptChanged, changedSince } from "../internals/scan-allowlist.js";
import { isExternalMcp, mcpConfigAbs } from "../mcp/render.js";
import { mcpConfigSecretProbes, secretProbes } from "./probes.js";
import {
  type ExternalMcpConfigFile,
  scanConfigSecrets,
  scanExternalConfigSecrets,
  scanSecrets,
} from "./scan.js";
import {
  claudeIgnore,
  configExposureWarning,
  exposureWarning,
  settingsDenyPatch,
  vaultGuidance,
} from "./templates.js";

function globalMcpConfigFiles(ctx: PlanContext): ExternalMcpConfigFile[] {
  const home = homeDir(ctx);
  const seen = new Set<string>();
  const files: ExternalMcpConfigFile[] = [];
  for (const cli of SUPPORTED_CLIS) {
    if (!isTargeted(ctx, cli)) continue;
    const mcp = entry(cli).mcp;
    if (mcp.support !== "native" || mcp.configPath === undefined) continue;
    if (!isExternalMcp(mcp.configPath)) continue;
    const absPath = mcpConfigAbs(home, mcp.configPath);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    files.push({ file: mcp.configPath, absPath });
  }
  return files;
}

/**
 * Secrets redirection + plaintext-exposure prevention.
 *
 * Scans the repo for plaintext secret material, then emits:
 *  - a merged `permissions.deny` patch into `.claude/settings.json` (user keys
 *    and any existing deny entries survive — the executor unions arrays);
 *  - a `.claudeignore` backstop;
 *  - dynamic-vault-injection guidance (DOC ONLY — no vault is ever contacted);
 *  - a targeted warning when plaintext secrets already exist on disk;
 *  - one read-only, posture-graded probe per detected plaintext secret, so `vibe`
 *    warns while `team`/`enterprise` make `--verify` a non-zero secret-scan gate
 *    and `--sarif` emits error-level results. Probes are read-only verdict carriers
 *    — no `exec`, no remote mutation — so the boundary holds.
 */
async function planSecrets(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const posture = postureFromContext(ctx);
  // `--since <ref>`: only scan secret files changed vs the ref (fast PR CI). NOT
  // gitignore-honoring — a gitignored `.env` is still a real exposure, so the full
  // on-disk scan is the default; `--since` only narrows by the diff.
  const since =
    typeof ctx.options.since === "string" ? await changedSince(ctx, ctx.options.since) : undefined;
  const scan = scanSecrets(ctx.root, { accept: acceptChanged(undefined, since) });

  const actions: Action[] = [];
  // `.claude/settings.json` deny rules + `.claudeignore` are Claude-specific (Kiro
  // et al. don't read them). Under `aih init` they land only when Claude is a
  // target; the secret SCAN, vault guidance, and `--verify` probes below are
  // tool-agnostic and always run — the real secret gate is gitleaks + pre-commit,
  // not these read-deny files.
  if (isTargeted(ctx, "claude")) {
    actions.push(
      writeJson(
        ".claude/settings.json",
        settingsDenyPatch(),
        "Deny agent reads of .env* and secrets/** (merged into existing settings)",
        { merge: true },
      ),
      writeText(
        ".claudeignore",
        claudeIgnore(),
        "Ignore plaintext secret files (.env*, secrets/) so agents never enumerate them",
      ),
    );
  }
  actions.push(
    doc(
      "Dynamic vault injection guidance (Vault / AWS Secrets Manager / 1Password)",
      vaultGuidance(ctx.contextDir),
    ),
  );

  if (scan.matches.length > 0) {
    // The warning doc is the human remediation; the per-path probes are posture
    // graded — advisory at `vibe`, a failing CI/SARIF gate at `team`/`enterprise`.
    actions.push(
      doc(
        `Plaintext secrets detected (${scan.matches.length}) — migrate to a vault`,
        exposureWarning(scan),
      ),
      ...secretProbes(scan, posture),
    );
  }

  // Content scan: a credential pasted INTO an MCP config (.mcp.json et al.) is a leak
  // the filename-based scan above cannot see. Unsafe config paths also fail closed.
  // Same gate shape — a warning doc for the default run, plus one `--verify` fail
  // probe per hit for the CI gate / SARIF.
  const configFindings = [
    ...scanConfigSecrets(ctx.root),
    ...scanExternalConfigSecrets(globalMcpConfigFiles(ctx)),
  ];
  if (configFindings.length > 0) {
    actions.push(
      doc(
        `MCP config secret-scan findings (${configFindings.length}) — fix literals or unsafe paths`,
        configExposureWarning(configFindings),
      ),
      ...mcpConfigSecretProbes(configFindings, posture),
    );
  }

  return plan("secrets", ...actions);
}

export const command: CommandSpec = {
  name: "secrets",
  summary: "Scan for plaintext secrets and write agent deny rules + vault guidance",
  options: [
    {
      flags: "--since <ref>",
      description: "only scan secret files changed vs <ref> (fast PR CI; full scan otherwise)",
    },
    {
      flags: "--sarif <file>",
      description:
        "write the --verify report as SARIF 2.1.0 for GitHub code-scanning (`-` → stdout)",
    },
  ],
  plan: planSecrets,
};
