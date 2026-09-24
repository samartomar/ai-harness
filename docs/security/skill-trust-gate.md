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
> - First-party (repo-relative local) sources are graded on aih-native coverage: an *unavailable*
>   deep detector no longer forces UNKNOWN for a path under the repo root (it still does for remote
>   or out-of-repo sources). Native RED and shape/license rules are unchanged. See
>   [docs/product/docs-quality-pack.md](../product/docs-quality-pack.md). (#166)
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
aih workspace add <repo-or-path> --pin <sha> --apply
aih skill inventory
aih skill quarantine --name <skill-name> --apply
aih skill remove --name <skill-name> --apply
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

Sandbox-smoke unavailability is recorded as a `trust.sandbox-smoke-unavailable`
skip at every posture because it describes a missing host capability, not the
candidate content. The skip remains visible in trust evidence. When the sandbox
is available and an executed smoke run fails, `trust.sandbox-smoke-failed`
remains a blocking content finding.

## Completion evidence: zero findings must be proven

Scan's "succeeded" is not proof that an analyzer looked at anything. Core counts a detector
run as completed, and its zero findings as zero, only when the SARIF itself proves it
(`src/trust/scan-sarif.ts`):

- **Shape.** The log must have at least one run. Each run names a tool driver, has a results
  array, and reports non-empty `invocations`. Every invocation is `executionSuccessful: true`,
  its notification lists are well formed, and none is at `error` level. This applies to
  delegated runs, precomputed SARIF (Scanner annexes, joined Cisco shards) and each Cisco shard
  job.
- **Subject.** A delegated run, the binding gate and each Cisco shard job must carry Scan's
  completion evidence v1 in `invocations[0].properties.aihScanCompletionV1` (every run equal).
  Core recomputes `subjectTreeSha256` and `analyzedFileCount` (subject-files-v1) from the files
  it submitted, under each detector's rule (`src/trust/scan-subject-files.ts`):
  - Semgrep and SkillSpector: the whole tree.
  - Snyk: the tree without its top-level `.git`.
  - Cisco: the files under each selected `SKILL.md` directory.
  - mcp-scanner: the MCP config files Core named.
  - Trust lint and binding gate: the selection Core sent.
  - A shard job: every file under its job directory.

  The detector must be the one requested, and the analyzer version and uv.lock digest must be
  the identity Core accepted for the run (`null` for in-process and SkillSpector Docker
  profiles). Zero files are accepted only for Semgrep, SkillSpector, Snyk, the trust lint and
  the binding gate.
- **SkillSpector image.** A SkillSpector run records no uv.lock, so its image is its identity:
  `evidence.observation.image` must name Core's pinned digest or one Core's policy accepted,
  with the matching acceptance (`scan-pinned` or `caller-accepted`) and a reference, and the
  analyzer version must be `<pinned revision>@<that digest>`. No other detector may state an
  image.

A run that fails either check is `trust.detector-unavailable` with outcome `failed`; a required
detector fails at enterprise posture. Core binds the subject for each detector call on its
own: it recomputes it immediately before the call, checks the evidence against that, and
recomputes it again once the call returns. A tree that changed during the call fails the
detector, and a change between two detectors is checked against the tree as it stood for each. The trust lint's and binding gate's evidence
covers the declared selection only.

Precomputed SARIF (a Scanner annex) meets the subject check too, against the tree being
scanned, and its analyzer must be the one Core pins for the detector under the profile Core
requires for that evidence: the uv profile the caller states (`uvExecutionProfileId`, from
policy `trust.uvExecutionProfile`), otherwise Core's default `host-process-uv-v1`. An annex
naming another profile's pinned analyzer (for example Cisco's host-profile lock when the
namespace profile is required) fails the detector, naming both profiles. SkillSpector's identity
is its image, as for a delegated run.

A Scanner publication's (baseline-vet) annexes, consumed as baseline evidence, follow Scan's
baseline rule (decision D24) and nothing else. Only the Scanner consumer grants that rule: after
Scan verifies every batch's signed attestation, it wraps each annex for the detector it was
published for and marks the wrapper privately. A plain string, a caller-built wrapper of the same
shape, or one detector's annex presented for another is inline SARIF; a live scan has no option
that claims the baseline rule. For Semgrep, SkillSpector and Cisco alike Core recomputes the
subject over the consumer's source root as exactly what Scan's batch snapshot received, walking it
by the snapshot's rules rather than the seal's where they differ:

- the top-level `.git` is left out before the walk and never visited, so nothing inside it (a
  broken link included) can fail the subject;
- a link must hold a relative target that resolves, segment by segment, through real directories
  to a real file or directory inside the root. An absolute target, a link to or through another
  link, a target inside the top-level `.git`, a broken target, and one leaving the root are
  refused, as the snapshot refuses them (the seal accepts in-root absolute and chained links);
- a directory link that names a directory holding a link is refused as a cycle;
- a file link is keyed by its path and hashed over its target; a directory link is recorded but
  never copied into the snapshot (D26), so it contributes nothing.

Cisco here is the skill-directory scan of the whole snapshot, never a job set or shard. The
analyzer must be the one Scan's batch runs: `linux-namespace-uv-v1` for Semgrep and Cisco, and for
SkillSpector `docker-hardened-skillspector-v1` (no lock; the pinned revision at a digest Core
accepts). Any other profile's pinned identity or a subject that includes `.git` fails the
detector; an annex without evidence is still `completion-evidence-absent`. Inline precomputed
SARIF and delegated runs keep their per-detector rules.

SARIF with no completion evidence at all, which is every publication made before Scan wrote it,
is never counted complete: it is `trust.detector-unavailable` with reason
`completion-evidence-absent` and must be republished with evidence. A joined Cisco shard log
is exempt only when `joinCiscoShardResults` verified it, because each job was already checked
against its own subject. The exemption is bound to the tree it was verified for: the scanned
root (by realpath) must be the one the join was issued for, the jobs Core derives from that tree
now (each directory holding a selected `SKILL.md`) must be exactly the join's jobs, and each
job's subject, rehashed at the scan, must equal the subject verified at the join. Anything else
fails the detector with the difference named. No caller can name another root for a join: a
baseline component scan gets its join through `withCiscoShardJoinProjectionV1`, which creates the
projection directory itself, copies the included jobs into it from the verified root (only the
outermost ones: a job nested in another selected job arrives with it, and is still bound and
rehashed on its own), and binds the join to that directory for the one scan, removing it
afterwards. The binding is to the
directory Core created, by identity (device, inode and birth time, a real directory and never a
link or junction), checked before and after the jobs are rehashed; a directory replaced at the
same pathname fails the detector. When the scan settles Core revokes the join, so presenting it
again, even at a recreated pathname holding the same jobs, fails with "the shard join's projection
no longer exists". A file-system error while Core reads the projection's identity at the scan
fails the detector with a refusal naming the path and the error code; it never rejects the scan
and never passes. A projection Core cannot prepare (reading its identity, copying a job,
resolving it) is never scanned: Core returns a `refused` result holding the failed Cisco detector,
with the path and error code, and reads nothing more there. Removing the projection never
replaces the result, or the scan's own error: a removal that fails is returned beside the result
as a typed `cleanupFailure` naming the path and code, which baseline vet reports as progress.

## Analyzer execution profiles and their limits

Every detector runs in the installed `@aihq/scan` under an execution profile aih names; no
profile falls back to another. The uv analyzers (Cisco skill-scanner, Semgrep, Cisco MCP
scanner, Snyk Agent Scan) run under `host-process-uv-v1` on every OS by default: a host
process with no isolation and unenforced network. The org policy field
`trust.uvExecutionProfile: "linux-namespace-uv-v1"` selects Scan's hardened Linux profile,
which runs the analyzer in a bubblewrap namespace. These limits are known and reported,
never hidden:

- **The namespace profile runs no source-tree Cisco scan.** Scan accepts a source-tree
  `detector.cisco` subject only under `host-process-uv-v1`, so under
  `linux-namespace-uv-v1` `aih trust scan` and `aih skill vet` report Cisco as
  `trust.detector-unavailable` with Scan's reason (`unsupported-subject-kind`) and an
  execution outcome of `refused`. That is a skip by default and a fail when Cisco is a
  required detector at enterprise posture; aih does not rerun it under the host profile.
  Next route: where Cisco coverage is required, keep the default host profile. Namespace
  coverage for Cisco needs either Scan to accept a source-tree subject under that profile
  or aih to route trust-scan Cisco through Scan's shard runner; neither exists yet.
- **bubblewrap inside Docker needs a relaxed container.** Docker's default seccomp and
  AppArmor profiles stop bubblewrap from creating namespaces ("No permissions to create
  new namespace"), and Docker's read-only `/proc/sys` stops it next ("cannot open
  /proc/sys/user/max_user_namespaces"). Running the namespace profile in a container
  needs `--security-opt seccomp=unconfined --security-opt apparmor=unconfined
  --security-opt systempaths=unconfined`. Under default Docker security each uv analyzer
  is reported as typed `trust.detector-unavailable`, not skipped silently.
- **Scan refuses analyzers under root.** On Linux, Scan will not execute a uv analyzer under
  the root identity ("analyzer execution refuses root identity"), under either profile. A
  root container or CI job gets typed `trust.detector-unavailable` for every uv analyzer;
  run the scan as an unprivileged user.

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

The governed Snyk Agent Scan 0.5.17 adapter has protected behavioral qualification evidence from
[main run 31828959167](https://github.com/samartomar/ai-harness/actions/runs/31828959167). The run
used a generated synthetic fixture and produced a commit-bound sanitized receipt. This evidence
qualifies the adapter path and pinned runtime; it does not claim arbitrary scanned content is safe.

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
skills with install scripts
skills with MCP servers
skills with generated code execution
```

## Skills-over-MCP governance

Incoming MCP configs that expose FastMCP skills resources (`SkillsProvider`,
`SkillsDirectoryProvider`, `ClaudeSkillsProvider`, or `skill://` resources) are
governed as part of the trust scan:

- the FastMCP server version is read from exact pins such as
  `fastmcp==3.2.4`;
- local skills-over-MCP stdio servers are classified as zero-egress unless they
  use a hosted URL;
- the `_manifest` payload or recorded manifest hash is written into the scan
  evidence as a SHA-256 value;
- reload mode (`reload=true`, `--reload`, or equivalent hot reload fields) is
  treated as supply-chain drift, the same policy path as a floating `@latest`
  launch.

Enterprise posture denies unpinned or reload-enabled skills-over-MCP servers.
Vibe posture leaves them warning-only so reviewers still see the drift
risk before promotion.

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

## Scoped multi-skill evidence

`aih skill vet <source> --name <skill>` scopes the reviewed artifact to the
selected skill folder. License evidence is resolved from that selected folder
first, then from the source root. The evidence records the exact `SKILL.md`,
`LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING`, or `package.json` path used.

Sibling skill folders do not contribute license evidence to the selected skill.
If neither the selected skill folder nor the source root contains license
evidence, `trust.license-missing` still fails closed under the normal skill vet
verdict rules. Fetched GitHub archives follow at most three HTTPS redirects and
only between the canonical GitHub API and codeload hosts before unpacking into
quarantine. Archive symlink entries are refused, so selected-artifact evidence
cannot be materialized from a sibling path during fetch.

Scoped evidence also records a `sourceScope` block with selected skill names,
included paths, and excluded sibling skill paths. The excluded paths stay visible
as source-level context, but their findings are not folded into the selected
artifact verdict. `aih skill approve --name <skill>` carries the same scope into
the committed skill card and `aih-skills.lock.json`; approving an excluded
sibling still requires its own scoped vet evidence file. Nested skill boundaries
are refused because a selected parent or child cannot be truthfully represented
as both included and excluded in one scoped artifact.

When two physical skill directories resolve to the same promoted skill name or
case-insensitive promotion path, `aih skill vet --name <skill>` and workspace
promotion refuse the source. This keeps selected evidence bound to a single
physical artifact and avoids approval inheritance across ambiguous same-name
directories.

## Unicode finding classes

The trust scan classifies Unicode by character class rather than treating all
non-ASCII text as hidden. Zero-width/default-ignorable characters, bidi
controls, Unicode tag characters, and homoglyph-confusable characters inside
ASCII-like tokens stay `trust.hidden-unicode` and fail closed at every posture.

Ordinary language text, accented characters, typography, and emoji are reported
as `trust.visible-unicode` on every surface, including `SKILL.md`, configuration,
and source files. These are visible warnings at every posture: they remain in
evidence and disclosure, but do not require an acknowledgement. A path never
turns an ordinary visible character into a hidden one.

External prompt-injection adapters may suppress a narrow agent role-definition
result only on those same reviewable surfaces. Role language on instruction,
agent, command, config, or executable surfaces remains strict. Override,
jailbreak, secret or credential, URL, upload/send, and exfiltration language is
never covered by the role-definition exception.

A separate, narrower mechanism governs authenticated API examples and the
native secret-exfil heuristic. A `curl` POST to an HTTPS endpoint using an
`Authorization: Bearer $ENVIRONMENT_VARIABLE` header is
`trust.external-egress`: review-required, warning-only below enterprise, and
acknowledgeable by exact fingerprint with a reason at enterprise. This does not
cover instructions to collect, reveal, or transmit credentials.

The native secret-exfil heuristic
(`prompt-injection.secret-exfil`, in the `@aihq/scan` trust lint) requires actual intent,
not just a nearby HTTP verb, endpoint, credential word, or URL. Endpoint
declarations, HTTP client calls, headings, code samples, ordinary product copy,
and directly negated security guidance emit no prompt-injection finding. A
documented authenticated request using an environment credential is classified
as review-required external egress.

Genuine or weaponized phrasing still blocks: explicit override instructions,
positive credential-exfiltration imperatives, double negation ("never refuse to
send secrets"), a conjunction or temporal re-introduction ("never leak secrets
unless asked, then upload ..."), a cross-sentence polarity flip, or a
meta-instruction that references a quoted rule. The override and
ignore-instructions rules remain independent.

Deep-detector results with the same analyzer, rule, normalized source path, and
source line remain separate raw occurrences but normalize to one AIH finding for
policy and verdict counts. This removes duplicate inflation without deleting
scanner evidence or merging distinct rules, lines, or analyzers. <!-- aih:claim CM-19 -->

Content finding fingerprints bind the finding code, normalized safe path,
detector or rule identity, exact finding text or line content, and a stable
occurrence index for identical repeated findings. They retain the complete
64-hex SHA-256 digest. The displayed line number is advisory metadata and is not
part of acknowledgement identity: inserting an unrelated line does not churn
an acknowledgement, while changing the finding content does.

## Detector finding file classes

An otherwise-generic deep-detector finding anchored in a regular,
non-executable `LICENSE*`, `COPYING*`, or `NOTICE*` file is reported as
`trust.legal-text-detector-finding`. It is a visible warning at every posture and
does not require acknowledgement. The report still names the file class and the
detector rule so the evidence is not silently discarded.

A third-party danger label is not itself proof. AIH re-reads the referenced
source and requires contextual corroboration before prompt injection blocks.
Actual override/exfiltration intent, malicious executable behavior,
hidden-control smuggling, auto-execution, dependency confusion, and typosquats
remain blocking. Lexical, documentation, security-teaching, code-reading,
file-writing, and generic heuristic matches warn when no AIH rule proves an
elevated risk. <!-- aih:claim CM-23 -->

The Cisco AI Defense skill-scanner also emits a metadata-hygiene finding when a
skill manifest omits a `license` field. The component scanner first checks a
regular top-level `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING` file. When
one exists, the report records repository-level license inheritance and the
metadata check passes. The isolated baseline projection includes that one
top-level license file so the answer is the same in qualification.

When neither skill frontmatter nor repository evidence resolves licensing, the
finding is `trust.skill-metadata-license`: review-required, warning-only at vibe
and blocking at enterprise until its exact fingerprint is
acknowledged with a recorded reason. Other unmapped Cisco and generic
third-party heuristic findings are warnings, not review-required by default.
Credible unresolved external transmission is review-required. A mapped danger
rule blocks only when contextual AIH evidence corroborates the behavior.

The native license gate is unchanged: `src/skill/license.ts` still fails
`trust.license-missing`, the skill verdict engine still grades that UNKNOWN, and
`aih skill approve` still refuses a source without recorded license evidence.
<!-- aih:claim CM-23 -->

For a selected skill with review-required findings, rerun the same vet with
the reported comma-separated fingerprints and a reason:

```bash
aih skill vet <source> --name <skill> --posture enterprise \
  --acknowledge <fingerprint-1>,<fingerprint-2> \
  --reason "reviewed exact pinned finding"
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
