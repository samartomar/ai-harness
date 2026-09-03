# SkillSpector Detector

> Status: optional for ordinary local trust scans unless org policy requires it;
> mandatory for generating and releasing the shipped baseline evidence lock.

`aih` invokes SkillSpector through a pinned local Docker image tag:

```text
skillspector:aih-2d198ab910ad
```

The tag corresponds to NVIDIA/SkillSpector commit:

```text
2d198ab910add401cad658d1087e7c7ba24fd640
```

`aih` treats the local image as verified when Docker reports either the built-in
controlled build digest or an org-policy approved local digest:

```text
sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800
```

## Acquire the Image

The default acquisition path for local scans and Scanner-owned baseline
publication is a content-addressed pull from GHCR, re-tagged to the local runtime
name `aih` expects. Core's required `vet-once` workflow verifies committed
evidence and does not acquire or execute this image:

```bash
docker pull ghcr.io/samartomar/skillspector@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800
docker tag ghcr.io/samartomar/skillspector@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800 \
  skillspector:aih-2d198ab910ad
```

Pulling by digest is content-addressed, so verification does not depend on the
local Docker image-store type (containerd snapshotter vs. legacy graphdriver):
Docker records the pulled manifest digest in the image's `RepoDigests`
regardless of store, and `aih` accepts either a `.Id` match or a matching
`RepoDigests` entry (`src/trust/images.ts`).

**Public-visibility posture.** The GHCR package above is public, so pulling it
needs no `docker login` and no `packages:` workflow permission — the digest
pin is the control, not registry access control. If the package's visibility
ever changes to private, the pulling job additionally needs a `packages: read`
permission and an authenticated `docker login` to GHCR.

The local build below remains available as the audit path: it is how the
controlled digest is derived and re-verified in the first place, and it is the
fallback when your org mirrors the image or restricts pulls from public
registries.

## Build the Local Image (Audit Path)

```bash
AIH_ROOT="$PWD"
VET_ROOT="$(mktemp -d)"
git clone https://github.com/NVIDIA/SkillSpector.git "$VET_ROOT/SkillSpector"
git -C "$VET_ROOT/SkillSpector" checkout --detach \
  2d198ab910add401cad658d1087e7c7ba24fd640
docker buildx build \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --build-arg SOURCE_DATE_EPOCH=1785167267 \
  -f "$AIH_ROOT/tools/skillspector.Dockerfile" \
  -t ghcr.io/samartomar/skillspector:aih-2d198ab910ad \
  --output type=oci,dest="$VET_ROOT/skillspector.oci.tar" \
  "$VET_ROOT/SkillSpector"
docker load -i "$VET_ROOT/skillspector.oci.tar"
docker tag ghcr.io/samartomar/skillspector:aih-2d198ab910ad \
  skillspector:aih-2d198ab910ad
```

The harness-owned Dockerfile consumes the upstream commit's checked-in
`uv.lock`, pins its Python base by digest, removes two path-bearing wheel-cache
metadata files, and canonicalizes the virtual environment before the final
networkless runtime image is created. Two clean cache-disabled builds must agree
before the controlled digest changes.

Agreement between two builds is necessary but not sufficient on its own. Both
builds run in the same window and therefore resolve the same PEP 517 build
backends, so agreement alone detects concurrent nondeterminism only — it cannot
show that a digest is still rebuildable later. `uv.lock` pins the runtime
dependencies but not the backends that build the two packages compiled from
source, so a `setuptools` or `hatchling` release rewrites their `.dist-info`
metadata and with it the layer digest.

The builder therefore pins `UV_EXCLUDE_NEWER`, which fixes backend resolution to
the date the controlled image was built. That is what makes the digest
independently rebuildable: with the cutoff in place, revision
`2d198ab910add401cad658d1087e7c7ba24fd640` reproduces
`sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800`
exactly, and did so five times -- two clean cache-disabled exports on one
runner plus three further runners independently. Built at the previous
`2026-08-07` cutoff the same revision yields
`sha256:8b13ea2631690da416e951195545511e63d85e18a0cc183000295a5dd48d5f80`,
which is the perturbation control proving the cutoff is load-bearing.
Treat the cutoff as a pinned build input: moving it rotates the digest and
requires a re-vet. The `skillspector` entry in
`src/internals/external-pin-ledger.json` records this evidence.

If your org mirrors third-party tools, build the same commit from the mirror and
apply the same local tag. Local Docker builds can produce an image ID different
from the controlled digest above, so compare the image ID before deciding which
path to use:

```bash
docker image inspect skillspector:aih-2d198ab910ad --format '{{.Id}}'
```

If the image ID matches the controlled digest, no local policy approval is
needed. If it differs, record an explicit local digest approval after reviewing
the build inputs:

```bash
aih trust skillspector-pin \
  --candidate-revision 2d198ab910add401cad658d1087e7c7ba24fd640 \
  --candidate-tag skillspector:aih-2d198ab910ad \
  --candidate-digest sha256:<64-char-hex> \
  --approve-local-digest \
  --reason "<review reason>" \
  --reviewer "<reviewer>" \
  --apply
```

The local approval is written to `aih-org-policy.json` under
`trust.skillspector.approvedDigests[]` with the image tag, digest, pinned source
revision, reason, optional reviewer, and `approvedAt`. Do not retag a newer
checkout to this name; changed upstream revisions must be reviewed as a source
pin bump instead of a local digest approval.

## Rotating the Pin

Bumping `SKILLSPECTOR_SOURCE_REVISION` (`src/trust/images.ts`) to a new
upstream commit is a reviewed, human-authorized change with four steps, in
order:

1. **Derive the new controlled digest.** Use the two-clean-builds recipe
   above: build twice, cache-disabled, from the new commit, and confirm both
   builds produce the same image ID before treating it as controlled. Set
   `UV_EXCLUDE_NEWER` to a cutoff at or after the new commit and record that date
   with the digest — it is a pinned input, and a rotation that leaves it stale
   pins backends older than the source being built. Then run the perturbation
   control: build once more with the cutoff moved to an *earlier* date, across a
   known backend release, and confirm the digest *differs*. Do not use "cutoff
   removed" as the control: a cutoff at today's date selects exactly what
   floating resolution selects today, so that comparison passes trivially and
   proves nothing. Agreement alone only proves the builds were concurrent; the
   perturbation control is what proves the cutoff is wired in and load-bearing,
   and its absence is what let a non-rebuildable digest be recorded as
   reproducible.
2. **Re-verify the [YR4 carve-out equivalence table](#yr4-corepack-advisory-carve-out)**
   against the new commit's `src/skillspector/yara_rules/agent_skills.yar`. Any
   changed or added Gate-B string must be mirrored in
   `hasSkillspectorYr4PoisoningSignal` (`src/trust/detectors.ts`), with a
   matching blocking-case regression added to `tests/trust/scan.test.ts`.
3. **Publish the new image to GHCR** (`ghcr.io/samartomar/skillspector`) at
   the new digest. Publishing is a deliberate, human-authorized release step —
   `aih` and CI only ever pull and verify by digest; neither builds nor
   publishes images.
4. **Update the pinned constants together.** Move `SKILLSPECTOR_IMAGE_DIGEST`
   and `SKILLSPECTOR_SOURCE_REVISION` in `src/trust/images.ts` in the same
   change, so the source commit and the digest it produced are reviewed and
   move as one unit.

Only after all four steps land do Scanner's publication runtime and any local
`docker pull` resolve to the new, re-verified image. See
[Acquire the Image](#acquire-the-image) for the public-visibility posture that
governs how the pull is authenticated.

## How `aih` Uses It

`aih trust scan` and skill vetting call the local image with the candidate source
mounted read-only and parse the generated findings into the trust report. If
Docker or the pinned image is absent, the detector reports an explicit skip. The
sandbox smoke stage and SkillSpector detector additionally require the local
image digest to match the built-in controlled digest or a reviewed
`trust.skillspector.approvedDigests[]` policy entry before they will run.
An unavailable sandbox-smoke capability is therefore recorded as a skip at every
posture; a smoke run that starts and fails remains blocking.

The release vet runs the same image with `--network none`, `--read-only`, and
`--no-llm`. SkillSpector exit 1 means a completed scan found issues; aih accepts
it only when stdout is valid SARIF, records `skillspector@docker` as an analyzer
receipt, and keeps every mapped finding. Invalid SARIF, missing output, timeouts,
spawn failures, and other exit codes do not earn a receipt. Under the deliberate
no-egress policy, the exact SC4 static-fallback note is retained as an advisory
that dependency coverage may be incomplete. It does not suppress real SC4
vulnerability findings or any other detector result.

## YR4 Corepack Advisory Carve-Out

SkillSpector's `agent_skill_mcp_tool_poisoning_metadata` rule (mapped to `YR4`)
fires on almost every `package.json`: its schema anchor `any of ($schema_*)`
matches ubiquitous keys such as `"description":`, and its `$long_base64`
co-signal matches the 128-hex `sha512` in a Corepack `packageManager` integrity
suffix. `aih` downgrades that specific false positive to a non-blocking advisory
in `src/trust/detectors.ts` (`skillspectorAdvisory`) only when, after removing
the pinned Corepack integrity string, no other poisoning co-signal remains
(`hasSkillspectorYr4PoisoningSignal`).

For that downgrade to stay fail-closed, the co-signal check MUST detect at least
everything the rule's Gate-B branch detects — it may over-approximate toward
blocking, but must never under-approximate. The rule fires when
`any of ($schema_*)` **and** one of the Gate-B strings below match; each Gate-B
string maps to one anchored constant:

| Rule string (`agent_skills.yar`) | Indicator class | Co-signal constant | Relationship |
| --- | --- | --- | --- |
| `$hidden_html` | HTML comment hiding SYSTEM/IGNORE/OVERRIDE/DEVELOPER/ASSISTANT | `SKILLSPECTOR_YR4_HIDDEN_HTML` | identical |
| `$hidden_markdown` | `[//]: #` markdown comment, same keywords | `SKILLSPECTOR_YR4_HIDDEN_MARKDOWN` | identical |
| `$data_uri` | `data:text/…;base64,` URI | `SKILLSPECTOR_YR4_DATA_URI` | identical |
| `$long_base64` | ≥120-char opaque base64 run (the Corepack hash trips this) | `SKILLSPECTOR_YR4_LONG_OPAQUE` | identical |
| `$param_injection` | `(parameter\|argument\|description)` near an injection payload | `SKILLSPECTOR_YR4_PARAMETER_INJECTION` | superset (see note) |
| `$zero_width_*` + `$rtl_*` (U+200B–U+200D, U+202D, U+202E) | zero-width / RTL-override controls | `SKILLSPECTOR_YR4_DIRECTIONAL_CONTROL` | identical (all five code points) |

The `$schema_*` anchor is deliberately **not** modeled as a co-signal: it is the
broad, benign half of the rule (it matches benign `"description":` / `"tools":`
keys and is precisely why the rule false-positives), so treating it as a
poisoning signal would make the carve-out reject legitimate manifests. The
shipped ECC and Superpowers baseline manifests exercise this: both carry a
benign `"description"` mentioning agents/MCP/tools, and ECC additionally carries
the Corepack `sha512` suffix, so both remain advisory/installable.

Note on `$param_injection`: YARA's `.` matches every byte except `\n`, so it
spans a bare `\r` / U+2028 / U+2029; JavaScript's `.` does not. The constant
therefore uses `[\s\S]{0,160}` so a payload separated from its anchor by a lone
CR — legal `package.json` whitespace that still matches the pinned rule — cannot
slip past the co-signal and win the advisory. Every other constant is the rule
string byte-for-byte, with `nocase` expressed as the `i` flag.

**Re-verify on pin bump.** This mapping is proven against SkillSpector revision
`2d198ab910add401cad658d1087e7c7ba24fd640`. Whenever `SKILLSPECTOR_SOURCE_REVISION`
(`src/trust/images.ts`) changes, re-read
`src/skillspector/yara_rules/agent_skills.yar` and re-derive this table: any new
or altered Gate-B string in `agent_skill_mcp_tool_poisoning_metadata` must be
mirrored in `hasSkillspectorYr4PoisoningSignal`, and `tests/trust/scan.test.ts`
carries one blocking-case regression per indicator class.

## Review Expectations

- Treat a missing SkillSpector run as a skip, not a pass.
- For release baseline generation, treat that missing run as a blocking missing
  receipt rather than shipping scanner-free authorization.
- Treat RED or HIGH findings as blockers until reviewed by the security reviewer.
- Record the image tag, digest, source revision, and review reason in policy
  when a local digest differs from the controlled digest.
- Rebuild the image after any upstream pin change and review the upstream diff
  before accepting new results.
