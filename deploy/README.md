# Mounted-library Docker deployment

The [long2know/retroassembly fork](https://github.com/long2know/retroassembly) publishes
**`ghcr.io/long2know/retroassembly:latest`**. Omitting the tag also selects `latest`.
Use the [ready-to-copy compose.yaml](compose.yaml); no local source build, archive import,
DockerHub credentials, or task-specific tooling is required. Builds run on GitHub-hosted
Ubuntu runners. The published platform is **linux/amd64**.

The sample uses `pull_policy: always`, the `retroassembly` service/container name,
`restart: unless-stopped`, UID/GID `1000:1000`, host port `8910` → container port `8000`,
and `${DOCKER_DATA}/retroassembly/data` → writable `/app/data`.

Before deploying, back up your existing app data and ensure it is writable by the selected UID/GID.
The ROM and BIOS directories must already exist and be readable by that user. Nothing automatically
creates these bind sources, changes their ownership, or mounts existing native saves/storage.
Do not run a second instance against a live app-data directory.

```sh
# Save deploy/compose.yaml in your deployment directory as compose.yaml.
curl --fail --location --output compose.yaml \
  https://raw.githubusercontent.com/long2know/retroassembly/main/deploy/compose.yaml
export DOCKER_DATA=/your/application-data-parent
# For a new installation only; do not alter an existing collection or app-data ownership blindly.
mkdir -p "$DOCKER_DATA/retroassembly/data"
docker compose --env-file /dev/null -f compose.yaml config
docker compose --env-file /dev/null -f compose.yaml pull
docker compose --env-file /dev/null -f compose.yaml up -d --no-build
```

The long bind syntax enforces `read_only: true` for `/app/roms` and `/app/bios`, and
`create_host_path: false` for all three binds. Docker therefore rejects writes to ROM/BIOS
even if application code attempts them. `/app/data` remains writable for SQLite, metadata,
artwork, and new saves/states. PUID/PGID alone do not repair filesystem permissions;
the Compose `user` setting selects the process UID/GID.

## Runtime configuration

These are all variables exposed by the sample Compose. Override them with exported
variables before `docker compose` runs. `--env-file /dev/null` avoids accidentally loading
a live `.env`; credentials and personal configuration must never be committed.

| Variable                                             | Default                                    |
| ---------------------------------------------------- | ------------------------------------------ |
| `DOCKER_DATA`                                        | Required; your application-data parent     |
| `RETROASSEMBLY_IMAGE`                                | `ghcr.io/long2know/retroassembly:latest`   |
| `PUID`, `PGID`                                       | `1000`, `1000`                             |
| `RETROASSEMBLY_HTTP_PORT`                            | `8910`                                     |
| `RETROASSEMBLY_ROM_SOURCE`                           | `/mnt/emu/Emulation/roms`                  |
| `RETROASSEMBLY_BIOS_SOURCE`                          | `/mnt/emu/Emulation/bios`                  |
| `RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY`   | `true`                                     |
| `RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY`         | `true`                                     |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY`        | `/app/roms`                                |
| `RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY`       | `/app/bios`                                |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL`    | Initial default: `300` seconds; `0` means manual-only |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED` | `true`; `false` is a hard provider-network disable |
| `RETROASSEMBLY_RUN_TIME_DATA_DIRECTORY`              | `/app/data`                                |
| `RETROASSEMBLY_RUN_TIME_STORAGE_DIRECTORY`           | `/app/data/storage`                        |

Keep the internal directory overrides aligned with their mounts. Writable data/storage
must not overlap the immutable source directories; invalid configurations fail closed.
Enrichment is best-effort and requires provider connectivity. Browser emulator cores are
downloaded from upstream's pinned CDN URLs; this image is not a fully offline emulator bundle.

## ROM indexing and metadata controls

Open **Settings → Library → Enabled Platforms** to see counts from the existing index,
including platforms currently disabled in your preferences. **Enable platforms with ROMs**
explicitly selects platforms with indexed entries; merely opening settings never changes
that selection or scans the source. **Hide empty platforms** changes the view only.

The mounted-only **Settings → ROM / Metadata** tab separates these actions:

- **Scan ROM folders** reconciles filenames and source availability. Unchanged paths retain
  their ROM IDs, private save/history associations, manual metadata and app-owned artwork.
- **Refresh metadata** explicitly retries identification with the existing upstream providers,
  reusing cached content hashes when the source revision has not changed.
- **Retry missing covers** is separate from identification. A missing provider image is not a
  broken ROM; expected HTTP 404 responses are recorded as missing artwork, not success.
- **Automatic metadata and cover downloads** controls background enrichment and browser-side
  remote artwork fallbacks. Turn it off for cached-only browsing; stored/manual artwork still
  renders, and explicit refresh/retry remains available when network policy permits.
- **Scan interval (seconds)** persists in app data; `0` means manual-only scanning. The Compose
  interval is the initial default, not an instruction to erase saved settings on restart.

Settings, source-revision/hash caches, identification outcomes and downloaded artwork live
under writable `/app/data`, never in the read-only collection. Turning automatic downloads
off does not delete cached artwork or reset the database. The environment variable
`RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED=false` is a separate hard ceiling:
automatic and explicit provider requests are disabled, regardless of the saved switch.
Emulator core downloads are separate from metadata policy; this is not a fully offline bundle.

Matching uses the existing upstream identification service and content MD5 where it is safe
to identify one supported payload (including a single-ROM ZIP). Filename matching remains a
fallback, not proof of content identity. Ambiguous archives, multi-file sets, hacks and
variants may remain unmatched or have no cover; no universal matching, source conversion,
renaming, or new emulator/core support is promised. See [the detailed behavior and limits](../docs/mounted-library.md).

## Pull, update and rollback

Before updating, stop the app and back up **app-owned data** consistently (including SQLite).
Keep the previous image digest and the matching data backup; schema migrations may prevent
an older image from using newer data. Never modify ROM/BIOS/native-save directories as part
of an application update.

```sh
export DOCKER_DATA=/your/application-data-parent
# Record the running image and its registry digest before updating.
docker inspect retroassembly --format '{{.Config.Image}} {{.Image}}'
docker image inspect "$(docker inspect retroassembly --format '{{.Image}}')" \
  --format '{{json .RepoDigests}}'
docker compose --env-file /dev/null -f compose.yaml stop
# Back up "$DOCKER_DATA/retroassembly/data" here using your existing backup procedure.
docker compose --env-file /dev/null -f compose.yaml pull
docker compose --env-file /dev/null -f compose.yaml up -d --no-build
docker compose --env-file /dev/null -f compose.yaml logs --tail=100 retroassembly
```

Each published commit also has `ghcr.io/long2know/retroassembly:sha-<full-commit>`.
For reproducible deployment or rollback, prefer its immutable `sha256` digest from the
successful Actions summary:

```sh
export RETROASSEMBLY_IMAGE=ghcr.io/long2know/retroassembly@sha256:REPLACE_WITH_VERIFIED_DIGEST
# Stop and restore the corresponding app-data backup first if rolling back a migration.
docker compose --env-file /dev/null -f compose.yaml pull
docker compose --env-file /dev/null -f compose.yaml up -d --no-build
```

Unset `RETROASSEMBLY_IMAGE` to return to the default `latest`. No feature-specific public
image tag is used. Digest pinning does not replace app-data backups.

## GitHub-hosted builds and publication

The repository includes both workflows; there are no hidden local build prerequisites:

- [Verify and publish](../.github/workflows/test.yaml) runs on pushes to `main` or `stlong/**`,
  PRs targeting this fork's `main`, and manual dispatch.
- [Verify public image](../.github/workflows/verify-published.yaml) is a manual, read-only
  anonymous-registry and real-browser recovery check.

The first workflow restores **Node 26.12.1** and **pnpm 12.11.2**, installs the frozen lockfile,
generates the ignored Worker/Router declarations, runs the unit suite, and checks formatting,
lint and types with zero warnings. It builds the production Dockerfile for `linux/amd64`,
including the original MIT license and readable/traversable files for UID 1000.
The Dockerfile also uses frozen installs.

The built image must pass real mounted-library Docker/browser acceptance, and the gate must
reject an intentionally writable synthetic ROM bind. Only trusted `main` push/manual runs
can pass that exact accepted image through a checksum-verified Actions artifact to a
`packages: write` publication job. PR code never receives package-write permission.
The SHA-tagged candidate is then pulled by digest onto a fresh runner using
`packages: read`, its image ID and source/revision/MIT OCI labels are checked, and the same
browser/read-only/persistence test runs again. Only then is the unchanged manifest promoted
to `latest`. Promotion refuses stale source revisions; commit tags must not be overwritten.

GHCR authentication uses Actions' short-lived `GITHUB_TOKEN` only. No PAT, DockerHub secret,
host daemon changes, or local dependency/browser installation is needed.
Public source does **not** make a newly created GHCR package public automatically. If the
publication report says private, the package owner must open
[package settings](https://github.com/users/long2know/packages/container/retroassembly/settings),
choose **Change visibility → Public**, and confirm. Authenticated runner acceptance and
anonymous access are reported separately. Anonymous manifest and pull success—not the source
repository's visibility—prove public availability.

### Build from source without building on the deployment computer

To develop, clone the native fork and use `stlong/` feature branches:

```sh
git clone https://github.com/long2know/retroassembly.git
cd retroassembly
git remote add upstream https://github.com/arianrhodsandlot/retroassembly.git
git switch -c stlong/your-change
# Edit source, stage specific intended files, and commit.
git push --set-upstream origin stlong/your-change
```

That push runs source checks and the Docker/browser gate on GitHub, without publishing.
Review and merge into **this fork's** `main` to publish a new image. To trigger the workflow
manually, use the Actions tab's **Verify and publish → Run workflow**, or:

```sh
gh workflow run test.yaml --repo long2know/retroassembly --ref main
gh run list --repo long2know/retroassembly --workflow test.yaml --limit 5
gh run watch RUN_ID --repo long2know/retroassembly --exit-status
```

Publication of a SHA tag is one-time. For a transient failure after the candidate was pushed,
rerun only the failed downstream jobs; do not rerun an already-published commit's entire
build to replace its tag. Use a new reviewed source commit for a new build.
Actions run summaries record the commit tag and registry digest; acceptance JSON artifacts
retain the actual image identity, mount flags, write failures, browser results and source
snapshots for 30 days. The source and GHCR digest remain the durable recovery references;
the temporary image-transfer artifact is retained for three days.

After making the package public, or to validate an existing rollback image anonymously:

```sh
gh workflow run verify-published.yaml --repo long2know/retroassembly --ref main \
  -f digest=sha256:REPLACE_WITH_VERIFIED_DIGEST \
  -f revision=REPLACE_WITH_FULL_SOURCE_COMMIT
gh run list --repo long2know/retroassembly --workflow verify-published.yaml --limit 5
gh run watch RUN_ID --repo long2know/retroassembly --exit-status
```

This workflow requests no package token, verifies anonymous SHA-tag/digest manifests, pulls
with an empty Docker credential configuration, checks source labels, and exercises the
pulled image with the real browser fixture. It never uses the real deployment mounts.

### Merge upstream safely

Keep `origin` pointing at `long2know/retroassembly` and `upstream` pointing at
`arianrhodsandlot/retroassembly`. Preserve the native fork relationship and merge history:

```sh
git fetch origin
git fetch upstream
git switch -c stlong/upstream-merge origin/main
git merge --no-ff upstream/main
# Resolve conflicts, retaining this fork's mounted-library code, migration,
# GHCR workflows, deployment contracts, tests, and upstream license notices.
git push --set-upstream origin stlong/upstream-merge
gh pr create --repo long2know/retroassembly --base main --head stlong/upstream-merge \
  --title "Merge upstream updates" --body "Preserve mounted-library support and verify hosted gates."
```

Review the changes and require the hosted checks before merging into the fork's `main`.
Do not use forced sync, reset, force-push, or a fresh unrelated history to make the fork
match upstream; those can erase the preserved application changes. Never target the
upstream repository with the fork's maintenance PR.

## Supported sources and limitations

The top-level ROM folders identify platforms, including implemented ES-DE aliases
such as `famicom` → `nes`, `megadrive` → `genesis`, and `ps1` → `psx`.
Games can be nested beneath those folders. Only upstream-supported browser platforms and
file extensions are launchable. CUE/M3U/multifile disc dependencies are not resolved;
PlayStation currently requires a standalone supported CHD. The app does not convert,
move, rename, delete, or repair source files. Symlinks and source escapes are rejected.

BIOS discovery uses upstream expected filenames, and expected MD5 checksums where supplied.
Discovery does not prove that arbitrary bytes are valid firmware. Existing native saves,
save states, and mixed emulator storage are deliberately not imported or mounted by default.
Game/core/controller/browser compatibility is not universal.

## Source checks used by hosted CI

The GitHub runner uses Node 26.12.1 and the pnpm version pinned in `package.json`.
The existing esbuild dependency
bundles unit tests before native `node --test`, because upstream's metadata SDK exports
TypeScript-only dependency files that Node cannot strip inside `node_modules`.

```sh
pnpm install --frozen-lockfile
node --input-type=module -e "import {prepareWranglerConfig} from './scripts/utils.ts'; await prepareWranglerConfig({force:true})"
WRANGLER_SEND_METRICS=false pnpm exec wrangler types src/types/worker-configuration.d.ts
pnpm exec react-router typegen
pnpm test:unit
pnpm vp check --fix
```

Generated Worker and Router types are build prerequisites, not hand-written declarations.
CI rejects warnings and formatting changes, then the Dockerfile builds the application.
Its build-time permission normalization never changes host ROM/BIOS mounts.

## Reproducible isolated acceptance

The hosted workflows install Playwright Chromium and invoke the existing test against
the already-built image or the exact registry digest:

```sh
pnpm exec playwright install --with-deps chromium
RETROASSEMBLY_MOUNTED_TEST_BROWSER=chromium \
RETROASSEMBLY_MOUNTED_TEST_IMAGE=ghcr.io/long2know/retroassembly@sha256:REPLACE_WITH_VERIFIED_DIGEST \
node tests/e2e/mounted-library-docker.ts
```

This focused extension of the existing Playwright suite creates its own original NES
homebrew, synthetic BIOS/palette bytes, and a controlled metadata HTTP fixture. It uses uniquely named containers and a fresh
data volume, UID 1000:1000, real read-only bind mounts, and a dynamic loopback port.
It never uses the deployment container name, port 8910, real collections, or live app data.
It checks bytes, Docker mount flags, `EROFS`, browser WASM/core loading and changing
emulated frames, app-owned metadata/state persistence across two restarts, invalid paths,
and source names/hashes/mtimes/modes. Only its own containers, volume, and generated fixture
directory are removed. A JSON report is written under `node_modules/.cache/` by default;
set `RETROASSEMBLY_MOUNTED_TEST_REPORT` to retain it elsewhere.

The helper defaults to installed Chrome outside CI and to an already-pulled
`ghcr.io/long2know/retroassembly:latest` image. `RETROASSEMBLY_MOUNTED_TEST_BROWSER=chromium`
selects installed Playwright Chromium.
`RETROASSEMBLY_MOUNTED_TEST_IMAGE` selects an already-available image or pulled digest.
For a gate self-test, set `RETROASSEMBLY_MOUNTED_TEST_MUTATION=rw-rom-bind`: this changes
only the generated fixture bind and must fail its Docker `RW: false` assertion.

The tested fixture is original legal NES homebrew with the `fceumm` browser core and
synthetic `nes.pal` bytes, not a claim that arbitrary BIOS bytes are valid firmware.
Real WASM loading, changing frames, saved-state resume, metadata/art/private-state
persistence, two restarts, UID 1000, read-only bind enforcement and unchanged source
names/bytes/modes/mtimes are required. Threaded/cross-origin-isolated cores, every browser
and controller, other platforms, and real provider availability are not established by
this focused gate.
