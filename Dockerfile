FROM python:3.13-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Hermes v0.21.5 (release v2026.9.24). Pin source and use its dependency lock.
ARG HERMES_COMMIT=f97608f178d1ffeca59860195ab7da295f7c8e5f
RUN git init /opt/hermes \
    && cd /opt/hermes \
    && git remote add origin https://github.com/nousresearch/hermes-agent.git \
    && git fetch --depth 1 origin "$HERMES_COMMIT" \
    && git checkout --detach FETCH_HEAD

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
RUN cd /opt/hermes && uv sync --frozen --no-dev --python /usr/local/bin/python3

ENV PATH="/opt/hermes/.venv/bin:$PATH"
WORKDIR /workspace
CMD ["sleep", "infinity"]
