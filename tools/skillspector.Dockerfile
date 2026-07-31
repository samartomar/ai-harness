ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b

FROM ${PYTHON_IMAGE} AS builder

ARG SOURCE_DATE_EPOCH=1785167267
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    UV_NO_PROGRESS=1
WORKDIR /app
RUN pip install --no-cache-dir uv==0.12.0
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
LABEL org.opencontainers.image.revision="34f60308522f45447cd343da0aad77bcea308ad4"
ENV PATH="/app/.venv/bin:$PATH" \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
RUN --mount=from=builder,source=/venv.tar,target=/tmp/venv.tar \
    mkdir -p /app \
    && tar -xf /tmp/venv.tar -C /app \
    && touch -d "@${SOURCE_DATE_EPOCH}" /app /tmp
WORKDIR /scan
ENTRYPOINT ["skillspector"]
