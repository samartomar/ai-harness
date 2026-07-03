# Enterprise Onboarding

> Status: operational guide for adopting the shipped open-source CLI in a governed
> environment.

## Rollout Checklist

1. Install from npm or an internal mirror and verify the release:

   ```bash
   npm audit signatures
   aih verify-release
   ```

   Expected healthy output: npm signature verification passes, the GitHub Release
   checksum file is fetched, the cosign bundle over `SHA256SUMS.txt` verifies, and
   the installed tarball hash matches the checksum file. If `npm`, `gh`, or
   `cosign` is missing, the command reports an explicit skip for that leg rather
   than a pass; install the missing verifier before treating the release as fully
   verified.

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
   npm run dev -- policy verify --against <sha256-or-bundle> --root .
   ```

   Treat the trusted policy channel as either the committed `aih-org-policy.json`
   reviewed in the repo or a signed/distributed bundle whose hash you pin out of
   band. `AIH_ORG_POLICY` is an emergency override, not a silent replacement:
   `aih doctor` and `aih report` surface it as policy-source integrity signal.

5. Gate PRs with the repo checks:

   ```bash
   npm run verify
   npm run dev -- bootstrap-ai --verify
   npm run dev -- secrets --verify
   npm run dev -- evidence build --posture enterprise --sign gh --require-signature --apply
   npm run dev -- verify-bundle --bundle .aih/evidence-bundle --signer gh --repo <owner/repo> --require-signature
   ```

   Evidence bundle failure modes are intentionally loud in enterprise posture:
   missing `--sign`, missing verifier identity (`--repo` for GitHub attestations),
   missing local signing/verifier tools, or a failed verification produces a coded
   `bundle.signature` finding instead of a quiet skip. For cosign, use your key or
   OIDC identity material consistently at signing and verification time.

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

See [CONTROL_MATRIX.md](CONTROL_MATRIX.md) for the public claim-to-test matrix that
security and platform reviewers can use during adoption review.
