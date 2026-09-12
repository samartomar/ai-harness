---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-09-12
truth_home: true
purpose: Developer guide for consuming admin-authored AI-Harness enterprise configuration.
---

# Enterprise Developer Guide to AI-Harness

Use this guide when a developer is joining an organization that already has an AI-Harness admin policy, approved skills, and reviewed MCP choices. Platform owners should read [Enterprise Admin](enterprise-admin-guide.md). Individual non-governed setup belongs in [Vibe Developer](vibe-developer-guide.md).

This guide owns developer-side consumption: install and release verification, applying the admin config, local authentication, approved MCP templates, approved skill packs, and local usage/reporting. It should not author org policy, approve new external sources, sign scanner images, or publish bundles.

## 1. Executive Summary / Mental Model

The admin config controls policy, approvals, pins, and allowed surfaces. The developer still controls local authentication, selected AI clients, local usage capture, and whether optional MCP servers are connected for a specific repo.

Do not commit secrets. It is safe to commit placeholders such as `${GITHUB_PERSONAL_ACCESS_TOKEN}` inside reviewed MCP templates when the CLI or client expects an env reference. It is not safe to commit actual GitHub, Jira, Figma, AWS, or other tokens. Real values stay in the local shell, browser OAuth flow, or the organization's secret manager.

This guide follows the promoted stable train. Resolve the exact version from npm,
then apply the organization's approval before installation.

## 2. Quickstart / Implementation Blueprint

Verify a published release first:

```powershell
$CoreVersion = npm view @aihq/core dist-tags.latest
npm install -g "@aihq/core@$CoreVersion"
aih verify-release $CoreVersion
```

If a macOS or Linux global install reports `EACCES`, use the
[user-owned npm prefix recovery](../README.md#macoslinux-global-install-permission-errors);
do not install AI-Harness with `sudo`.

Full release verification requires local `npm`, `gh`, and `cosign`; proceed only when all three legs
pass. A skipped leg is incomplete evidence, not a successful rollout gate.

For an upgrade, resolve and approve the explicit promoted version; `npm update -g`
may stay within the current major. Re-run `aih verify-release $CoreVersion` after
installation. Use `--force` only
to replace a broken global install after reviewing the npm prefix and package source.

Ask the administrator for the absolute path to the protected PolicyBundle V2 on the
read-only admin/MDM distribution path. Use the administrator-managed launcher or
process environment that provides `AIH_ORG_POLICY` to AIH and the selected client.
The path must remain outside the governed project. A shell-only export does not
configure a later terminal, desktop shortcut, or background process.

In a fresh approved terminal, and again through the selected client's command
tool, check the received binding before applying project changes:

```powershell
if ([string]::IsNullOrWhiteSpace($env:AIH_ORG_POLICY) -or
    -not [System.IO.Path]::IsPathFullyQualified($env:AIH_ORG_POLICY)) {
    throw "The approved launcher must supply an absolute AIH_ORG_POLICY path."
}
aih policy validate . --no-log
aih policy verify . --against "<administrator-provided-sha256>" --no-log
aih policy evaluate . --no-log --json
```

`policy validate` checks the selected policy's schema; `policy verify` compares
the selected file with the administrator's expected digest. `policy evaluate`
reports effective requirements and blocked decisions. Inspect all three results;
a schema pass alone does not prove authority or that required controls are active.
Repeat these checks after restarting the client and in each new worktree.

For one invocation outside that launcher, pass the administrator's absolute path:

```powershell
$PolicyPath = "<absolute-admin-read-only-policy-bundle>"
aih policy validate . --policy $PolicyPath --no-log
aih policy verify . --against "<administrator-provided-sha256>" --policy $PolicyPath --no-log
```

`--policy` affects that invocation only. The recipes below assume the managed
environment has passed the fresh-process checks above. If using `--policy`
instead, include it on every AIH command; assigning `$PolicyPath` does not bind
later commands. AIH does not install a persistent environment or launcher for you.
Keep that configuration under the administrator's existing deployment controls.

What you need from the admin:

These inputs belong to each adopting organization. For local evaluation with
the default Vibe posture and packaged baseline evidence, follow
[Vibe Developer](vibe-developer-guide.md); that path does not require an
organization signing setup. A policy's Enterprise posture floor still applies
when that policy is selected.

| Input | Purpose | Secret handling |
|---|---|---|
| Protected PolicyBundle V2 path | Administrator/MDM distributes the exact read-only policy outside the governed target. | The path is safe to reference; never edit the bundle or place secrets in it. |
| Optional admin template repo | Carries reviewed templates and handoff material; it is not authority unless the administrator publishes the protected bundle from it. | No real tokens should be present. |
| Approved MCP templates | Shows allowed server keys such as `figma`, `atlassian`, or `aws-knowledge-mcp-server`. | Keep OAuth state and API tokens local. |
| Approved skill pack names | Tells developers which packs may be installed or synced. | Approval does not transfer to same-named skills from another source. |
| ECC/Superpowers organization evidence | Enterprise installation requires an exact `trust.baselineOverrides[]` entry and its GitHub-attested bundle, even when packaged publisher evidence passes. | Receive the reviewed bundle through the administrator's distribution route; do not invent approval metadata or signing identities. |

The baseline override's bundle path is relative to the governed project. Its
checksum and GitHub attestation are verified against the signing repository in
the protected policy; the protected PolicyBundle itself remains outside the
project. If installation reports `baseline.org-evidence-required`, request the
reviewed entry and matching bundle for the exact reported source pin. Follow
[the Enterprise org-evidence boundary](https://github.com/samartomar/ai-harness/blob/main/docs/security/baseline-evidence.md#enterprise-org-evidence-boundary)
before running the ECC or Superpowers recipes below.

Most writing commands refuse a dirty worktree unless `--force` is supplied. For normal repo onboarding, run a stage, review the diff, and commit or stash before the next writing stage. Use `--force` only when you intentionally accept the current dirty setup branch.

When the task is specifically to add, switch, or prune AI CLI surfaces, use [CLI Lifecycle](cli-lifecycle-guide.md). That guide covers the Kiro-to-Claude flow and the important rule that `prune` reads `.aih-config.json`; it does not retarget from `--cli`.

### Min Configuration

Use Min Configuration when you only need the governed repo canon, policy-aware MCP generation, and verification.

```powershell
aih init . --posture enterprise --mcp-mode offline --mcp-compliant
aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
aih mcp --posture enterprise --mode offline --mcp-compliant --apply
aih mcp --posture enterprise --mode offline --mcp-compliant --verify
aih doctor --posture enterprise
aih secrets --verify
```

Before relying on offline MCP startup, warm the pinned `uvx` package cache on the
workstation or base image:

```powershell
uvx code-review-graph@2.3.7 --version
uvx codebase-memory-mcp@0.10.5 --help
uvx --offline --no-python-downloads --no-env-file code-review-graph@2.3.7 --version
```

If `uvx` is not found, run `aih heal --scope path` and add the reported user-bin
directory through the approved shell/profile path.

### Balanced

Use Balanced when the repo needs ECC, BetterDoc, and one reviewed enterprise MCP example such as Figma in addition to the Min Configuration.

```powershell
aih ecc --cli claude,codex --profile core --posture enterprise --apply
aih pack plan --pack docs-quality
aih pack install --pack docs-quality --posture enterprise --apply
aih pack status --pack docs-quality
aih mcp --posture enterprise --mcp-compliant --apply
aih doctor --posture enterprise
```

Apply the reviewed Figma MCP client config only if the admin policy approves `figma`. Authenticate through the client or browser flow; do not commit exported OAuth state.

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    }
  }
}
```

After adding the client config, authenticate through the client flow, then rerun:

```powershell
aih mcp --posture enterprise --mcp-compliant --verify
aih doctor --posture enterprise
```

### Powerhouse Mode

Use Powerhouse Mode when policy has approved the optional feature set for this repo: ECC, BetterDoc, Superpowers, local usage/reporting, truth sidecar, selected external skills, Figma, Atlassian/Jira, and selected AWS MCP.

```powershell
aih init . --v3 --posture enterprise --mcp-mode standard --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
aih ecc --cli claude,codex --profile full --posture enterprise --apply
aih superpowers --cli claude,codex --posture enterprise --apply
aih pack install --pack docs-quality --posture enterprise --apply
aih pack install --pack enterprise-skills --posture enterprise --apply
aih pack install --pack powerhouse-skills --posture enterprise --apply
aih usage --cli claude,codex,cursor,zed --posture enterprise --apply
aih track --posture enterprise --apply
aih report --v9 --posture enterprise --apply --out .aih/reports/local-v9.html
aih init . --sidecar --posture enterprise --apply
aih truth verify --posture enterprise
aih truth pack --posture enterprise --apply
aih doctor --posture enterprise
```

If `aih init . --sidecar` fails because the repo has no real `HEAD`, make an initial repo commit first. The sidecar binds to a commit and should not be created against an uncommitted placeholder.

## 3. Local Auth And MCP Setup

The policy decides what is allowed. The developer still completes the local auth flow for the selected client.

| Service | What developer sets locally | What must not be committed |
|---|---|---|
| GitHub MCP token mode | `$env:GITHUB_PERSONAL_ACCESS_TOKEN = "<token-from-vault>"` only when policy/client requires token auth. OAuth is preferred where supported. | Token value, `.env*`, shell history exports with real value, logs containing token. |
| Figma MCP | Figma OAuth, plus the file or selection URL in the prompt when needed. Desktop server only if approved. | Figma OAuth tokens or exported session state. |
| Jira / Atlassian MCP | OAuth 2.1 through Atlassian Rovo MCP. API token only if the Atlassian admin enables that path. | `JIRA_API_TOKEN`, Atlassian API token values, or config with literal Authorization headers. |
| AWS MCP | AWS SSO/profile/role on the machine, for servers that need AWS access. | AWS access keys, session tokens, or profile secrets. |

Reviewed MCP template for Powerhouse Mode:

```json
{
  "mcpServers": {
    "figma": {
      "type": "http",
      "url": "https://mcp.figma.com/mcp"
    },
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp/authv2"
    },
    "aws-knowledge-mcp-server": {
      "type": "http",
      "url": "https://knowledge-mcp.global.api.aws"
    }
  }
}
```

Client-specific commands when the client supports them:

```powershell
codex mcp add figma --url https://mcp.figma.com/mcp
codex mcp add atlassian --url https://mcp.atlassian.com/v1/mcp/authv2
```

Claude Code examples from vendor docs:

```powershell
claude mcp add --transport http figma https://mcp.figma.com/mcp
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp/authv2
```

For clients that require an Atlassian local proxy, use the admin-reviewed `mcp-remote` template and authenticate in the browser. Do not commit `JIRA_API_TOKEN` unless the value is a literal placeholder such as `${JIRA_API_TOKEN}` and the real token is supplied only at runtime.

`codex mcp add` and `claude mcp add` are client-owned command surfaces. Recheck the client help or vendor docs when those commands change faster than AI-Harness.

## 4. Skill Use On Developer Machines

Admin approval creates committed cards, locks, and pack manifests. Developers install approved packs in the product repo, then sync approved promoted skills to machine roots only when they need the local client to discover them.

```powershell
aih pack status --pack docs-quality
aih pack install --pack docs-quality --posture enterprise --apply
aih pack status --pack enterprise-skills
aih pack install --pack enterprise-skills --posture enterprise --apply
aih skill inventory
aih skill sync --name aih-betterdoc --cli claude,codex --posture enterprise --apply
aih skill sync --name frontend-design --cli claude,codex --posture enterprise --apply
aih skill sync --name ui-ux-pro-max --cli claude,codex --posture enterprise --apply
```

Run `skill sync` only for approved promoted skills. A same-named skill from another source does not inherit approval.

## 5. Best Practices & Architecture

Keep `AIH_ORG_POLICY` in the administrator-managed launcher/process environment. A new
terminal, GUI-launched editor, or background agent must receive the same path explicitly;
otherwise use `--policy <absolute-path>` for that invocation.

Before setup, run the read-only policy checks above in the fresh terminal and
client-launched process. Without an explicit selection, AIH looks for the
repository-local default; its absence can be a skip. That is not evidence that
the organization's policy was loaded. An explicitly selected missing or unsafe
file fails, and `policy verify` fails when the expected digest differs. Have the
administrator correct the delivery path or distribution when these checks fail.

Use the approved client path. Some clients support direct HTTP MCP, some prefer plugins, and some need local proxy tools. The policy approval is server-name evidence; it is not a guarantee that every client can use the same JSON shape.

Keep usage local unless the organization separately defines a rollup. `aih usage`, `aih track`, and `aih report --v9` write local diagnostics under `.aih/`; they do not create cost or prompt telemetry by themselves.

## 6. Pitfalls to Avoid

- Do not commit real tokens, `.env*`, `secrets/**`, OAuth state, or shell exports with literal secret values.
- Do not assume admin approval authenticates you to Figma, Atlassian, GitHub, or AWS. You still need your own local account/session.
- Do not rename MCP server keys casually. Policy approves exact names such as `figma`, `atlassian`, or `aws-knowledge-mcp-server`.
- Do not install unapproved skills directly from GitHub because a similar skill is approved elsewhere.
- Do not treat report output, docs-lint, or sidecar verification as formal compliance evidence. They are local checks and evidence inputs.
