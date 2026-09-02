---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-09-02
truth_home: true
purpose: Entry point for AI-Harness guides by reader persona and workflow.
---

# Guides

Use this folder for human-facing guidance. These docs explain how different readers should use AI-Harness without mixing shipped behavior with unshipped plans.

These guides follow the promoted `@aihq/core` stable train. Resolve and approve an
exact version before installation; do not infer adoption urgency from a larger version
number. The frozen `@aihq/harness@6.1.0` package is npm-deprecated and
remains available only for existing consumers that have not migrated; new
installations use `@aihq/core`. Use [docs/commands.md](../docs/commands.md) and
`aih <command> --help` as syntax authorities.

![AI-Harness guide map showing reader paths for vibe developers, shared repositories, enterprise admins, enterprise developers, and shared command references](../docs/assets/aih-guide-map.svg)

## Read Order

| Reader need | Guide |
|---|---|
| Pick the right command for a task | [Command Use Cases](command-use-cases.md) |
| Add, switch, or prune AI CLI surfaces | [CLI Lifecycle](cli-lifecycle-guide.md) |
| Understand posture behavior and boundaries | [Postures](postures.md) |
| Individual developer or evaluator | [Vibe Developer](vibe-developer-guide.md) |
| Shared repository | [Shared Repository](shared-repository-guide.md) |
| Engineering team applying AI-Harness during application delivery | [Enterprise Application Adoption](enterprise-application-adoption.md) |
| Governed organization or enterprise rollout | [Enterprise Admin](enterprise-admin-guide.md) |
| Developer consuming an admin enterprise config | [Enterprise Developer](enterprise-developer-guide.md) |

## Maintenance Rules

- Keep shipped behavior grounded in the command reference, CLI help, release notes, npm/GitHub evidence, or current source.
- Keep `guides/` as workflow guidance, not a second command reference. A guide may show command order and reader-specific intent, but flag details and command behavior belong in `docs/commands.md` or `aih <command> --help`.
- Keep enterprise examples limited to the reviewed public guide set: Figma, Jira/Atlassian, and selected AWS MCP. Other service examples need a separate source review before they become public guide material.
- Preserve the admin/developer split. The admin guide owns policy, approvals, signing, Docker/SkillSpector, bundles, and evidence; the enterprise developer guide owns release verification, applying admin config, local auth, and approved MCP/skills consumption.
- Validate guide updates across prior shipped releases when the guide predates the current command surface; do not check only the newest release note.
- Use the BetterDoc rules from `packs/docs-quality/aih-betterdoc`: preserve commands and paths, build a claim ledger mentally before polishing, and scope maturity/security/release claims to evidence.
- Do not describe unshipped behavior as available. Label future-facing examples explicitly or omit them.
- Keep examples free of personal names, non-public repo paths, real tokens, customer identifiers, pricing details, and unapproved roadmap claims.
- Run repository-level documentation checks before calling the guide set current. Standalone guide-folder lint is not enough because public claims depend on the control matrix and source/test references.

## Publication Checklist

- Root README links to this guide index.
- `docs/commands.md` links to [Command Use Cases](command-use-cases.md) as the workflow companion.
- Third-party skill and MCP examples are labeled as dated review examples, not evergreen approvals.
- Enterprise examples avoid real tokens and floating copy-paste dependencies.
- Screenshots or diagrams say whether they use demo/local data or are illustrative.
