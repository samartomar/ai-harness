import { isTargeted } from "../internals/cli-detect.js";
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
import { secretProbes } from "./probes.js";
import { scanSecrets } from "./scan.js";
import { claudeIgnore, exposureWarning, settingsDenyPatch, vaultGuidance } from "./templates.js";

/**
 * Secrets redirection + plaintext-exposure prevention.
 *
 * Scans the repo for plaintext secret material, then emits:
 *  - a merged `permissions.deny` patch into `.claude/settings.json` (user keys
 *    and any existing deny entries survive — the executor unions arrays);
 *  - a `.claudeignore` backstop;
 *  - dynamic-vault-injection guidance (DOC ONLY — no vault is ever contacted);
 *  - a targeted warning when plaintext secrets already exist on disk;
 *  - one read-only `fail` probe per detected plaintext secret, so `--verify` is a
 *    secret-scan CI gate (non-zero exit when secrets exist) and `--sarif` emits an
 *    error-level result per path for GitHub code-scanning. Probes are read-only
 *    verdict carriers — no `exec`, no remote mutation — so the boundary holds.
 */
async function planSecrets(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
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
    // The warning doc is the human remediation; the per-path probes are the machine
    // gate — under `--verify` each `fail` flips the exit code (secret-scan CI gate)
    // and feeds one error-level SARIF result to GitHub code-scanning.
    actions.push(
      doc(
        `Plaintext secrets detected (${scan.matches.length}) — migrate to a vault`,
        exposureWarning(scan),
      ),
      ...secretProbes(scan),
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
