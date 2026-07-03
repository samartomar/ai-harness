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

## Build the Local Image

```bash
git clone https://github.com/NVIDIA/SkillSpector.git
cd SkillSpector
git checkout 326a2b489411a20ed742ff13701be39ba00063c8
docker build -t skillspector:aih-326a2b489411 .
```

If your org mirrors third-party tools, build the same commit from the mirror and
apply the same local tag. Do not retag a newer checkout to this name; update the
tag suffix and review the diff instead.

## How `aih` Uses It

`aih trust scan` and skill vetting call the local image with the candidate source
mounted read-only and parse the generated findings into the trust report. If
Docker or the pinned image is absent, the detector reports an explicit skip.

## Review Expectations

- Treat a missing SkillSpector run as a skip, not a pass.
- Treat RED or HIGH findings as blockers until reviewed by the security reviewer.
- Record the image tag and analyzer result in the PR or issue when a skill gate
  depends on SkillSpector.
- Rebuild the image after any upstream pin change and review the upstream diff
  before accepting new results.
