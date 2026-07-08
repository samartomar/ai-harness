---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Use-case map for AI-Harness commands across developer, team, and enterprise workflows.
---

# AI-Harness Command Use-Case Guide

Use this guide when the question is "which `aih` command applies to this situation?" The public `docs/commands.md` page and `aih <command> --help` remain the syntax authorities. This guide maps common workflows across the shipped command surface through `@aihq/harness@2.4.0`; it does not replace the command reference.

## Command Rule

Start read-only, then apply deliberately.

Most managed project commands preview by default and require `--apply` to write. Verification commands such as `doctor`, `ready`, `status`, `docs-lint`, `verify-release`, `verify-bundle`, `policy validate`, `pack status`, `pack validate`, `truth verify`, and `bootstrap-ai --verify` are the normal completion gates.

Use tables here to choose a path, not to restate every flag or output. When a row needs deeper behavior, link to [docs/commands.md](../docs/commands.md) instead of copying the reference text into this guide.

GitHub CLI (`gh`) is useful when it is installed and approved: it gives fast authenticated reads, PR/release helpers, and GitHub attestation commands. The portable baseline remains `git`, npm, browser URLs, and HTTP examples. Guides and runbooks should show that baseline first, then include a `gh` equivalent when it reduces friction.

## Portable GitHub Grounding And Pins

Git creates the commit SHA when a commit is made. A `<40-char-sha>` is a full 40-character Git commit hash, not a branch name, tag, or short SHA.

Use these commands without GitHub CLI:

```console
git rev-parse HEAD
git ls-remote https://github.com/OWNER/REPO.git HEAD
git ls-remote https://github.com/OWNER/REPO.git refs/heads/main
npm view <package> version dist-tags time --json
```

For GitHub web/API state, use a browser or an approved HTTP client:

```text
https://github.com/OWNER/REPO/issues?q=is%3Aissue%20is%3Aopen
https://github.com/OWNER/REPO/pulls?q=is%3Apr%20is%3Aopen
https://github.com/OWNER/REPO/milestones?state=open
https://api.github.com/repos/OWNER/REPO/releases/latest
```

PowerShell and POSIX HTTP examples:

```powershell
Invoke-RestMethod -Headers @{ "User-Agent" = "aih-docs" } "https://api.github.com/repos/OWNER/REPO/releases/latest"
```

```bash
curl -fsSL -H "User-Agent: aih-docs" "https://api.github.com/repos/OWNER/REPO/releases/latest"
```

Use a pinned SHA before approving or distributing external source:

```console
aih trust scan OWNER/REPO --pin <40-char-sha> --apply
```

Use `--ref <branch-or-tag>` only for exploration. Branches and tags can move; a full commit SHA is the reviewable pin.

| Task | Portable path | `gh` path when approved |
|---|---|---|
| Resolve a commit pin | `git ls-remote https://github.com/OWNER/REPO.git refs/heads/main` | `gh api repos/OWNER/REPO/commits/main --jq .sha` |
| Check latest release | GitHub release page or `https://api.github.com/repos/OWNER/REPO/releases/latest` | `gh release list --repo OWNER/REPO --limit 20` |
| Check open issues or PRs | GitHub issue/PR search URLs or REST API URLs | `gh issue list ...`, `gh pr list ...` |
| Sign or verify GitHub attestations | Approved signer path such as cosign when policy selects it | `gh attestation sign`, `gh attestation verify` |

## Enterprise Configuration Recipes

| Recipe | Primary command path | Use when |
|---|---|---|
| Min Configuration | `aih verify-release 2.4.0` -> `aih policy validate` -> `aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply` -> `aih bootstrap-ai --all-tools --apply` -> `aih mcp --posture enterprise --mode offline --mcp-compliant --apply` -> `aih doctor --posture enterprise` | A governed repo needs the minimum AI-Harness canon, policy, generated MCP controls, and verification. |
| Balanced | Min path -> `aih ecc --cli claude,codex --profile core --posture enterprise --apply` -> `aih pack install --pack docs-quality --posture enterprise --apply` -> `aih mcp approve figma --accept-egress ...` -> reviewed Figma MCP client config | The team needs ECC, BetterDoc, and one reviewed enterprise MCP example with policy approval. |
| Powerhouse Mode | Balanced path -> `aih superpowers --cli claude,codex --posture enterprise --apply` -> `aih usage --apply` -> `aih track --apply` -> `aih report --v9 --apply` -> `aih truth verify` -> selected `aih trust`/`aih skill` approvals -> reviewed Figma, Atlassian/Jira, and AWS MCP config | The organization has approved the optional local feature set and selected external surfaces. |

Developer-side enterprise consumption starts by setting the policy override:

```powershell
$AdminConfigDir = Join-Path $HOME "aih-admin-configuration"
$env:AIH_ORG_POLICY = Join-Path $AdminConfigDir "aih-org-policy.json"
aih policy validate
```

Admin-side configuration lives in the policy and approval files. Developer-side usage still requires local client auth, local env variables, and reviewed MCP config. Never commit literal `GITHUB_PERSONAL_ACCESS_TOKEN`, `JIRA_API_TOKEN`, AWS keys, Figma tokens, or OAuth state.

## CLI Lifecycle Recipes

Use [CLI Lifecycle](cli-lifecycle-guide.md) when changing the repo's AI CLI target set. The key distinction is target selection versus cleanup: `bootstrap-ai --cli <full-list> --apply` records committed intent in `.aih-config.json`; `prune` removes artifacts for CLIs no longer in that committed target set.

| Situation | Primary command path | When to use |
|---|---|---|
| Add Claude while keeping Kiro | `aih bootstrap-ai --cli kiro,claude --apply` -> `aih bootstrap-ai --verify` -> `aih mcp --cli claude --apply` -> optional `aih ecc --cli claude --profile core --apply` -> optional `aih skill sync --name <approved-skill> --cli claude --apply` | Claude is newly approved, but Kiro remains a supported repo surface. |
| Move from Kiro to Claude | `aih bootstrap-ai --cli claude --apply` -> `aih bootstrap-ai --verify` -> `aih prune` -> `aih prune --apply` -> `aih doctor` | Claude is now the only intended CLI and Kiro artifacts should be removed conservatively. |
| Enterprise developer adds Claude | `aih policy validate` -> `aih bootstrap-ai --cli claude --posture enterprise --apply` -> `aih mcp --cli claude --posture enterprise --mcp-compliant --apply` -> `aih doctor --posture enterprise` | The org policy already allows the Claude surface and enterprise posture is active. |
| Remove stale CLI artifacts without `.aih/legacy/` archive | `aih prune --delete`, then `aih prune --delete --apply` after review | The normal reversible archive is not acceptable for the repo. The command still uses a sibling backup path; review the preview before applying. |
| Prune a still-targeted CLI that is no longer installed | `aih prune --unrunnable`, then `aih prune --unrunnable --apply` after review | A CLI remains in committed intent but the team intentionally removed it from the machine. Do not use this for an unresolved PATH problem. |

Do not use `aih prune --cli claude --apply` as a retargeting command. `prune` ignores selection flags for intent and reads `.aih-config.json`.

## Workstation And Runtime

| Use case | Primary commands | When to use |
|---|---|---|
| Check whether a developer can start | `aih ready`, `aih doctor` | First run, onboarding, or a broken local setup. |
| Inspect configured state | `aih status` | Quick local inventory without mutation. |
| Install missing shell tools | `aih tools`, then `aih ready` | Shell helpers such as `rg`, `fd`, `jq`, `ast-grep`, `gh`, or graph tools are missing. In enterprise, review the dry-run against the approved tool catalog. |
| Fix corporate TLS/runtime problems | `aih heal`, `aih certs` | npm, pip, MCP, Go, git, JVM, Gradle, Maven, Docker, or HTTPS checks fail behind a TLS-intercepting proxy. |
| Tune local inference | `aih hardware` | A developer runs local models and needs CPU/RAM/GPU settings. |
| Handle VDI constraints | `aih vdi` | Citrix, WorkSpaces, RDP, or similar environments need local scratch/cache routing. |
| Run the whole workstation setup path | `aih bootstrap` | Platform/onboarding flow across certs, hardware, VDI, and telemetry assets. |
| Inspect risky session text | `aih session-guard --text <text>` | A prompt, transcript, or proposed action may contain secrets or dangerous local actions. |

## Repo Bootstrap And Canon

| Use case | Primary commands | When to use |
|---|---|---|
| Initialize a repo in one pass | `aih init .`, then `aih init . --apply` | New repo or repo adopting AI-Harness from scratch. |
| Use structured bootstrap intelligence | `aih init . --v3`, then `aih init . --v3 --apply` | The repo should emit capability intent and a derived fingerprint/cache while keeping committed files as authority. |
| Create an external truth sidecar | `aih init . --sidecar --apply`, then `aih truth verify` | A repo with a real git `HEAD` needs an external project-truth sidecar bound to the current commit. |
| Target specific AI tools | `aih bootstrap-ai --cli <list> --apply`, `aih bootstrap-ai --detect --apply`, or `aih bootstrap-ai --all-tools --apply` | The repo needs native bootloaders for the tools actually used. |
| Verify canon drift | `aih bootstrap-ai --verify` | CI, PR review, or after manual edits to bootloaders/rules. |
| Generate machine-readable repo contract | `aih contract --apply` | Agents and tooling need stack commands, conventions, and repo metadata. |
| Detect stack-specific profile | `aih profile --apply` | Cursor stack rules or repo stack detection need refreshing. |
| Resolve capability intent | `aih capability resolve --apply`, then `aih capability prune --apply` when cleaning stale cache | A repo needs committed `aih-capabilities.json` plus a rebuildable machine cache under `~/.aih/`. |
| Install Layer-1 ECC | `aih ecc --cli <list> --apply` | The selected CLIs should receive ECC through ECC's own installer path. |
| Install Superpowers | `aih superpowers --cli <list> --apply` | The selected CLIs should receive the Superpowers skill set through its own install path. |
| Run CRISPY context engineering | `aih crispy` | A deterministic, gate-ordered context-engineering stage machine is the target. |
| Add repo hygiene | `aih scaffold --apply`, `aih secrets --verify`, `aih guardrails --apply` | Secret deny rules, pre-commit, `.gitignore`, and license/secret gates are needed. |
| Configure MCP | `aih mcp --apply` | Supported tools need MCP config. Use `--mode offline` or `--mode none` for constrained environments. |
| Apply policy-filtered MCP | `aih mcp --posture enterprise --mcp-compliant --apply`, then `aih mcp --posture enterprise --mcp-compliant --verify` | Generated MCP entries should include only policy-approved servers and fail if denied generated entries remain. |
| Add sandbox defaults | `aih sandbox --apply` | Devcontainer or sandbox allowlist/fail-if-unavailable settings are needed. |
| Adopt an existing AI setup | `aih adopt` | A brownfield repo already has AI docs or tool-native files. Preview first. |
| Remove stale tool artifacts | `aih prune` | A repo stopped targeting a CLI and carries old generated files. |
| Remove AI-Harness footprint | `aih uninstall` or `aih clean` | Repo wants a reversible cleanup of marker-owned AI-Harness files. |

## Workspaces

| Use case | Primary commands | When to use |
|---|---|---|
| Create a parent workspace | `aih workspace <parent> --repos <a,b> --apply` | A multi-repo workspace needs parent-owned bridge files, a VS Code workspace, and graph MCP scope for declared child repos. |
| Register a child repo later | `aih workspace link <path> --apply` | A child repo or parent-owned contract edge should be added without writing child repo files. |
| Snapshot child state | `aih workspace snapshot --lock --apply` | The parent needs a lock of declared child branch/SHA/remotes for reconstruction. |
| Restore declared children | `aih workspace hydrate --apply` | Missing children should be cloned from recorded remotes or clean children checked out to recorded refs. |
| Onboard child repos explicitly | `aih workspace init --recursive --apply` | The parent scaffold should also run child `aih init` in declared child repos. Default workspace runs remain parent-only. |
| Refresh workspace reports | `aih workspace report --apply` or `aih workspace report --refresh-children --apply` | The parent report should roll up existing child state; `--refresh-children` is the explicit child-write opt-in. |
| Plan cross-repo work | `aih workspace plan "<task>"` | A multi-repo task needs a parent-level plan before editing children. |
| Acquire external skills | `aih workspace add <source> --pin <40-char-sha> --apply` | A third-party source should pass the trust gate before skills are promoted. |

## Skills, Packs, And Marketplace

| Use case | Primary commands | When to use |
|---|---|---|
| Evaluate a local source | `aih trust scan <local-path>` | Before an agent or team uses a checked-out third-party repo, MCP server source, or skill source. |
| Evaluate a GitHub source | `aih trust scan <owner/repo> --pin <40-char-sha> --apply` | Before approving a hosted source; get the pin with portable `git ls-remote`; use a `gh` equivalent only when approved. |
| Record trust decisions | `aih trust allow <source> --apply`, `aih trust pin <source> --pin <40-char-sha> --apply`, `aih trust verify` | A reviewed external source needs committed trust evidence. |
| Inspect trust policy and lock evidence | `aih trust list`, then `aih trust verify` | Admins need to see committed approved sources and local trust-lock evidence before changing approvals or publishing a bundle. |
| Review SkillSpector analyzer pin | `aih trust skillspector-pin` | Enterprise policy requires the SkillSpector detector, or an admin is reviewing a proposed analyzer image/revision bump. Use candidate flags only for an explicit pin review. |
| Vet a skill | `aih skill vet <source> --apply` | Before approving or installing an external skill. |
| Render a skill card without approving yet | `aih skill card <source> --pin <40-char-sha> --owner <team> --name <skill> --apply` | A reviewer wants the committed governance card drafted after vetting, but approval should remain a separate decision. |
| Approve a skill | `aih skill approve <source> --owner <owner> --pack <pack> --apply` | A vetted skill should become committed team-governed input. |
| See installed/approved state | `aih skill inventory` | Review duplicates, stale pins, unapproved installs, quarantined skills, or machine-synced skills. |
| Sync an approved skill to a CLI machine root | `aih skill sync --name <skill> --cli <list> --apply` | A promoted approved skill should be copied into supported machine discovery roots such as Claude or Codex. |
| Disable or remove a skill | `aih skill quarantine --name <skill> --apply` or `aih skill remove --name <skill> --apply` | A skill should be parked or retracted. |
| Seed the first-party docs pack | `aih pack scaffold --pack docs-quality --apply` | A repo wants bundled BetterDoc bytes copied into its own `packs/` tree before vet/approve/install. |
| Add an approved skill to a pack manifest | `aih pack add --pack <pack> --skill <skill> --apply` | The skill is already approved in `aih-skills.lock.json`, and the pack curation needs to reference it. The command derives the ref from the lockfile. |
| Remove a skill from a pack manifest without retracting approval | `aih pack remove-entry --pack <pack> --skill <skill> --apply` | Pack membership should change, but the underlying skill approval should remain available for other packs or direct review. |
| Preview a pack install | `aih pack plan --pack <name>` | A team wants to see what a curated pack would promote before writes or trust gates. |
| Check pack readiness | `aih pack status --pack <name>`, `aih pack validate --pack <name>` | Pack refs must match committed approvals and install state. Use `validate` as the CI gate. |
| Install a curated skill set | `aih pack install --pack <name> --apply` | A team wants a named pack instead of one-off skill installation. |
| Remove a pack's installed members | `aih pack uninstall --pack <name> --apply` | Installed pack members should be retracted while manifest curation remains. |
| Build a hostable skill artifact | `aih marketplace build --out <dir> --apply` | An approved skill set needs a reproducible distribution artifact. |
| Sign marketplace output | `aih marketplace publish --dir <dir> --signer cosign --apply` | A built artifact should carry signer-backed provenance before distribution. |
| Verify a marketplace artifact | `aih marketplace validate --dir <dir> --require-signature` | A consumer or CI needs checksum/signature validation. |

### External Skill Examples

| Source | Pin checked on 2026-07-07 | Example commands |
|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills) | `9d2f1ae187231d8199c64b5b762e1bdf2244733d` | `aih trust scan anthropics/skills --pin <pin> --posture enterprise --apply`, then `aih skill vet anthropics/skills --pin <pin> --posture enterprise --apply`, then approve selected names such as `frontend-design`, `webapp-testing`, `mcp-builder`, or `skill-creator` with `aih skill approve anthropics/skills --pin <pin> --name <skill> --owner platform-ai --pack enterprise-skills --posture enterprise --apply`. |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `12b486b22e67f5d887962ef8351c1ac863bfaeb9` | `aih trust scan nextlevelbuilder/ui-ux-pro-max-skill --pin <pin> --posture enterprise --apply`, `aih skill vet nextlevelbuilder/ui-ux-pro-max-skill --pin <pin> --posture enterprise --apply`, then `aih skill approve nextlevelbuilder/ui-ux-pro-max-skill --pin <pin> --name ui-ux-pro-max --owner design-platform --pack powerhouse-skills --mode design-assist --posture enterprise --apply`. |

`aih skill vet` evaluates the source and never installs it. `aih skill approve --name <skill>` records which skill in a multi-skill source is approved.

### Reviewed Third-Party MCP Examples

| Service | Approval command | Reviewed client config |
|---|---|---|
| Figma | `aih mcp approve figma --accept-egress --reason "<review reason>" --reviewer design-platform --posture enterprise --apply` | HTTP MCP at `https://mcp.figma.com/mcp`; desktop fallback is `http://127.0.0.1:3845/mcp` only when approved. |
| Jira / Atlassian | `aih mcp approve atlassian --accept-egress --reason "<review reason>" --reviewer delivery-platform --posture enterprise --apply` | Atlassian Rovo MCP at `https://mcp.atlassian.com/v1/mcp/authv2`; OAuth 2.1 preferred, API token only if admin enables it. |
| AWS generated core | Include `awslabs.core-mcp-server` in policy or approve it when surfaced. | Generated by `aih mcp` for AWS repos as `uvx awslabs.core-mcp-server@1.0.27`. |
| AWS Knowledge / awslabs selected servers | `aih mcp approve aws-knowledge-mcp-server ...`; approve `awslabs.aws-documentation-mcp-server` or `awslabs.aws-iac-mcp-server` only after source/package review. | AWS Knowledge HTTP endpoint is `https://knowledge-mcp.global.api.aws`; broader [awslabs/mcp](https://github.com/awslabs/mcp) source was pinned at `0e96fa1d3a6c5bbf84fcd89ab02ff70a34d061a5` for review on 2026-07-07. |

### MCP Mode And Auth Choices

| Need | Command | When to use |
|---|---|---|
| Local, project, or remote server scope | `aih mcp --scope <local|project|remote> --apply` | The selected client supports multiple MCP scopes and the repo policy names where config should live. |
| Token-backed GitHub hosted MCP | `aih mcp --github-auth token --apply` | OAuth is not available for the selected client and PAT-backed auth is approved. Commit only the env placeholder, never the token value. |
| Self-hostable server forms | `aih mcp --self-host --apply` | The organization wants local/self-hostable MCP forms instead of hosted endpoints. Review image/source pins, env placeholders, and egress before distributing. |

## Policy, Evidence, Truth, And Release Integrity

| Use case | Primary commands | When to use |
|---|---|---|
| Validate org policy | `aih policy validate` | A repo or distributed bundle has `aih-org-policy.json` or policy bundle input. |
| Check policy drift | `aih policy verify --against <sha-or-bundle>` | Enterprise or CI needs to verify active policy against a trusted channel. |
| Verify project truth | `aih truth verify` | A sidecar should fail closed on commit/version/claim/decision drift, acceptance blockers, or stale agent-evidence file claims. |
| Stage a truth pack | `aih truth pack --token-budget <n> --apply` | Agent-proposed truth changes should stage outside the repo before explicit promotion. |
| Build a fleet bundle | `aih bundle --out <dir> --apply` | Contract, policy, and managed config need a deterministic bundle. |
| Verify a bundle | `aih verify-bundle --bundle <dir> --require-signature` | A bundle crosses an environment or team boundary. |
| Build evidence | `aih evidence build --out <dir> --apply` | Governance artifacts, locks, cards, vet evidence, run logs, reports, and verified truth packs need packaging. |
| Build signed evidence | `aih evidence build --out <dir> --sign cosign --require-signature --apply` | Evidence crosses an enterprise boundary where missing signing must be a failure, not a skip. Use the signer selected by policy. |
| Verify a published release | `aih verify-release` or `aih verify-release <version>` | Install origin, npm signatures, GitHub Release checksum/cosign bundle, and npm-packed tarball hash need verification. |
| Lint public docs and claims | `aih docs-lint` | Public Markdown needs BetterDoc phrase guidance plus the hard claim-ledger gate from claim markers to control-matrix rows and named tests. |
| Write support-ticket files from findings | `aih doctor --support-out <dir>`, `aih heal --support-out <dir>`, or another supported verifying command with `--support-out <dir>` | A failed or skipped check needs a paste-ready, tool-neutral ticket for IT, security, or platform operations. |
| Emit SARIF for code scanning | `aih secrets --verify --sarif <file>`, `aih doctor --sarif <file>`, or `aih bootstrap-ai --verify --sarif <file>` | CI or GitHub code scanning should receive structured findings instead of terminal-only output. Use `--sarif -` only when stdout must be a clean SARIF stream. |

## Analytics, Usage, And Operations

| Use case | Primary commands | When to use |
|---|---|---|
| Build a local dashboard | `aih report --v9 --apply --out .aih/reports/local-v9.html` | Developer or team wants context footprint, adoption, local usage, cache/skill panels, and diagnostics. |
| Open the local dashboard directly | `aih report --v9 --open` | A developer wants the generated HTML dashboard opened in the browser after review. This implies HTML output and apply behavior. |
| Keep the dashboard live while working | `aih report --v9 --refresh <seconds>` | A local operator wants the report regenerated periodically during a focused setup/debug session. Stop it with Ctrl+C. |
| Show demo dashboard data | `aih report --demo` | A walkthrough needs representative dashboard panels without using a repo's local data. Do not treat demo data as evidence. |
| Render the older v4 dashboard skin | `aih report --v4 --apply` | A team needs to compare or preserve the older dashboard view while v9 remains the main developer-console path. |
| Enforce context budget | `aih report --gate --token-budget <n>` | CI or review needs to fail on excessive context footprint. |
| Render an org usage digest | `aih report --org <export.json> --format html --apply` | An admin has a saved Admin-API export and needs the org digest. Local `usage` logs are not a substitute for this export. |
| Track repo trend data | `aih track --apply` | History behind report trends should accumulate. |
| Capture local usage counts | `aih usage --apply` | Local no-cost usage/adoption analytics are desired; v2.1.0 added broader per-tool hooks and Zed import support. |
| Roll up usage across repos | `aih usage --rollup <repo-a,repo-b>` | A local operator wants a multi-repo view from gitignored usage logs. |
| Generate telemetry assets | `aih telemetry`, then `aih telemetry --apply` after review | Operators need collector/fetcher material; remote setup remains operator-run docs. |

## Persona Paths

| Persona | First path | Maintenance path |
|---|---|---|
| Vibe developer | `doctor` -> `init` -> `bootstrap-ai --detect` -> `secrets --verify` -> `pack scaffold --pack docs-quality` when needed -> `pack install --pack docs-quality` | `ready`, `status`, `report --v9`, `docs-lint`, `bootstrap-ai --verify` |
| Team | `init --posture team` -> `bootstrap-ai --all-tools` -> `guardrails` -> `capability resolve` -> `pack validate` | `doctor --posture team`, `secrets --verify`, `pack status`, `pack validate`, `docs-lint`, `report --team` |
| Enterprise | `aih verify-release` -> `aih init . --posture enterprise --mcp-mode offline --mcp-compliant` -> `aih policy validate` -> `aih doctor --posture enterprise` | `aih policy verify`, `aih truth verify`, `aih docs-lint`, `aih verify-bundle`, `aih marketplace validate --require-signature`, `aih evidence build --require-signature` |
| Enterprise developer | set `AIH_ORG_POLICY` -> `aih policy validate` -> Min, Balanced, or Powerhouse path from [Enterprise Developer](enterprise-developer-guide.md) | `aih doctor --posture enterprise`, `aih mcp --posture enterprise --mcp-compliant --verify`, `aih pack status`, `aih skill inventory`, `aih report --v9` |

## Common Misrouting

- Use `aih init` for a full repo bootstrap. Use `aih bootstrap-ai` when the AI canon/bootloaders are the only target.
- Use `aih init --sidecar` to create the sidecar pointer and commit binding. Use `aih truth verify` or `aih truth pack` after the sidecar exists.
- Use `aih scaffold` for repo hygiene. Use `aih contract` for machine-readable repo metadata.
- Use `aih capability resolve` for committed capability intent and rebuildable machine cache. Do not treat `~/.aih/` as authority.
- Use `aih skill` for per-skill approval. Use `aih pack` for curated sets of approved skills.
- Use `aih skill card` to draft governance card metadata without approving. Use `aih skill approve` when the source should become a lockfile-backed approval.
- Use `aih pack add` and `aih pack remove-entry` for pack manifest curation. Use `aih pack install` and `aih pack uninstall` when installed skill files and approvals should change.
- Use `aih pack scaffold --pack docs-quality` to copy bundled first-party BetterDoc bytes into another repo; it does not approve the skill.
- Use `aih trust skillspector-pin` to review analyzer pin metadata. Use Docker commands to build, push, and sign a scanner image.
- Use `aih marketplace build`, `aih marketplace publish`, and `aih marketplace validate` to package, sign, and validate approved skill bytes. Use `aih bundle` for fleet policy/config bundles.
- Use `aih evidence build` to package audit material. Use `aih verify-bundle` to verify an already-built bundle.
- Use `aih docs-lint` for public documentation claim gates. Use the BetterDoc skill rules for writing and reviewing prose.
- Use `--support-out <dir>` for ticket-ready support files and `--sarif <file>` for code-scanning output when the command supports those flags.
- Use `aih workspace link`, `snapshot`, `hydrate`, `init --recursive`, and `report --refresh-children` for federated workspace lifecycle. Default workspace writes remain parent-only unless a command explicitly opts into child writes.
- Use `aih report` for local diagnostics. Do not treat report output as formal compliance evidence.
- Use `git ls-remote`, npm, browser URLs, or approved HTTP clients for routine public-state checks. Add `gh` examples when they are useful, but keep a portable path beside them.
