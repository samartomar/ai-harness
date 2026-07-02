# ai-harness Skill Trust Gate

> Status: shipped. The lifecycle designed here landed across v0.4.0, v0.4.1, v0.5.0, and the
> v0.6.0 slices now on main:
> `aih skill vet|card|approve|inventory|remove|quarantine` (`src/skill/`), the trust scan and
> shape detectors (`src/trust/`, `src/skill/shape.ts`), posture-gated install enforcement in
> `aih workspace add` (`src/workspace/acquire.ts`), pack curation (`src/pack/`), and
> marketplace build/validate/publish (`src/marketplace/`). The GREEN/YELLOW/RED/UNKNOWN
> verdict engine shipped as specified (`src/skill/verdict.ts`).
>
> As-built divergences from the design below:
>
> - The approval lockfile is the committed repo-root `aih-skills.lock.json`, not
>   `.aih/approved-skills.lock`.
> - Skill cards are committed at `<contextDir>/skill-cards/<name>.json`, not
>   `.aih/skill-cards/`.
> - There is no standalone `aih skill install`; installs ride `aih workspace add` and
>   `aih pack install`, both approval-gated.
>
> The body below is the original design record.

## Purpose

The skill trust gate is intended to control installation of skills, agents, plugins, MCP configs, and workflow packs.

This is not an attack platform. It is a governance and approval layer.

## One-line positioning

```text
ai-harness does not claim a skill is safe forever.
It approves or blocks installation under a specific policy, at a specific pinned commit, using recorded evidence.
```

## Commands

```bash
aih skill vet <repo-or-path>
aih skill vet https://github.com/hardikpandya/stop-slop --policy enterprise
aih skill vet https://github.com/Egonex-AI/Understand-Anything --policy enterprise
aih skill vet https://github.com/remotion-dev/skills --policy media-restricted

aih skill card <repo-or-path>
aih skill approve <repo-or-path> --policy enterprise --pin <sha>
aih skill install <repo-or-path> --pin <sha> --apply
aih skill inventory
aih skill quarantine <skill-name>
aih skill remove <skill-name> --apply
```

## Verdict states

Use four states only.

```text
GREEN
  Install allowed under this policy.

YELLOW
  Manual approval required.

RED
  Blocked.

UNKNOWN
  Scanner failed, source missing, evidence insufficient, or policy cannot decide.
```

## Important wording

Correct:

```text
GREEN: approved to install under AIH enterprise policy at commit abc123.
```

Wrong:

```text
This skill is safe.
This repo is safe.
This skill cannot attack you.
```

## Gate pipeline

```text
1. Fetch source into temp sandbox.
2. Resolve and pin immutable commit SHA.
3. Detect skill/plugin/agent/MCP shape.
4. Check license and attribution.
5. Inspect install scripts.
6. Run skill scanner.
7. Run secret scanner.
8. Run dependency scanner when package manifests exist.
9. Scan MCP config when present.
10. Scan hooks, shell commands, and permissions.
11. Run sandbox smoke test if applicable.
12. Generate skill card.
13. Write scan evidence.
14. Produce verdict: GREEN / YELLOW / RED / UNKNOWN.
15. Install only under `--apply` and only if policy allows.
```

## Recommended scanners

Use a pluggable scanner interface. Do not hardcode only one vendor/tool.

```text
SkillSpector
  pre-install skill scanning, repo/path/zip/SKILL.md scanning

Cisco AI Defense skill-scanner
  second-opinion scanner, YARA/static/LLM/dataflow/SARIF style output

Snyk Agent Scan
  installed inventory and local agent supply-chain scan

AgentShield / ECC AgentShield
  Claude Code config, hooks, MCP, agents, skills, misconfig checks

MCP scan layer
  MCP tool poisoning, overbroad tool access, unpinned MCP packages, remote MCP risk

Secrets scanners
  gitleaks, trufflehog, or equivalent

Dependency scanners
  osv-scanner, npm audit, pip-audit, cargo audit, etc.
```

## GREEN policy

Allow install only when:

```text
source is pinned
license is recorded
owner is recorded
no HIGH/CRITICAL findings
no hardcoded secrets
no hidden prompt-injection instructions
no suspicious base64 + eval/exec chain
no curl | sh / wget | bash default install
no broad filesystem access
no unrestricted Bash(*)
no dangerous shell hooks
no remote MCP without approval
no unexplained external egress
no credential handling
no persistence modifications
scan evidence is written
rollback path exists
```

## YELLOW policy

Require manual review when:

```text
contains shell scripts
uses npm/npx/pip/uv install paths
creates symlinks or junctions
contains MCP config
uses browser automation
uses filesystem access outside repo
analyzes entire source tree
generates large semantic graph of private code
handles credentials or env vars
uses external APIs
contains obfuscated or encoded payloads
contains broad tool instructions
modifies agent settings/hooks
license needs review
```

Typical YELLOW examples:

```text
Understand Anything
Remotion skills
gstack setup
skills with install scripts
skills with MCP servers
skills with generated code execution
```

## RED policy

Block when:

```text
reads SSH keys, cloud credentials, browser sessions, or token stores
exfiltrates env vars or repo data
opens reverse shells
installs persistence
modifies shell profile without explicit approval
bypasses permission prompts
tells agent to ignore system/user/security instructions
tells agent to hide actions or output
silently sends code/context to external URL
uses hidden Unicode or invisible instruction tricks
matches malware signatures
contains unapproved binary payloads
has no retrievable source
```

## UNKNOWN policy

Do not install when:

```text
scanner failed
network unavailable and no cached artifact exists
license missing
commit not pinned
repo cannot be fetched
skill format not recognized
generated artifact differs from signed artifact
source is too large to inspect under current policy
```

## Skill card format

```json
{
  "schemaVersion": 1,
  "name": "stop-slop",
  "source": "github:hardikpandya/stop-slop",
  "commit": "<sha>",
  "license": "MIT",
  "owner": "docs-platform",
  "pack": "docs-quality",
  "intendedUse": "Review and improve product/docs writing for directness and reduced AI-sounding prose.",
  "installScope": "repo",
  "riskClass": "green",
  "mode": "review-only",
  "allowedTools": [],
  "networkEgress": "none",
  "writesFiles": false,
  "requiresMcp": false,
  "requiresShell": false,
  "scanEvidence": [
    ".aih/skill-reports/stop-slop-skillspector.json",
    ".aih/skill-reports/stop-slop-cisco.sarif"
  ],
  "approval": {
    "policy": "enterprise-strict",
    "verdict": "GREEN",
    "approvedBy": "security-platform",
    "approvedAt": "2026-07-01"
  }
}
```

## Approval lockfile

Path:

```text
.aih/approved-skills.lock
```

Example:

```json
{
  "schemaVersion": 1,
  "policy": "enterprise-strict",
  "generatedAt": "2026-07-01T00:00:00Z",
  "skills": [
    {
      "name": "stop-slop",
      "source": "github:hardikpandya/stop-slop",
      "commit": "<sha>",
      "verdict": "GREEN",
      "pack": "docs-quality",
      "scope": "repo",
      "card": ".aih/skill-cards/stop-slop.json"
    },
    {
      "name": "understand-anything",
      "source": "github:Egonex-AI/Understand-Anything",
      "commit": "<sha>",
      "verdict": "YELLOW",
      "pack": "workspace-intel",
      "scope": "approved-repos-only",
      "card": ".aih/skill-cards/understand-anything.json"
    }
  ]
}
```

## Example terminal output

```text
AIH Skill Vet

Source: github:Egonex-AI/Understand-Anything
Commit: 1234abcd
Policy: enterprise-strict

Shape:
  Skill directory: yes
  Install scripts: yes
  MCP config: no
  Package manifests: yes
  Full-codebase analysis: yes

Checks:
  Pin source: PASS
  License: PASS, MIT
  Secrets: PASS
  SkillSpector: PASS with warnings
  Cisco skill-scanner: PASS with warnings
  Dependency scan: WARN
  Install script review: WARN
  Egress review: WARN

Verdict: YELLOW
Action: Manual approval required
Reason: full-codebase analysis + install scripts + package dependencies
Evidence: .aih/skill-reports/understand-anything-1234abcd.json
```

## Enterprise install rule

```text
No skill installs without a lockfile entry.
No lockfile entry without scan evidence.
No scan evidence without a pinned source.
No pinned source without source/license/owner.
```

## Report integration

`aih report` is intended to show:

```text
Installed skill inventory
Approved skills
Unapproved installed skills
Stale pins
Scanner age
License status
YELLOW manual approvals
RED blocked attempts
UNKNOWN sources
Skill usage by repo/CLI when available
```

## Quarantine behavior

For unapproved or later-blocked skills:

```text
move skill directory to .aih/quarantine/<skill-name>-<timestamp>/
remove or disable loader references
record report entry
print rollback path
require --apply
```

## Final statement

```text
The skill trust gate is intended to help turn community skills from unreviewed code/instructions into reviewed, pinned, policy-bound capabilities.
```
