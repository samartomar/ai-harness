# SkillSpector Detector

> Status: optional for ordinary local trust scans unless org policy requires it;
> mandatory for generating and releasing the shipped baseline evidence lock.

`aih` invokes SkillSpector through a pinned local Docker image tag:

```text
skillspector:aih-326a2b489411
```

The tag corresponds to NVIDIA/SkillSpector commit:

```text
326a2b489411a20ed742ff13701be39ba00063c8
```

`aih` treats the local image as verified when Docker reports either the built-in
controlled build digest or an org-policy approved local digest:

```text
sha256:ee8a107dfd1c258e0afed303016a4220d174ba54bd1510bf73ed91f2825075ec
```

## Build the Local Image

```bash
AIH_ROOT="$PWD"
VET_ROOT="$(mktemp -d)"
git clone https://github.com/NVIDIA/SkillSpector.git "$VET_ROOT/SkillSpector"
git -C "$VET_ROOT/SkillSpector" checkout --detach \
  326a2b489411a20ed742ff13701be39ba00063c8
docker build \
  --provenance=false \
  --build-arg SOURCE_DATE_EPOCH=1782883813 \
  -f "$AIH_ROOT/tools/skillspector.Dockerfile" \
  -t skillspector:aih-326a2b489411 \
  "$VET_ROOT/SkillSpector"
```

The harness-owned Dockerfile consumes the upstream commit's checked-in
`uv.lock`, pins its Python base by digest, removes two path-bearing wheel-cache
metadata files, and canonicalizes the virtual environment before the final
networkless runtime image is created. Two clean cache-disabled builds must
produce the controlled digest above before it changes.

If your org mirrors third-party tools, build the same commit from the mirror and
apply the same local tag. Local Docker builds can produce an image ID different
from the controlled digest above, so compare the image ID before deciding which
path to use:

```bash
docker image inspect skillspector:aih-326a2b489411 --format '{{.Id}}'
```

If the image ID matches the controlled digest, no local policy approval is
needed. If it differs, record an explicit local digest approval after reviewing
the build inputs:

```bash
aih trust skillspector-pin \
  --candidate-revision 326a2b489411a20ed742ff13701be39ba00063c8 \
  --candidate-tag skillspector:aih-326a2b489411 \
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
`326a2b489411a20ed742ff13701be39ba00063c8`. Whenever `SKILLSPECTOR_SOURCE_REVISION`
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
