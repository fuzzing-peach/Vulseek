# Issue #11 Plan: GHCR Release Image and Docker Cleanup

## Goal

Use GitHub Actions to build the release Docker image for Vulseek/Dokploy, publish it to GitHub Container Registry, and separate local development from release usage so local release builds are no longer required.

## User decisions

- Default release image tag must be `latest`.
- Only `linux/amd64` needs to be built and published.
- Keep `dev.sh`.
- Add `run.sh` as the local release environment entrypoint; it must pull the release image from GHCR and must not build the release image locally.
- Keep `Dockerfile.server`, `Dockerfile.schedule`, and `Dockerfile.monitoring`.
- Delete `apps/dokploy/docker/build.sh` during implementation.
- Delete `apps/dokploy/docker/push.sh` during implementation.
- Delete `apps/dokploy/docker/feat.sh` during implementation.
- The plan must explicitly audit existing Dockerfiles and shell scripts, then identify what to keep or remove.

## Current Docker/Script Inventory

- `Dockerfile`: main production image build; current release path.
- `Dockerfile.dev`: local development image used by `dev.sh` and `docker-compose.dev.yml`.
- `Dockerfile.cloud`: obsolete alternate production-style image with no in-repo references; delete.
- `Dockerfile.server`, `Dockerfile.schedule`, `Dockerfile.monitoring`: keep these service-specific images; they are out of scope for deletion in issue #11.
- `docker-compose.dev.yml`: local container-based dev stack using `Dockerfile.dev`.
- `dev.sh`: keep this local Swarm-based dev workflow; it currently builds `dokploy-dev:latest` locally.
- `run.sh`: add this release workflow script; it should pull and run the GHCR release image, defaulting to the `latest` tag.
- `apps/dokploy/docker/build.sh`: obsolete Docker Hub-oriented multi-arch build helper; delete.
- `apps/dokploy/docker/push.sh`: obsolete Docker Hub-oriented multi-arch push helper; delete.
- `apps/dokploy/docker/feat.sh`: obsolete ad hoc helper; delete.
- `.github/workflows/`: no workflows currently exist, so CI publishing must be added from scratch.

## Proposed cleanup

- Keep `Dockerfile` as the single source for the main release image.
- Keep `Dockerfile.dev`, `docker-compose.dev.yml`, and `dev.sh` for local development, but update release references so dev stays local while release pulls from GHCR.
- Add `run.sh` for local release startup. It should pull `ghcr.io/<owner>/<image>:latest` by default, start the release app with the required Postgres/Redis/Traefik/network/volume setup, and support practical commands such as `pull`, `start`, `stop`, `restart`, `logs`, and `ps`.
- Keep `Dockerfile.server`, `Dockerfile.schedule`, and `Dockerfile.monitoring`.
- Delete `apps/dokploy/docker/build.sh`, `apps/dokploy/docker/push.sh`, and `apps/dokploy/docker/feat.sh` because they are Docker Hub-specific or obsolete and should not remain alongside the new GHCR workflow.
- Delete `Dockerfile.cloud` because it has no in-repo references and would otherwise compete with `Dockerfile` as a second production image path.

## Implementation steps

1. Add a GitHub Actions workflow under `.github/workflows/` that triggers on release-related pushes/manual dispatch, logs in to `ghcr.io`, and builds `Dockerfile` for `linux/amd64` only.
2. Tag release images as `ghcr.io/<owner>/<image>:latest` by default, and optionally add immutable tags such as version or commit SHA for traceability.
3. Use GitHub-native metadata and cache configuration (`docker/metadata-action`, `docker/build-push-action`) so CI replaces the current manual `buildx` publish path.
4. Add `run.sh` as the local release script. It should pull the GHCR image, default to the `latest` tag, avoid local release builds, and expose common commands for operating the release environment locally.
5. Update release documentation/scripts so “release” startup uses `run.sh` and pulls from GHCR instead of building locally.
6. Update local dev scripts so `dev.sh` continues building `Dockerfile.dev` locally and remains clearly separate from the release flow.
7. Delete `apps/dokploy/docker/build.sh`, `apps/dokploy/docker/push.sh`, and `apps/dokploy/docker/feat.sh` during implementation, and remove any references to those obsolete Docker Hub-oriented helpers.
8. Delete `Dockerfile.cloud` after confirming it has no in-repo references.
9. Document the new release process in contributor/deployment docs, including required GitHub secrets/permissions and the expected default image name/tag.

## Validation checklist

- GitHub Actions workflow exists and can build/push `Dockerfile` to GHCR.
- Published release image defaults to the `latest` tag.
- Workflow publishes `linux/amd64` only; no `arm64` build remains in CI or release scripts.
- Local dev still works through `Dockerfile.dev` plus `dev.sh`/`docker-compose.dev.yml`.
- `run.sh` exists and starts the local release environment by pulling the GHCR `latest` image without building it locally.
- Release scripts/docs no longer require local release image builds and clearly distinguish `dev.sh` from `run.sh`.
- `apps/dokploy/docker/build.sh`, `apps/dokploy/docker/push.sh`, and `apps/dokploy/docker/feat.sh` are gone.
- `Dockerfile.cloud` is gone.
- `dev.sh`, `Dockerfile.server`, `Dockerfile.schedule`, and `Dockerfile.monitoring` remain in place.

## Questions for user confirmation

No user confirmation needed before implementation.
