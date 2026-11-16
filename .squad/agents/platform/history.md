# Platform History

## Project Context

- Requested by Stephen Long; approved November 16, 2026.
- Stack: Docker/Compose, Node, Cloudflare Workers, GitHub Actions and GHCR around the React/Hono application.
- Ownership: reproducible packaging, accepted-image provenance, CI and recovery.

## 2026-11-16: Delivered Release Baseline

- `3d347979` introduced immutable mounted-library deployment and gated GHCR publication.
- Preserve read-only ROM/BIOS binds, independently writable app data, runtime ownership and the documented Compose deployment shape.
- Source/build acceptance precedes immutable candidate publication, fresh-runner registry-digest acceptance and promotion. Anonymous public-image verification is separate.
- Historical `490bc49e` runs `43342915252`, `43343670420` and `43344499884` succeeded.
- Historical accepted digest: `sha256:0d091b6680db913bc850ac51b5e475db751f377363a3e5c7ceb33f0818750b99`.
- Retained acceptance artifact metadata was reviewed, not archive contents; transient image-transfer artifacts are not the recovery source.
- The delivered image targets `linux/amd64`. Workers type generation is not deployed Workers acceptance.

Primary inputs: `Dockerfile`, `deploy/compose.yaml`, `deploy/README.md`, `.github/workflows/test.yaml`, `.github/workflows/verify-published.yaml` and the Docker acceptance harness.

Do not use live collection/app data for tests, run another instance against a live database, create `/dev/shm` workspaces or diagnose shared-host storage without evidence. Do not deploy or publish extra architectures without authorization.

Team persistence uses local state and `stlong/` PR branches targeting `main`. Preserve requested histories and exclude secrets, private transcripts, runtime caches and unrelated editor settings.
