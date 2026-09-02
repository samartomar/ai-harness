# Enterprise Onboarding

> Status: operational guide for adopting the shipped open-source CLI in a governed
> environment.

## Rollout Checklist

1. Install from npm or an internal mirror and verify the release:

   ```bash
CORE_VERSION="$(npm view @aihq/core dist-tags.latest)"
npm install -g "@aihq/core@$CORE_VERSION"
aih verify-release "$CORE_VERSION"
   ```

   If an unmanaged macOS or Linux evaluation host reports npm `EACCES`, use the
   [user-owned npm prefix recovery](../README.md#macoslinux-global-install-permission-errors);
   do not rerun the global install with `sudo`.

   `aih verify-release` is the provenance gate for a global install. Do not add a
   bare `npm audit signatures` step here: it cannot audit a global install (npm
   refuses with `EAUDITGLOBAL`), so the verifier instead installs the exact release
   into a temporary prefix and runs `npm audit signatures --prefix <temp>` there.
   Expected healthy output: the npm signature leg passes, the GitHub Release
   checksum file is fetched, the cosign bundle over `SHA256SUMS.txt` verifies, and
   the installed tarball hash matches the checksum file.
   Full release verification requires local `npm`, `gh`, and `cosign`; proceed only
   when all three legs pass. A missing verifier reports an explicit skip for that
   leg rather than a pass — a skipped leg is incomplete evidence, not a successful
   rollout gate.
   For an upgrade, resolve and install the approved explicit promoted version;
   `npm update -g` may stay within the
   existing major. If a broken global install blocks replacement, rerun the install
   with `--force` only after reviewing the global npm prefix and confirming the
   package source is approved.

2. Run workstation readiness and repair:

   ```bash
   aih doctor --json
   aih heal --scope all
   ```

   `aih heal` diagnoses npm and PATH problems and emits reviewed repair instructions
   for the operator; it does not silently edit shell profiles or reinstall npm. If
   `uvx` is missing after installing Python tooling, check common user script
   locations such as `$HOME/.local/bin`, `$HOME/Library/Python/<python-version>/bin`,
   `$(python3 -m site --user-base)/bin`, `%USERPROFILE%\.local\bin`, or
   `%APPDATA%\Python\Python3x\Scripts`, then add the actual directory to PATH through
   your approved shell/profile management path.

3. Initialize a pilot repo in dry-run, then apply after review:

   ```bash
   aih init . --posture enterprise
   aih init . --posture enterprise --apply
   npm run dev -- contract --apply
   ```

   Use `--force` only after reviewing the dirty setup branch or generated
   contract changes that the worktree gate reports.

4. Add org policy and validate it:

   ```bash
   npm run dev -- policy validate --root .
   npm run dev -- policy project --root . --apply
   npm run dev -- policy verify --against <sha256-or-bundle> --root .
   ```

   Treat the trusted policy channel as either the committed `aih-org-policy.json`
   reviewed in the repo or the Workbench-generated PolicyBundle V2 distributed at
   an administrator-controlled read-only path outside the governed target. An
   ordinary `AIH_ORG_POLICY` override is not a silent replacement: `aih doctor` and
   `aih report` surface it as a policy-source integrity signal, and mutation refuses
   it. `policy project --apply` additionally accepts the exact protected PolicyBundle
   V2 only after Core verifies its authority, custody, freshness, and file identity;
   the resulting transaction pins those bytes. ECC and Superpowers evidence, ECC request
   selection, ordinary ECC profile lifecycle acquisition and mutation, standalone MCP planning,
   and standalone Usage ownership checks reuse that same verified policy observation. ECC profile
   install/update composes projection and native registration in one pinned filesystem transaction;
   receipt-bound uninstall remains independently authorized by installed custody. Init retains each
   nested phase's assertion, deadline, and lock and refuses conflicting observations before effects.
   Child-process effects retain the renewable cooperative authority lease and revalidate before and
   after execution; a post-effect failure never claims that Core rolled the child back.
   It updates policy-generated settings
   without rerunning the canon bootstrap.
   It is a Claude projection, so use the default target (or explicitly include
   Claude) when applying it.
   Managed-only MCP policy also records AIH ownership provenance so later removal
   preserves operator-owned configuration.

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

   If the fleet needs ECC or Superpowers bytes newer than the vendor pin, vet the
   exact commit with `aih evidence vet-baseline`, sign the resulting evidence
   bundle with the governance repository's GitHub identity, and add an attributable
   `trust.baselineOverrides[]` entry. Org evidence can authorize new exact bytes;
   it cannot waive an exact vendor `blocked` verdict. Follow
   [Baseline Component Evidence](security/baseline-evidence.md) for the posture
   matrix, commands, and strict policy example.

6. Before a PR is marked ready or merged, run and record the required review
   skills/agents: code review, security review, and the domain reviewer for the
   touched area.

## Enterprise Policy Example

```json
{
  "schemaVersion": 2,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "governance": { "supportedClis": ["claude"] },
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
    "approvals": [],
    "allowManagedOnly": true,
    "incumbentHosts": [
      "api.githubcopilot.com"
    ]
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
  "schemaVersion": 2,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "governance": { "supportedClis": ["claude"] },
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
          "pattern": "gh attestation sign *",
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
    "approvals": [],
    "allowManagedOnly": true,
    "githubHost": "https://github.internal.example",
    "incumbentHosts": [
      "github.internal.example"
    ],
    "disabledServers": []
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

For vetted third-party MCP under Enterprise posture, `mcp.allowedServers` names
servers eligible for egress approval and managed allowlist projection, while
`mcp.approvals[]` records the accepted egress review evidence plus the current
server subject fingerprint written by `aih mcp approve`. It is not a blanket
block of zero-egress local servers; use `mcp.disabledServers` to remove a
server. When `mcp.allowManagedOnly` is true, `allowedServers` also narrows the
managed stdio command allowlist. Use
`aih mcp --posture enterprise --mcp-compliant --apply` to write only
policy-approved generated servers, omit denied generated entries from targeted
MCP client configs, and list the omitted servers in quarantined guidance. Run
`aih mcp approve <server> --accept-egress --reason "<why this egress is accepted>" --apply`
to write the local `aih-org-policy.json` entry; this is the safest path when the
repo-local policy is active. If `AIH_ORG_POLICY` points at a distributed policy,
update that source directly because org policy wins over local approval files and
local approval writes are refused.

> **Governed policies own these surfaces.** The `aih mcp` commands above apply to the
> CLI-allow-list governance shape used in this guide (`governance: { supportedClis: [...] }`).
> Once the policy carries a governed inventory — any `governance.policyVersion` — governance
> exclusively owns AIH MCP and usage-hook projection, and `aih mcp`, `aih mcp approve`, and
> `aih usage` all fail closed with `governance exclusively owns AIH <surface> projection`.
> Reach those surfaces through `aih policy evaluate` and `aih policy project --apply`
> instead, selecting every CLI named in the activation's `targets` (activations are
> all-or-nothing, so `--cli claude,kiro` for a two-target activation). See
> [commands.md](commands.md) under `aih policy`.
An empty list with `allowManagedOnly: true` is deny-all for every AIH MCP projection; a populated
list emits only listed, non-disabled servers. Setting it to `false` retains the enabled catalog,
and AIH preserves unrelated or customized operator entries while reconciling its generated output.

Hand-authored distributed-policy approvals must include `server`, `subject`,
`acceptEgress: true`, `reason`, and ISO-8601 `approvedAt`; `reviewer` is optional.
The `subject` must be the current server-shape fingerprint that `aih mcp approve`
would write for the same server. This JSON shape passes `aih policy validate`:

```json
{
  "schemaVersion": 2,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "governance": { "supportedClis": ["claude"] },
  "mcp": {
    "allowedServers": ["figma"],
    "approvals": [
      {
        "server": "figma",
        "subject": "mcp-server-sha256:0000000000000000000000000000000000000000000000000000000000000000",
        "acceptEgress": true,
        "reason": "Approved Figma remote MCP for reviewed design-context workflows.",
        "reviewer": "design-platform",
        "approvedAt": "2026-07-08T00:00:00.000Z"
      }
    ]
  }
}
```

`mcp-scanner` runs by default when an incoming source contains an MCP
configuration. AIH invokes the exact `cisco-ai-mcp-scanner==4.8.2` committed uv
project and lock with `--locked --isolated --offline --no-python-downloads
--no-env-file`, passes only statically extracted tool names/descriptions, and
uses the static mode's local `yara` analyzer; pinned 4.8.2 does not execute its
`prompt_defense` or `readiness` analyzers in static mode. Verify the locked
project once online and then offline on each managed workstation. If policy
lists `mcp-scanner` in `requiredDetectors`, an unavailable runtime fails closed
at enterprise posture; otherwise it remains an explicit degraded-coverage skip.

For GitHub MCP, treat incumbency as an org fact. If github.com is reachable and approved, include
`api.githubcopilot.com` in `mcp.incumbentHosts`; if you use GHES, set `mcp.githubHost` to that
https origin and include its host in `mcp.incumbentHosts`; if GitHub is blocked or not your VCS,
put `"github"` in `mcp.disabledServers` or use `aih mcp --mode offline|none`.

GitHub's hosted MCP endpoint supports client OAuth where the client has a registered OAuth app.
For clients that cannot dynamically register with GitHub's auth server, use
`aih mcp --github-auth token`: the generated server stays on the hosted URL but sends an
`Authorization` header sourced from `${GITHUB_PERSONAL_ACCESS_TOKEN}`. Put the real token only in
your untracked environment or secret manager; aih writes the placeholder to `.env.example`, never
the token value. Token auth ignores ambient `GITHUB_HOST`; non-default hosted GitHub MCP endpoints
must come from committed org policy and `mcp.incumbentHosts`.

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
