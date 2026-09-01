# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal automation repo with no application code and no local build/test system. It builds tools from source inside containerized environments via GitHub Actions, publishes the results as images to `docker.io/nqminhuit/*`, and the owner later pulls an image with **podman** (not docker) and copies the binary out to the local machine. All work happens in `.github/workflows/` and `containers/`.

## Commands

There is nothing to build, lint, or test locally. Everything runs through manually dispatched workflows:

```sh
# Trigger a build (all tool workflows are workflow_dispatch with version inputs)
gh workflow run tmux.yml -f version=3.7c -f debian_version=13

# Test a Containerfile locally before pushing
podman build --build-arg DEBIAN_VERSION=13 --build-arg VERSION=<git-tag> \
  -f containers/Containerfile-<name> -t <name>:<version>

# Extract a binary from a published image (the end-use pattern)
cid=$(podman create docker.io/nqminhuit/<name>:<version> /bin/true)
podman cp "$cid:/" <dest>
```

## Architecture

**Container build pipeline** (the core pattern):
1. `containers/Containerfile-debian-base` / `-ubuntu-base` define fat build environments (build-essential, gcc-14, autotools, cmake, rustup, and the dev libraries every tool needs). Built by `debian-base-image.yml` / `ubuntu-base-image.yml` — the debian one also rebuilds weekly on cron with `--no-cache` — and pushed as `nqminhuit/debian-base:<version>` etc.
2. Each tool has a multi-stage `containers/Containerfile-<name>`: stage 0 starts `FROM docker.io/nqminhuit/debian-base:$DEBIAN_VERSION`, does `git clone --depth 1 -b $VERSION <upstream>` and compiles; the final stage is `FROM scratch` containing only the built binary. So published tool images are just binary carriers, not runnable environments.
3. `build-and-push-container.yml` is a reusable `workflow_call` workflow (inputs: `name`, `version`, `debian_version`, `extra_build_args`; secrets: `DOCKER_IO_USERNAME`/`DOCKER_IO_TOKEN`). The `name` input must match `containers/Containerfile-<name>`. Tool workflows (`tmux.yml`, `ripgrep-container.yml`, `fd-container.yml`) are thin wrappers around it; when adding a new containerized tool, follow this wrapper pattern rather than writing podman steps inline.
4. Emacs is the exception: `emacs.yml` runs a matrix over OS bases (ubuntu 24.04/26.04, debian 13) × window systems (x11, wayland), building `Containerfile-emacs.base` first (clones emacs + tree-sitter) and then `Containerfile-emacs-<ws>` on top of the local `emacs-base` image, tagging as `<version>-<osbase>-<window_system>`. It installs to a `--prefix` and copies the whole install tree, not a single binary.

**Runner-native binary builds:** `ripgrep.yml` and `fd.yml` skip containers entirely — they check out the upstream repo directly on an `ubuntu-<version>` runner, `cargo build --release`, and upload the binary as a workflow artifact (`archive: false`).

**TTS workflows** (`sec10v.yml`, `sec10v_maya1.yml`, `sec10v_test_voices.yml`, `omnivoice.yml`): check out the private repo `nqminhuit/sec10v` (via `SEC10V_ACCESS_TOKEN`) and run its Python TTS scripts on CPU-only torch, uploading mp3 artifacts with 1-day retention. `sec10v.yml` verifies output by building whisper.cpp, transcribing the generated audio, and comparing against the input text with a Levenshtein script, retrying generation once on failure. `omnivoice.yml` additionally triggers on **push to `text/omnivoice.txt`** — editing that file kicks off audiobook generation of its contents; it uses `HF_TOKEN`.

**One-off utility workflows:** `oci-retry-create.yml` (cron every 4h; loops inside the job retrying OCI free-tier ARM instance creation every 5 min, alternating shapes, and disables itself via `GH_PAT` once the instance exists — comments are in Vietnamese), `seed.yml` (download a URL to an artifact), `se.yml` (Standard Ebooks build), `conversations.yml` (Conversations Android APK).

## Conventions

- Version inputs are upstream git tags, passed verbatim to `git clone -b $VERSION`; keep each tool workflow's `default:` current when bumping versions.
- Images push to `docker.io/nqminhuit/` with `podman push --creds`; secrets used across workflows: `DOCKER_IO_USERNAME`, `DOCKER_IO_TOKEN`, `SEC10V_ACCESS_TOKEN`, `HF_TOKEN`, `TOOLS_DIR`, `GH_PAT`, and the `OCI_*` set.
- Workflow artifacts consistently use `upload-artifact` with `archive: false` and `if-no-files-found: error`.
