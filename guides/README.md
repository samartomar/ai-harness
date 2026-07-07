---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Entry point for AI-Harness guides by reader persona and workflow.
---

# Guides

Use this folder for human-facing guidance. These docs explain how different readers should use AI-Harness without mixing shipped behavior with unshipped plans.

Current guide baseline: public package `@aihq/harness@2.4.0`, released on 2026-07-07. Use [docs/commands.md](../docs/commands.md) and `aih <command> --help` as syntax authorities; these guides explain reader workflows.

![AI-Harness guide map showing reader paths for vibe developers, teams, enterprise admins, enterprise developers, and shared command references](../docs/assets/aih-guide-map.svg)

## Read Order

| Reader need | Guide |
|---|---|
| Pick the right command for a task | [Command Use Cases](command-use-cases.md) |
| Add, switch, or prune AI CLI surfaces | [CLI Lifecycle](cli-lifecycle-guide.md) |
| Understand posture behavior and boundaries | [Postures](postures.md) |
| Individual developer or evaluator | [Vibe Developer](vibe-developer-guide.md) |
| Shared repository or platform team | [Team](team-guide.md) |
| Governed organization or enterprise rollout | [Enterprise Admin](enterprise-admin-guide.md) |
| Developer consuming an admin enterprise config | [Enterprise Developer](enterprise-developer-guide.md) |

## Maintenance Rules

- Keep shipped behavior grounded in the command reference, CLI help, release notes, npm/GitHub evidence, or current source.
- Validate guide updates across prior shipped releases when the guide predates the current command surface; do not check only the newest release note.
- Use the BetterDoc rules from `packs/docs-quality/betterdoc`: preserve commands and paths, build a claim ledger mentally before polishing, and scope maturity/security/release claims to evidence.
- Do not describe unshipped behavior as available. Label future-facing examples explicitly or omit them.
- Keep examples free of personal names, non-public repo paths, real tokens, customer identifiers, pricing details, and unapproved roadmap claims.
- Run repository-level documentation checks before calling the guide set current. Standalone guide-folder lint is not enough because public claims depend on the control matrix and source/test references.

## Publication Checklist

- Root README links to this guide index.
- `docs/commands.md` links to [Command Use Cases](command-use-cases.md) as the workflow companion.
- Third-party skill and MCP examples are labeled as dated review examples, not evergreen approvals.
- Enterprise examples avoid real tokens and floating copy-paste dependencies.
- Screenshots or diagrams say whether they use demo/local data or are illustrative.
