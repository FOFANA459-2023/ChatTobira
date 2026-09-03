# syntax=docker/dockerfile:1.7
#
# Ingestion pipeline: a reproducible Linux environment for the stages that
# cannot run reliably on the developer's Windows machine.
#
# This image is not decoration. render.py raises outright when LibreOffice is
# absent ("run ingestion on the Linux worker rather than on Windows"), so
# every .ppt/.pptx/.doc/.docx handout in the course is skipped locally and has
# never been ingested. Here they convert. The CJK fonts matter for the same
# reason: without them LibreOffice renders every Japanese glyph as a tofu box
# and the vision model faithfully transcribes a page of empty rectangles.

# ---------------------------------------------------------------------------
# base — system dependencies shared by every later stage
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS base

# Fail fast and loudly rather than half-running a 290-page job.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# --no-install-recommends keeps LibreOffice to the three converters actually
# used; the full metapackage pulls in ~1 GB of desktop we never start.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      libreoffice-impress \
      libreoffice-calc \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# deps — Python dependencies, cached independently of the source
# ---------------------------------------------------------------------------
FROM base AS deps

WORKDIR /app
# Only the manifest first: editing a .py file must not re-resolve every wheel.
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip \
    mkdir -p src/ingest && touch src/ingest/__init__.py && pip install .

# ---------------------------------------------------------------------------
# test — lint and unit tests, the CI gate
# ---------------------------------------------------------------------------
FROM deps AS test

WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -e . ruff pytest

# Japanese test data through a non-UTF-8 stdout is an encoding crash, not a
# test failure; pin it so a red build always means real breakage.
ENV PYTHONIOENCODING=utf-8
RUN ruff check . && ruff format --check . && python -m pytest tests -q

# ---------------------------------------------------------------------------
# runtime — the CLI itself
# ---------------------------------------------------------------------------
FROM base AS runtime

LABEL org.opencontainers.image.title="chattobira-ingest" \
      org.opencontainers.image.description="Vision ingestion pipeline for ChatTobira course materials" \
      org.opencontainers.image.source="https://github.com/FOFANA459-2023/ChatTobira" \
      org.opencontainers.image.licenses="UNLICENSED"

# Unprivileged: this process reads copyrighted course material and holds a
# database password. It has no reason to be able to write outside its own
# working directories.
RUN useradd --create-home --uid 10001 ingest

WORKDIR /app
COPY --from=deps /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin
COPY --chown=ingest:ingest . .

RUN pip install --no-deps -e . && chown -R ingest:ingest /app

# MATERIALS_ROOT and WORK_DIR are mounted, never copied: the course material
# is copyrighted and the work directory is hundreds of megabytes of derived
# page images. Both belong outside the image.
ENV MATERIALS_ROOT=/materials \
    WORK_DIR=/work \
    PYTHONIOENCODING=utf-8
RUN mkdir -p /materials /work && chown ingest:ingest /materials /work
VOLUME ["/materials", "/work"]

USER ingest

# tini reaps the LibreOffice child processes that conversion spawns; without
# an init the container accumulates zombies across a long batch run.
ENTRYPOINT ["/usr/bin/tini", "--", "ingest"]
CMD ["--help"]
