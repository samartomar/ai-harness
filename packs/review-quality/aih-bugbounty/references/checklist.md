# BUGBOUNTY Generated-Agent PR Checklist

Use this reference when a PR adds generated ECC, Claude, Codex, MCP, skill,
agent, workflow, or auto-learning artifacts.

## Required Lanes

| Surface | Required checks |
| --- | --- |
| `.agents/**/SKILL.md`, `.codex/**/SKILL.md` | YAML frontmatter, no whole-file code fence, description triggers, no unsupported maturity or workflow claims. |
| `.claude/skills/**/SKILL.md` | No whole-file code fence, no conflicting repo canon, no ungrounded workflow claims. |
| `.codex/config.toml`, `.mcp.json` | Added servers, hosted URLs, egress class, credential mode, pinning, `@latest`, unversioned `npx`, and drift from canonical `.mcp.json`. |
| `.codex/agents/*.toml` | Sandbox must stay read-only for explorer/reviewer roles unless a write role is explicit and justified. |
| `.codex/AGENTS.md`, root bootloaders | Must route to `ai-coding/RULE_ROUTER.md`; generated local guidance must be subordinate. |
| `.claude/commands/*.md` | Workflow files must match real source/test/doc paths and must not narrow repo behavior to stale slices. |
| `.claude/homunculus/**` | Instinct confidence must be backed by enough evidence and must not conflict with current repo structure. |
| Manifest files | Managed-file list, package/module mapping, readiness score, and evidence gaps must match the diff. |

## Findings To Prefer

Prefer concrete findings over broad opinions:

- `skill.frontmatter-missing`: Codex-facing skill lacks required frontmatter.
- `skill.whole-file-fence`: generated skill is wrapped in a Markdown code fence.
- `mcp.added-server`: PR adds a server not present in canonical `.mcp.json`.
- `mcp.unpinned-package`: MCP server uses `@latest` or an unversioned `npx` package.
- `mcp.endpoint-drift`: PR changes an approved endpoint or command shape.
- `canon.router-missing`: generated agent guidance does not route through
  `ai-coding/RULE_ROUTER.md`.
- `claim.over-narrow-tests`: generated workflow describes only a subset of the
  real test layout.
- `claim.release-version-source`: generated release instructions point at the
  wrong version source.
- `instinct.weak-evidence-high-confidence`: high-confidence generated instinct
  is based on shallow or contradictory evidence.
- `coverage.reference-set-missing`: generated manifest reports missing reference
  sets or security evidence while still proposing acceptance.

## Validation

For each finding, cite the PR file and the current repo evidence that makes it a
problem. CI passing is useful context but does not clear generated-agent risk.
