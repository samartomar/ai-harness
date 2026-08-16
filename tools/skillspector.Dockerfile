ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b

FROM ${PYTHON_IMAGE} AS builder

ARG SOURCE_DATE_EPOCH=1785167267
# UV_EXCLUDE_NEWER is a pinned build input, not a convenience. `uv.lock` pins the
# runtime dependencies but not the PEP 517 backends that build the two packages
# compiled from source (forbiddenfruit, and skillspector itself). Without a date
# cutoff those backends resolve to whatever PyPI serves at build time, so a
# setuptools or hatchling release rewrites their .dist-info metadata and changes
# the image digest. This cutoff restores the resolution that produced the
# controlled digest, which is what makes that digest independently rebuildable.
# Moving it is a pin rotation: it changes the digest and requires a re-vet.
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    UV_NO_PROGRESS=1 \
    UV_EXCLUDE_NEWER=2026-08-07T00:00:00Z
WORKDIR /app
RUN pip install --no-cache-dir uv==0.12.2
COPY pyproject.toml uv.lock README.md ./
COPY src/ src/
RUN uv sync --frozen --no-dev --no-editable \
    && find .venv/lib/python3.12/site-packages \
      -path '*/skillspector-*.dist-info/uv_cache.json' -delete \
    && find .venv/lib/python3.12/site-packages \
      -path '*/skillspector-*.dist-info/RECORD' -delete \
    && tar --format=gnu --sort=name --hard-dereference \
      --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
      -cf /venv.tar .venv \
    && touch -d "@${SOURCE_DATE_EPOCH}" /venv.tar

FROM ${PYTHON_IMAGE}

ARG SOURCE_DATE_EPOCH=1785167267
LABEL org.opencontainers.image.revision="0562b964ec5ceac67ee15c163738e5404f14a908"
ENV PATH="/app/.venv/bin:$PATH" \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
RUN --mount=from=builder,source=/venv.tar,target=/tmp/venv.tar \
    mkdir -p /app \
    && tar -xf /tmp/venv.tar -C /app \
    && touch -d "@${SOURCE_DATE_EPOCH}" /app /tmp
WORKDIR /scan
ENTRYPOINT ["skillspector"]
