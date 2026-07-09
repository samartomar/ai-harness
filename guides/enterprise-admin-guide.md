---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-09
truth_home: true
purpose: Admin guide for governed organizations and enterprise rollout of AI-Harness.
---

# Enterprise Admin Guide to AI-Harness

Use this guide for enterprise admins, platform owners, security owners, fleet rollout, regulated teams, and organizations that need policy, evidence, approval paths, and developer handoff. For posture mechanics, read [Postures](postures.md). For the full command map, use [Command Use Cases](command-use-cases.md). Developers consuming an admin-authored policy should read [Enterprise Developer](enterprise-developer-guide.md).

This guide owns admin-side material: policy authoring, approvals, source pins, signing choices, Docker/SkillSpector preparation, bundles, and evidence packaging. It should not become the place for developer-local OAuth, API token setup, or day-to-day client usage beyond handoff requirements.

## 1. Executive Summary / Mental Model

For enterprise use, AI-Harness is a local enforcement reader plus a repeatable evidence surface. It does not move governance into an agent chat. It helps a team materialize approved repo canon, policy, MCP configuration, capability intent, skill approvals, packs, bundles, truth sidecars, and evidence in files that can be reviewed, pinned, signed, and verified.

The `enterprise` posture emphasizes least privilege, approval, auditability, and fail-closed behavior where policy requires it. The CLI remains local-first. Public docs should describe implemented mechanisms and supported commands; label unshipped admin-plane concepts as future-facing or omit them from setup guidance.

The enterprise examples in this public guide are intentionally limited to reviewed Figma, Jira/Atlassian, and AWS MCP paths. Additional service MCPs should follow the same policy and source-review pattern before appearing in public enterprise guidance.

Release baseline covered by this guide: `@aihq/harness@2.4.3`. The scoped public security doc documents SLSA v1.2 Build L2 for tagged release artifacts; no Build L3 or formal compliance claim is made.

## 2. Quickstart / Implementation Blueprint

### Admin Workstation Prerequisites

Prepare the admin workstation before authoring policy or bundles:

- Node.js/npm for installing and verifying `@aihq/harness`.
- Git for source pins, release checks, and admin-configuration commits.
- Docker or a compatible container runtime when the organization requires containerized detectors such as SkillSpector, or when scanner images need to be built, pushed, and signed.
- Cosign or the organization's selected signer when marketplace artifacts, bundles, evidence, or container images require signatures.
- Access to the approved container registry, package registry, source hosts, and secret manager.
- Corporate TLS/proxy configuration needed for npm, Git, Docker registry, GitHub, Atlassian, Figma, AWS, and signing endpoints.

Portable readiness checks:

```powershell
node --version
npm --version
git --version
docker version
cosign version
```

If Docker or cosign is not part of the organization's selected policy path, document the alternate detector or signing path instead of implying those checks ran.

Verify the release before rollout:

```console
npm install -g @aihq/harness
npm audit signatures
aih verify-release 2.4.3
```

Use `npm install -g @aihq/harness@latest` for major-version upgrades; `npm update -g`
may stay within the current major. Use `--force` only when replacing a broken global
install after reviewing the npm prefix and approved package source.

Bootstrap a governed repo with an enterprise posture:

```console
aih init . --posture enterprise --mcp-mode offline --mcp-compliant
aih init . --posture enterprise --mcp-mode offline --mcp-compliant --apply
aih bootstrap-ai --all-tools --apply
aih bootstrap-ai --verify
```

Validate policy and baseline:

```console
aih policy validate
aih doctor --posture enterprise
aih secrets --verify
aih docs-lint
aih pack validate
```

Record capability intent when the organization wants a committed capability manifest:

```console
aih capability resolve --posture enterprise --apply
aih capability prune --apply
```

Approve and distribute governed skills:

```console
aih skill vet <skill-source> --apply
aih skill approve <skill-source> --owner <security-or-platform-owner> --pack <pack-name> --apply
aih pack status --pack <pack-name>
aih pack validate --pack <pack-name>
aih marketplace build --out <artifact-dir> --apply
aih marketplace publish --dir <artifact-dir> --signer cosign --apply
aih marketplace validate --dir <artifact-dir> --require-signature
```

Use the first-party docs-quality pack in a governed repo only after local approval evidence exists:

```console
aih pack scaffold --pack docs-quality --apply
aih skill vet packs/docs-quality/betterdoc --apply
aih skill approve packs/docs-quality/betterdoc --owner <security-or-platform-owner> --pack docs-quality --apply
aih pack validate --pack docs-quality
```

Create and verify a truth sidecar only after the repo has a real commit to bind:

```console
aih init . --sidecar --posture enterprise --apply
aih truth verify --posture enterprise
aih truth pack --posture enterprise --apply
```

Build evidence for review:

```console
aih evidence build --out <evidence-dir> --sign cosign --require-signature --apply
aih verify-bundle --bundle <evidence-dir> --require-signature
```

### Admin Configuration Repo

An enterprise admin can keep the policy and bundle source in an otherwise empty repo, for example `aih-admin-configuration`. The admin repo is a distribution source, not a secret store. Commit policy, pins, cards, pack manifests, and bundle output metadata only after review. Keep real tokens, PATs, OAuth state, AWS profiles, and Jira/Figma credentials in developer-local environment variables, browser OAuth, or the organization's secret manager.

```powershell
git init aih-admin-configuration
Set-Location aih-admin-configuration
@'
{
  "schemaVersion": 1,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
  "mcp": {
    "allowedServers": [],
    "approvals": [],
    "allowManagedOnly": true,
    "incumbentHosts": [],
    "disabledServers": []
  },
  "trust": {
    "requireSignedSource": false,
    "requiredDetectors": [
      "skillspector"
    ],
    "requiredChecks": [
      "license",
      "pin"
    ],
    "internalScopes": []
  }
}
'@ | Set-Content -Encoding utf8 aih-org-policy.json
aih policy validate
git add aih-org-policy.json
git commit -m "seed enterprise ai-harness policy"
```

Developers can consume this policy by setting `AIH_ORG_POLICY` to the cloned file path. Product repos may also commit their own `aih-org-policy.json` when policy is repo-local; the env override wins when set and should be visible in `aih doctor --posture enterprise`.

### Scanner And Docker Preparation

`aih trust scan` can evaluate sources without Docker for checks that do not require a containerized detector. Docker becomes part of the admin setup when policy requires a detector such as `skillspector`, or when the organization wants scanner images built and signed before use. If `aih-org-policy.json` lists `skillspector` in `trust.requiredDetectors`, do not treat scanner coverage as complete until the detector path is available and recorded.

Build the reviewed SkillSpector image from a fixed commit:

```powershell
git clone https://github.com/NVIDIA/SkillSpector.git
Set-Location SkillSpector
git checkout 326a2b489411a20ed742ff13701be39ba00063c8
docker build --label org.opencontainers.image.revision=326a2b489411a20ed742ff13701be39ba00063c8 -t skillspector:aih-326a2b489411 .
docker image inspect skillspector:aih-326a2b489411 --format "{{.Id}}"
```

Use AI-Harness to report the currently pinned analyzer image metadata before changing policy or detector requirements:

```powershell
aih trust skillspector-pin
```

If the local image ID differs from the controlled digest reported by `aih trust skillspector-pin`, record an explicit reviewed local digest before requiring `skillspector` in enterprise policy:

```powershell
$SkillSpectorDigest = docker image inspect skillspector:aih-326a2b489411 --format "{{.Id}}"
aih trust skillspector-pin `
  --candidate-revision 326a2b489411a20ed742ff13701be39ba00063c8 `
  --candidate-tag skillspector:aih-326a2b489411 `
  --candidate-digest $SkillSpectorDigest `
  --approve-local-digest `
  --reason "Reviewed local Docker build from pinned SkillSpector source." `
  --reviewer security-platform `
  --apply
aih policy validate
```

For a proposed analyzer source pin bump, use candidate fields from the reviewed upstream/image metadata to surface the compare URL before changing code or policy:

```powershell
aih trust skillspector-pin --candidate-revision <40-char-sha> --candidate-tag <image-tag> --candidate-digest sha256:<64-char-hex>
```

The source commit pin is the review anchor; the image ID verifies the local build output. If the image will be shared beyond the admin machine, tag it into the approved registry and sign the registry reference or immutable digest according to the organization's signing policy:

```powershell
$ImageRef = "<registry>/<namespace>/skillspector:aih-326a2b489411"
docker tag skillspector:aih-326a2b489411 $ImageRef
docker push $ImageRef
cosign sign --key <cosign-key-ref> $ImageRef
cosign verify --key <cosign-public-key-ref> $ImageRef
```

Use a digest form such as `<registry>/<namespace>/skillspector@sha256:<digest>` when the registry/signing policy requires immutable references. Do not commit registry credentials, cosign private keys, Docker auth files, or scanner output containing repo secrets.

### Enterprise Configuration Levels

| Level | Admin intent | Command setup |
|---|---|---|
| Min Configuration | Install verified AI-Harness, enforce enterprise posture, generate only policy-allowed MCP, and keep evidence local. | `aih verify-release 2.4.3`, `aih policy validate`, `aih init . --posture enterprise --mcp-mode offline --mcp-compliant`, `aih bootstrap-ai --all-tools --apply`, `aih doctor --posture enterprise`, `aih secrets --verify` |
| Balanced | Min plus ECC, BetterDoc, and one reviewed MCP example such as Figma for teams that need coding canon, docs quality, and approved design context. | Min commands plus `aih ecc --cli claude,codex --profile core --posture enterprise --apply`, `aih pack scaffold --pack docs-quality --posture enterprise --apply`, `aih pack install --pack docs-quality --posture enterprise --apply`, `aih mcp approve figma --accept-egress ...`, and reviewed `.mcp.json` for Figma. |
| Powerhouse Mode | Balanced plus usage/reporting, Superpowers, truth sidecar, selected external skills, Figma, Atlassian/Jira, and selected AWS MCP. | Balanced commands plus `aih superpowers`, `aih usage`, `aih track`, `aih report --v9`, `aih truth verify`, `aih truth pack`, external `aih trust`/`aih skill` approvals, and explicit MCP approvals/config for Figma, Atlassian, and AWS. |

Most writing commands refuse a dirty worktree unless `--force` is supplied. In governed rollout, prefer one reviewed commit per stage. For a dedicated setup branch or disposable admin repo where the operator has reviewed the pending diff, `--force` can be added to chained authoring commands.

Min Configuration:

```powershell
npm install -g @aihq/harness
npm audit signatures
aih verify-release 2.4.3
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

Warm pinned `uvx` MCP packages before relying on offline startup in managed images
or disconnected workstations:

```powershell
uvx code-review-graph@2.3.6 --version
uvx codebase-memory-mcp@0.8.1 --help
uvx awslabs.core-mcp-server@1.0.27 --help
uvx --offline --no-python-downloads --no-env-file code-review-graph@2.3.6 --version
```

If `uvx` is missing, `aih heal --scope path` diagnoses the PATH gap and emits
reviewed shell/profile instructions. It does not silently edit shell profiles.

Balanced:

```powershell
aih ecc --cli claude,codex --profile core --posture enterprise
aih ecc --cli claude,codex --profile core --posture enterprise --apply
aih pack scaffold --pack docs-quality --posture enterprise --apply
aih skill vet packs/docs-quality/betterdoc --posture enterprise --apply
aih skill approve packs/docs-quality/betterdoc --owner docs-platform --pack docs-quality --mode review-only --intended-use "Source-grounded documentation editing." --posture enterprise --apply
aih pack install --pack docs-quality --posture enterprise --apply
aih pack validate --pack docs-quality
aih mcp approve figma --accept-egress --reason "Approved Figma remote MCP for reviewed design-context workflows; file permissions remain in Figma." --reviewer design-platform --posture enterprise --apply
```

Powerhouse Mode:

```powershell
aih superpowers --cli claude,codex --posture enterprise --apply
aih usage --cli claude,codex,cursor,zed --posture enterprise --apply
aih track --posture enterprise --apply
aih report --v9 --posture enterprise --apply --out .aih/reports/enterprise-v9.html
aih init . --sidecar --posture enterprise --apply
aih truth verify --posture enterprise
aih truth pack --posture enterprise --apply
aih evidence build --out .aih/evidence-bundle --sign cosign --require-signature --posture enterprise --apply
aih verify-bundle --bundle .aih/evidence-bundle --require-signature
```

### External Skill Authoring And Approval

Use a full commit SHA for every external source. The pins below were resolved on 2026-07-07 as review examples; re-verify the upstream source, license, package behavior, and current commit before approving them in an organization.

| Source | Pin | Notes |
|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills) | `9d2f1ae187231d8199c64b5b762e1bdf2244733d` | Official Agent Skills examples. Select individual skill folders after license and fit review. |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `12b486b22e67f5d887962ef8351c1ac863bfaeb9` | UI/UX design-assist skill. The upstream repo recommends its CLI installer; treat that CLI as a separately reviewed tool before enterprise use. |

Anthropic skill selection example:

```powershell
$AnthropicSkillsPin = "9d2f1ae187231d8199c64b5b762e1bdf2244733d"
$SelectedAnthropicSkills = @(
  "frontend-design",
  "webapp-testing",
  "mcp-builder",
  "skill-creator",
  "doc-coauthoring",
  "brand-guidelines",
  "internal-comms"
)

git ls-remote https://github.com/anthropics/skills.git HEAD
aih trust scan anthropics/skills --pin $AnthropicSkillsPin --posture enterprise --apply
aih trust allow anthropics/skills --pin $AnthropicSkillsPin --posture enterprise --apply

foreach ($Skill in $SelectedAnthropicSkills) {
  aih skill vet anthropics/skills `
    --pin $AnthropicSkillsPin `
    --name $Skill `
    --posture enterprise `
    --apply

  aih skill approve anthropics/skills `
    --pin $AnthropicSkillsPin `
    --name $Skill `
    --owner platform-ai `
    --pack enterprise-skills `
    --mode review-only `
    --intended-use "Approved Anthropic skill: $Skill. Use only within its reviewed task scope." `
    --posture enterprise `
    --apply
}

aih pack init --pack enterprise-skills --description "Reviewed enterprise skill selection." --posture enterprise --apply
aih pack validate --pack enterprise-skills
```

For multi-skill sources, vet every selected skill with `--name <skill>` before approving it.
A source-wide `aih skill vet` remains useful for broad triage, but it does not satisfy a named
`aih skill approve --name <skill>` gate.

For Anthropic document skills such as `docx`, `pdf`, `pptx`, and `xlsx`, verify the license terms and distribution path before approval. The upstream repo distinguishes open source examples from source-available document capability references.

UI/UX Pro Max authoring example:

```powershell
$UiUxPin = "12b486b22e67f5d887962ef8351c1ac863bfaeb9"
git ls-remote https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git HEAD
aih trust scan nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --posture enterprise --apply
aih trust allow nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --posture enterprise --apply
aih skill vet nextlevelbuilder/ui-ux-pro-max-skill --pin $UiUxPin --name ui-ux-pro-max --posture enterprise --apply
aih skill approve nextlevelbuilder/ui-ux-pro-max-skill `
  --pin $UiUxPin `
  --name ui-ux-pro-max `
  --owner design-platform `
  --pack powerhouse-skills `
  --mode design-assist `
  --intended-use "Reviewed UI/UX design assistance. Does not replace design review or design-system ownership." `
  --posture enterprise `
  --apply
aih pack init --pack powerhouse-skills --description "Reviewed design and build skills." --posture enterprise --apply
aih pack validate --pack powerhouse-skills
```

If the organization chooses the upstream CLI installer path, pin and review the npm package and generated files separately. Do not let `npm install -g ui-ux-pro-max-cli` become an unreviewed managed-workstation step.

### MCP Control Examples

`aih mcp approve` records server-name approval, the current server-shape `subject`, egress acceptance, review reason, reviewer, and `approvedAt` in repo-local policy. It does not by itself write custom third-party MCP client config for servers outside the generated AI-Harness catalog. For Figma, Atlassian/Jira, and selected AWS MCP servers, keep a reviewed config template beside the policy and let developers apply it only after policy approval.

| Service | Server key to approve | Reviewed endpoint or source | Developer auth boundary |
|---|---|---|---|
| Figma | `figma` | `https://mcp.figma.com/mcp`; desktop fallback `http://127.0.0.1:3845/mcp` only when approved. | Figma OAuth, plan/seat/file permissions, and explicit file or selection links. |
| Jira / Atlassian | `atlassian` unless the org intentionally names the server `jira` | `https://mcp.atlassian.com/v1/mcp/authv2` | OAuth 2.1 preferred. API token only if Atlassian admin enables it; never commit `JIRA_API_TOKEN`. |
| AWS generated core | `awslabs.core-mcp-server` | AI-Harness generated `uvx awslabs.core-mcp-server@1.0.27` when AWS stack is detected. | No credential in config. |
| AWS Knowledge | `aws-knowledge-mcp-server` | `https://knowledge-mcp.global.api.aws` | Remote AWS-hosted endpoint. Review data egress and IAM/org controls. |
| AWS docs/IaC from [awslabs/mcp](https://github.com/awslabs/mcp) | `awslabs.aws-documentation-mcp-server`, `awslabs.aws-iac-mcp-server` | Pin `awslabs/mcp` at `0e96fa1d3a6c5bbf84fcd89ab02ff70a34d061a5`; package examples currently use `uvx awslabs.aws-documentation-mcp-server@latest` and `uvx awslabs.aws-iac-mcp-server@latest`, so enterprise should replace floating `@latest` with a reviewed version or internal mirror. | AWS profile/role comes from local environment or SSO, not committed config. |

Approval commands:

```powershell
aih mcp approve figma --accept-egress --reason "Approved Figma remote MCP for reviewed design-context workflows; file permissions remain in Figma." --reviewer design-platform --posture enterprise --apply
aih mcp approve atlassian --accept-egress --reason "Approved Atlassian Rovo MCP for Jira/Confluence work with existing user permissions." --reviewer delivery-platform --posture enterprise --apply
aih mcp approve aws-knowledge-mcp-server --accept-egress --reason "Approved AWS-hosted Knowledge MCP for AWS docs and regional availability lookup." --reviewer cloud-platform --posture enterprise --apply
aih mcp approve awslabs.aws-documentation-mcp-server --accept-egress --reason "Approved local AWS documentation MCP package from reviewed awslabs/mcp source." --reviewer cloud-platform --posture enterprise --apply
aih mcp approve awslabs.aws-iac-mcp-server --accept-egress --reason "Approved local AWS IaC MCP package from reviewed awslabs/mcp source." --reviewer cloud-platform --posture enterprise --apply
```

Use `aih mcp approve --apply` for repo-local policy because it computes the current `subject` and `approvedAt`. If `AIH_ORG_POLICY` is active, update the distributed policy directly; local approval writes are refused because the distributed policy wins. Hand-authored `mcp.approvals[]` entries need `server`, `subject`, `acceptEgress: true`, `reason`, and ISO-8601 `approvedAt`; `reviewer` is optional. Example shape:

```json
{
  "schemaVersion": 1,
  "minimumPosture": "enterprise",
  "references": {
    "repoContract": "ai-coding/project.json"
  },
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

Reviewed MCP config template:

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

For clients that require `mcp-remote` for Atlassian, keep that as a client-specific local proxy template:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@<approved-version-or-internal-mirror>",
        "https://mcp.atlassian.com/v1/mcp/authv2"
      ]
    }
  }
}
```

Replace the placeholder with an approved version or internal mirror. Do not publish copy-paste enterprise examples that depend on floating `@latest` packages.

For generated local Python MCP servers, AI-Harness starts pinned packages through
`uvx --offline --no-python-downloads --no-env-file`. Warm those packages on each
managed image before expecting MCP clients to start offline:

```powershell
uvx code-review-graph@2.3.6 --version
uvx codebase-memory-mcp@0.8.1 --help
uvx awslabs.core-mcp-server@1.0.27 --help
```

### Admin Finalization Checklist

Before handing configuration to developers, verify the admin package from the same repo or distribution location developers will use:

```powershell
aih verify-release 2.4.3
aih policy validate
aih policy verify --against <trusted-policy-sha-or-bundle>
aih pack validate --pack docs-quality
aih pack validate --pack enterprise-skills
aih pack validate --pack powerhouse-skills
aih marketplace build --out <marketplace-artifact-dir> --apply
aih marketplace publish --dir <marketplace-artifact-dir> --signer cosign --apply
aih marketplace validate --dir <marketplace-artifact-dir> --require-signature
aih evidence build --out <evidence-dir> --sign cosign --require-signature --apply
aih verify-bundle --bundle <bundle-dir> --require-signature
aih verify-bundle --bundle <evidence-dir> --require-signature
```

Then check the handoff material:

- `aih-org-policy.json` is committed or bundled from the admin repo and contains only policy, pins, approvals, and references. Keep it as JSON; `aih` does not execute JavaScript/module policy files.
- Required detectors are available, or the policy does not require them.
- `aih trust skillspector-pin` has been reviewed when SkillSpector is a required detector or a detector pin changes.
- Skill sources are pinned, vetted, approved, and included only through reviewed packs.
- MCP examples use approved server keys such as `figma`, `atlassian`, `aws-knowledge-mcp-server`, or reviewed `awslabs/*` package keys.
- `.mcp.json` or client-specific templates contain placeholders or OAuth endpoints only, not real tokens.
- Marketplace artifacts, bundles, evidence bundles, and container images are signed when policy requires signatures.
- The developer handoff names the admin repo clone path, the `AIH_ORG_POLICY` value, local auth expectations, and the verification commands developers must run.

### Common Use Cases

| Situation | Command path | Why |
|---|---|---|
| A release must be verified before rollout | `aih verify-release <version>` | Checks npm/GitHub/cosign/tarball evidence and reports honest skips. |
| Org policy may have drifted | `aih policy validate`, then `aih policy verify --against <sha-or-bundle>` | Separates schema validation from trusted-channel comparison. |
| Enterprise MCP must be constrained | `aih mcp --posture enterprise --mode offline --mcp-compliant --apply` | Writes only policy-allowed generated MCP servers and emits governance guidance for denied ones. |
| Enterprise baseline residue must be surfaced | `aih doctor --posture enterprise` | Attests declared MCP and packaged marketplace surfaces against org policy. |
| Capability needs should not auto-install | `aih capability resolve --posture enterprise --apply` | Records approval-required capability hints without fetching or installing third-party bytes. |
| A skill source needs approval | `aih skill vet <source> --apply`, then `aih skill approve <source> --owner <owner> --pack <pack> --apply` | Records evidence before approval and binds approval to source/pin. |
| A team needs a distributable skill set | `aih marketplace build --out <dir> --apply`, then `aih marketplace publish --dir <dir> --signer cosign --apply`, then `aih marketplace validate --dir <dir> --require-signature` | Packages approved skills, signs the distribution artifact, and validates artifact integrity. |
| A fleet needs policy/config distribution | `aih bundle --out <dir> --apply`, then `aih verify-bundle --bundle <dir> --require-signature` | Produces and verifies deterministic bundle material. |
| Audit material needs to cross teams | `aih evidence build --out <dir> --sign cosign --require-signature --apply` | Packages governance artifacts and evidence into a verifiable bundle. Use the signer selected by policy. |
| Project-truth assertions need verification | `aih truth verify --posture enterprise` | Fails closed on sidecar drift, invalid assertions, acceptance blockers, or stale agent evidence. |
| Public claims changed | `aih docs-lint` | Enforces claim markers through control-matrix rows and named tests while keeping prose guidance advisory. |
| Multi-repo state needs a governed parent view | `aih workspace link`, `aih workspace snapshot --lock --apply`, `aih workspace report --refresh-children --apply` | Keeps workspace coordination parent-owned and uses explicit child-write opt-ins. |

## 3. Best Practices & Architecture

Separate authoring, enforcement, and evidence. Policy and approvals should be authored through reviewed files or approved distribution channels. The CLI should read committed or signed state and produce verifiable local outcomes.

Prefer pinned and approved inputs. MCP servers, skills, marketplace artifacts, policy bundles, truth packs, and release assets should be declared, pinned, and validated before use in governed environments.

Use enterprise posture to expose residue. `aih doctor --posture enterprise` should surface undeclared MCP servers, missing registries, invalid registry input, undeclared packaged marketplace skills, or policy drift instead of silently tolerating them.

Keep capability cache derived. `enterprise` posture may record approval-required capability hints, but `$HOME/.aih/capabilities/cache.json` is not a policy authority and can be rebuilt from committed manifests.

Use `docs-lint` as a release-quality gate for public claims. Current behavior fails closed on hard claim-ledger orphans; banned-phrase and vague-absolute findings remain advisory unless a local policy treats them as blockers.

Use truth sidecars as staged evidence inputs. The sidecar is external and commit-bound. A verified truth pack can be included in evidence bundles as a hashed artifact, but stale or malformed packs fail closed instead of being indexed.

Keep external tickets tool-neutral when the fix belongs to IT, security, or platform operations. Support templates should describe the blocked internal configuration and requested fix without exposing unnecessary tool internals.

Package evidence intentionally. Use `aih evidence build`, fleet bundles, checksums, and signature requirements when artifacts need to cross team or environment boundaries.

Keep public-state checks portable. Enterprise runbooks should work on Windows, Linux, and macOS using `git`, npm registry reads, browser URLs, or approved HTTP clients. GitHub CLI (`gh`) is useful for approved authenticated reads and GitHub attestation/signing workflows, but it should appear as an optional path beside the portable check.

Keep compliance language scoped. AI-Harness can produce evidence, checks, and policy verification outputs. Those outputs do not by themselves establish SOC 2, HIPAA, SLSA Build L3, legal safe harbor, customer-use claims, production proof, or formal audit completion.

## 4. Pitfalls to Avoid

- Do not bypass corporate TLS/proxy controls to make setup faster. Use `aih certs`, `aih heal`, support templates, or approved platform paths.
- Do not install unpinned hosted MCP servers or external skills into governed repos without approval evidence.
- Do not treat `pack scaffold` or a first-party local path as distribution approval for another repo. Vet and approve the copied source in that repo.
- Do not rely on mutable local caches such as `.aih/` or `~/.aih/` as policy authority.
- Do not expose non-public pricing, telemetry, customer, tenant, entitlement, or admin-plane details in public docs or issues.
- Do not treat a missing scanner as a passing scanner when policy requires that detector.
- Do not treat `docs-lint`, reports, truth packs, release provenance, or evidence bundles as formal compliance certification.
- Avoid hidden prerequisites such as `gh`, `jq`, Homebrew, apt, winget, or shell-specific syntax. Name the approved path for each operating system or posture.
- Do not claim compliance, certification, production proof, or audit readiness unless the source explicitly supports it.
