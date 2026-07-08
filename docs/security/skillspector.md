# SkillSpector Detector

> Status: optional local analyzer. It is advisory unless org policy lists
> `skillspector` in `trust.requiredDetectors` or `trust.requiredChecks`.

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
sha256:e82fd471e156ca5f431d5a1be18d37bc6bdf11f23b0f12f99c8899c12283fdfb
```

## Build the Local Image

```bash
git clone https://github.com/NVIDIA/SkillSpector.git
cd SkillSpector
git checkout 326a2b489411a20ed742ff13701be39ba00063c8
docker build \
  --label org.opencontainers.image.revision=326a2b489411a20ed742ff13701be39ba00063c8 \
  -t skillspector:aih-326a2b489411 .
```

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

## Review Expectations

- Treat a missing SkillSpector run as a skip, not a pass.
- Treat RED or HIGH findings as blockers until reviewed by the security reviewer.
- Record the image tag, digest, source revision, and review reason in policy
  when a local digest differs from the controlled digest.
- Rebuild the image after any upstream pin change and review the upstream diff
  before accepting new results.
