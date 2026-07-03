# Enterprise Onboarding

> Status: operational guide for adopting the shipped open-source CLI in a governed
> environment.

## Rollout Checklist

1. Install from npm or an internal mirror and verify the release:

   ```bash
   npm audit signatures
   aih verify-release
   ```

2. Run workstation readiness and repair:

   ```bash
   aih doctor --json
   aih heal --scope all
   ```

3. Initialize a pilot repo in dry-run, then apply after review:

   ```bash
   aih init . --posture team
   aih init . --posture team --apply
   npm run dev -- contract --apply --force
   ```

4. Add org policy and validate it:

   ```bash
   npm run dev -- policy validate --root .
   ```

5. Gate PRs with the repo checks:

   ```bash
   npm run verify
   npm run dev -- bootstrap-ai --verify
   npm run dev -- secrets --verify
   ```

6. Before a PR is marked ready or merged, run and record the required review
   skills/agents: code review, security review, and the domain reviewer for the
   touched area.

## Team Policy Example

```json
{
  "schemaVersion": 1,
  "minimumPosture": "team",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "licenses": {
    "disposition": {
      "Apache-2.0": "auto-approve",
      "MIT": "auto-approve",
      "GPL-3.0": "fail"
    }
  },
  "mcp": {
    "allowedServers": [
      "code-review-graph",
      "context7",
      "github"
    ],
    "allowManagedOnly": true
  },
  "trust": {
    "requireSignedSource": false,
    "requiredDetectors": [
      "skillspector",
      "cisco"
    ],
    "requiredChecks": [
      "license",
      "pin",
      "no-exec"
    ],
    "internalScopes": [
      "@acme"
    ]
  }
}
```

## Enterprise Policy Example

```json
{
  "schemaVersion": 1,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "command": {
    "deny": {
      "add": [
        {
          "pattern": "curl * | sh",
          "reason": "Pipe-to-shell installers need separate review."
        }
      ],
      "remove": []
    },
    "ask": {
      "add": [
        {
          "pattern": "gh attestation *",
          "reason": "Attestation writes to a remote provenance store."
        }
      ],
      "remove": []
    }
  },
  "mcp": {
    "allowedServers": [
      "code-review-graph",
      "codebase-memory-mcp",
      "context7",
      "github",
      "sequential-thinking"
    ],
    "allowManagedOnly": true
  },
  "trust": {
    "requireSignedSource": true,
    "requiredDetectors": [
      "skillspector",
      "cisco",
      "mcp-scanner"
    ],
    "requiredChecks": [
      "license",
      "pin",
      "no-exec",
      "no-mcp",
      "skillspector"
    ],
    "internalScopes": [
      "@acme",
      "@acme-internal"
    ]
  }
}
```

`mcp-scanner` is intentionally opt-in until your team has verified the local static
scanner path on managed workstations. If you keep it in `requiredDetectors`, set
`AIH_ENABLE_MCP_SCANNER=1` in the verification environment and confirm the local
`uvx --offline` scanner can run. Otherwise omit `mcp-scanner` and treat its result
as an explicit degraded-coverage skip.

## PR Evidence

Record these in every PR before ready-for-review or merge:

- Review skills/agents run: code review, security review, and relevant domain reviewer.
- Critical/high findings and their remediation commits.
- Verification commands and output summaries.
- Any explicit skips, with the reason and remaining risk.

For release PRs, include `aih verify-release <version>` output after the release is
published. For schema changes, link the SchemaStore submission PR after the schema
has shipped.
