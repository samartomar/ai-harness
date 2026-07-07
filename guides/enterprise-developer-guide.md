---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Developer guide for consuming admin-authored AI-Harness enterprise configuration.
---

# Enterprise Developer Guide to AI-Harness

Use this guide when a developer is joining an organization that already has an AI-Harness admin policy, approved skills, and reviewed MCP choices. Platform owners should read [Enterprise Admin](enterprise-admin-guide.md). Individual non-governed setup belongs in [Vibe Developer](vibe-developer-guide.md).

## 1. Executive Summary / Mental Model

The admin config controls policy, approvals, pins, and allowed surfaces. The developer still controls local authentication, selected AI clients, local usage capture, and whether optional MCP servers are connected for a specific repo.

Do not commit secrets. It is safe to commit placeholders such as `${GITHUB_PERSONAL_ACCESS_TOKEN}` inside reviewed MCP templates when the CLI or client expects an env reference. It is not safe to commit actual GitHub, Jira, Figma, AWS, or other tokens.

Current public release baseline: `@aihq/harness@2.4.0`, published on 2026-07-07.

## 2. Quickstart / Implementation Blueprint

Verify the installed release first:

```powershell
npm install -g @aihq/harness
npm audit signatures
aih verify-release 2.4.0
```

Clone the admin configuration repo and point AI-Harness at the policy:

```powershell
$AdminConfigDir = Join-Path $HOME "aih-admin-configuration"
git clone <admin-config-repo-url> $AdminConfigDir
$env:AIH_ORG_POLICY = Join-Path $AdminConfigDir "aih-org-policy.json"
aih policy validate
```

What you need from the admin:

| Input | Purpose | Secret handling |
|---|---|---|
| Admin config repo or bundle | Carries policy, approved server names, pack manifests, and pins. | No real tokens should be present. |
| `aih-org-policy.json` path | Sets `AIH_ORG_POLICY` for local commands. | Safe to reference by path. |
| Approved MCP templates | Shows allowed server keys such as `figma`, `atlassian`, or `aws-knowledge-mcp-server`. | Keep OAuth state and API tokens local. |
| Approved skill pack names | Tells developers which packs may be installed or synced. | Approval does not transfer to same-named skills from another source. |

Most writing commands refuse a dirty worktree unless `--force` is supplied. For normal repo onboarding, run a stage, review the diff, and commit or stash before the next writing stage. Use `--force` only when you intentionally accept the current dirty setup branch.

When the task is specifically to add, switch, or prune AI CLI surfaces, use [CLI Lifecycle](cli-lifecycle-guide.md). That guide covers the Kiro-to-Claude flow and the important rule that `prune` reads `.aih-config.json`; it does not retarget from `--cli`.

### Min Configuration

Use Min Configuration when you only need the governed repo canon, policy-aware MCP generation, and verification.

```powershell
$AdminConfigDir = Join-Path $HOME "aih-admin-configuration"
$env:AIH_ORG_POLICY = Join-Path $AdminConfigDir "aih-org-policy.json"
aih policy validate
aih init . --posture enterprise --mcp-mode offline --mcp-compliant
aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
aih mcp --posture enterprise --mode offline --mcp-compliant --apply
aih mcp --posture enterprise --mode offline --mcp-compliant --verify
aih doctor --posture enterprise
aih secrets --verify
```

### Balanced

Use Balanced when the repo needs ECC, BetterDoc, and one reviewed enterprise MCP example such as Figma in addition to the Min Configuration.

```powershell
$AdminConfigDir = Join-Path $HOME "aih-admin-configuration"
$env:AIH_ORG_POLICY = Join-Path $AdminConfigDir "aih-org-policy.json"
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
$AdminConfigDir = Join-Path $HOME "aih-admin-configuration"
$env:AIH_ORG_POLICY = Join-Path $AdminConfigDir "aih-org-policy.json"
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
aih skill sync --name betterdoc --cli claude,codex --posture enterprise --apply
aih skill sync --name frontend-design --cli claude,codex --posture enterprise --apply
aih skill sync --name ui-ux-pro-max --cli claude,codex --posture enterprise --apply
```

Run `skill sync` only for approved promoted skills. A same-named skill from another source does not inherit approval.

## 5. Best Practices & Architecture

Keep `AIH_ORG_POLICY` stable for the shell where commands run. A new terminal, GUI-launched editor, or background agent may not inherit the variable.

Use policy validation before local setup. If `aih policy validate` fails, fix or update the admin policy before running install commands.

Use the approved client path. Some clients support direct HTTP MCP, some prefer plugins, and some need local proxy tools. The policy approval is server-name evidence; it is not a guarantee that every client can use the same JSON shape.

Keep usage local unless the organization separately defines a rollup. `aih usage`, `aih track`, and `aih report --v9` write local diagnostics under `.aih/`; they do not create cost or prompt telemetry by themselves.

## 6. Pitfalls to Avoid

- Do not commit real tokens, `.env*`, `secrets/**`, OAuth state, or shell exports with literal secret values.
- Do not assume admin approval authenticates you to Figma, Atlassian, GitHub, or AWS. You still need your own local account/session.
- Do not rename MCP server keys casually. Policy approves exact names such as `figma`, `atlassian`, or `aws-knowledge-mcp-server`.
- Do not install unapproved skills directly from GitHub because a similar skill is approved elsewhere.
- Do not treat report output, docs-lint, or sidecar verification as formal compliance evidence. They are local checks and evidence inputs.
