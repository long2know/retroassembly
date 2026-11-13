# Mounted libraries (Node runtime)

This fork indexes an existing collection in place. Emulation still runs in the
browser using upstream Nostalgist/Libretro cores. It does not run desktop
emulators, stream video, download games/firmware, convert sources, or import
native saves.

## Runtime configuration

| Environment variable                                 | Default | Meaning                                                                                                                                              |
| ---------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY`   | `false` | Enable mounted sources in Node. Workers retain uploaded-library behavior.                                                                            |
| `RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY`         | `false` | Hide uploaded games and reject new ROM uploads while mounted sources are enabled.                                                                    |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY`        | empty   | Required absolute, existing ROM root when enabled.                                                                                                   |
| `RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY`       | empty   | Optional absolute, existing BIOS root.                                                                                                               |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL`    | `300`   | Initial seconds between completed scans (`0` to `86400`); `0` is manual-only after startup. Persisted app settings take precedence after first initialization.                                             |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED` | `true`  | Allow provider identification and cover caching. `false` disables automatic and explicit provider requests; manual metadata/art editing still works. |

Use read-only mounts for both sources. Writable data and storage roots retain
their upstream runtime settings and must be disjoint from each source, including
canonical/symlink-resolved paths. Explicit missing, unreadable, overlapping, or
invalid roots fail startup before database migrations/storage creation. Sources
are never created, renamed, chmodded, chowned, or written by the application.
Leave native saves/storage unmounted unless separately implementing their format
and ownership contracts.

The scanner recognizes existing upstream platforms case-insensitively, with
ES-DE aliases including `mastersystem` → `sms`, `megadrive`/`md` → `genesis`,
`famicom` → `nes`, `sfc` → `snes`, `ps1` → `psx`, and
`mame`/`mame2003`/`mame2003-plus`/`fbneo`/`neogeo` → `arcade`.
Arcade folder recognition does **not** validate ROM sets against a core version.
Unknown systems and unrelated sidecars are not imported.

Files are indexed recursively beneath system directories. Original relative
paths, case, punctuation, and Unicode are retained; equal basenames in distinct
directories remain separate games. Symlink entries are skipped, including
directory symlinks. Reads reject traversal, encoded escapes, and symlink escapes
and use opaque source IDs rather than accepting host paths.
Game links carry an opaque `rom_id` query parameter so identical relative names
in different aliased system directories cannot select the wrong game.

## Data, scans, and privacy

Mounted ROM rows have a nullable owner and an explicit `mountedSource` record;
there is no fabricated authentication account. All authenticated users can see
available mounted games, including users in upstream shared-library mode.
Favorites, launch history, and savestates remain per-user, including generic
file delivery for state/thumbnail bytes. New users automatically see indexed
platforms; explicitly saved platform filters are respected.

Shared titles/descriptions, manual matching, uploaded artwork, and hides are
app-wide metadata edits. Deleting a mounted game hides its database row for all
users; rescanning does not undo that hide and never unlinks the source.
Restoring an intentionally hidden row currently requires an app database
administrative operation; no restore UI is provided.

Scans are idempotent and coalesce concurrent requests. Only a complete,
successful enumeration reconciles missing files. An inaccessible/replaced root
or an incomplete traversal preserves previous rows and records an error.
Verified removals mark sources unavailable without deleting metadata or states.
Same-path replacement changes the revision, clears automatic identification/art,
and queues fresh enrichment. Explicit manual metadata survives rescans and
replacement. Existing savestates are not converted or guaranteed compatible with
replacement ROM bytes. Reads detect unscanned replacements and return `409`
until a rescan; unavailable/unsafe sources return `503`.

Authenticated API endpoints:

- `GET /api/v1/roms` and `GET /api/v1/roms/:id`: visible games/details.
- `GET /api/v1/roms/:id/content`: original ROM bytes.
- `GET /api/v1/files/:encodedFileId`: authorized ROM, BIOS, art, or private state
  bytes; encode the complete opaque file ID as one URL component.
- `GET /api/v1/mounted-library`: scan status, errors, BIOS warnings, persisted
  `settings: { automaticMetadata, scanIntervalSeconds }`, `networkAllowed`,
  effective `automaticMetadataEnabled`, `platforms: [{ platform, indexed,
  unsupported }]`, and metadata job progress (`running`, `operation`,
  `processed`, `total`, `errors`, timestamps, optional error). Counts come only
  from available, non-hidden indexed rows across all platforms; saved enabled
  platform choices do not filter these counts. Unsupported counts are not an
  emulator-readiness claim. This endpoint never walks or hashes source files.
- `PATCH /api/v1/mounted-library`: JSON `{ "automaticMetadata": false,
  "scanIntervalSeconds": 0 }` (either field may be omitted). Settings are
  application-wide and persist in SQLite across restarts. Scan intervals are
  integer seconds from `0` to `86400`; `0` disables periodic scans, not the
  startup reconciliation. Environment values seed new settings, not upgrades.
- `POST /api/v1/mounted-library`: reconcile source folders, preserving previous
  rows on partial or failed scans. This retains the existing no-body contract.
- `POST /api/v1/mounted-library/metadata`: JSON `{ "platform": "nes",
  "retryArtwork": false }` (both optional). Explicitly re-identify all available
  non-manual rows, including earlier misses and filename-only matches, using
  cached hashes for unchanged revisions. `retryArtwork` intentionally retries
  earlier artwork misses/errors; otherwise those negative results remain cached.
- `POST /api/v1/mounted-library/artwork`: JSON `{ "platform": "nes" }` (optional
  scope) retries artwork independently, without walking, hashing or requesting
  ROM identification again. Existing cached/custom art and manual rows remain
  untouched. Metadata/artwork jobs coalesce while one runs and return status
  immediately; poll GET for progress. Client-supplied filesystem paths and
  provider URLs are not accepted.
- `POST /api/v1/roms/:id/identify`: retry/match with JSON `{ "name": "Game name" }`,
  or a `launchboxId`/`libretroId`. Provider failures are persisted and retryable.
- Existing ROM `PATCH`, artwork, favorites, history, and state APIs also work
  with mounted rows under the same authorization checks.

Open a game’s metadata editor to change its name/details or search for a
corrected identification name. The media editor stores custom art in app
storage. Source bytes are immutable; app metadata is deliberately editable.

## BIOS and browser format boundaries

BIOS discovery recursively matches **only** filenames declared in upstream
platform requirements, case-insensitively. Matching files are supplied through
normal browser preferences under their exact core virtual names. Known upstream
MD5 requirements are verified before automatic selection; mismatches are logged
and listed in scan warnings. Files without a published checksum are
name-matched, not validated as working firmware. Discovery skips empty files and
files over 32 MiB. Synthetic fixtures prove byte routing only, never firmware
validity. Uploaded BIOS remains a fallback when a mounted match is unavailable
or the feature is disabled.

Supported standalone extensions remain the upstream platform lists (including
standalone PlayStation CHD). CUE/M3U/ISO and other recognized disc/playlist
formats appear with an explicit unsupported-format explanation and cannot be
launched. This initial fork does not load their track/playlist dependencies.
Archive/core/ROM-set compatibility is still the upstream browser runtime’s
responsibility; indexing a supported extension is not a compatibility guarantee.

## Metadata and covers

Identification uses the installed msleuth SDK and its existing platform-scoped
Libretro MD5 matching followed by ROM-name, No-Intro/GoodTools-aware filename,
and LaunchBox alternate-name matching. Normal cartridge files are hashed in
bounded chunks. Non-arcade ZIPs are inspected through a random-access reader;
only one safe, system-eligible cartridge payload is hashed, never compressed
archive bytes or an arbitrary first entry. Directories, documentation and macOS
resource forks are excluded. Atari cartridge and Mega Drive `.bin` payloads are
accepted according to their existing upstream cores. Arcade ZIPs remain complete
sets: no member is chosen as the game's content identity. Set/core compatibility
is not established by identification.

Inspection permits at most 100 MiB of source/payload data, 256 archive entries,
100 MiB total declared expansion, a 1000:1 expansion ratio and 4 MiB random-read
ranges. Actual streamed output is bounded and CRC-checked. Ambiguous multi-ROM,
unsafe-path, duplicate-path, encrypted or oversized ZIPs persist a precise error
without automatic provider guessing; an explicit manual name/ID match remains
possible. Oversized files, unsupported formats and disc containers (including
CHD) are filename-only: container hashes are not disc-track catalog hashes.
No universal header stripping, byte swapping, hack/overdump repair, disc
extraction, source conversion, core additions or credentials are introduced.
Exact identity depends on a provider catalog containing the same payload bytes.

`mountedSource.identification` persists algorithm version, source revision,
input name, selected payload name, MD5, size, hash timestamp and match confidence
in the app database. A content-confidence result requires the returned Libretro
MD5 to equal the submitted digest; otherwise matching is explicitly filename
confidence. Precise Libretro identity is retained even when a canonical base-game
name supplies artwork. Provider outcomes (`matched`, `no-match`, `error`) and
metadata/artwork timestamps persist separately. Cached negative outcomes and
unchanged hashes survive restart and explicit metadata refresh. Browsing,
settings counts and artwork-only retries do not walk or rehash disks. A successful
source rescan invalidates hashes only for changed fingerprints, including when
manual metadata itself is retained. Manual metadata, custom art, hidden flags,
ROM IDs, favorites, history and state associations are not replaced by bulk jobs.

Automatic enrichment runs separately from startup scanning and request handling,
sequentially with a pause between batches of 50. Metadata failures back off at
least five minutes before periodic automatic retries. Turning automatic lookup
off persists and prevents new automatic provider/cover work while preserving all
cached/manual data. Explicit metadata/artwork actions still work when automatic
lookup is off, unless the server environment network policy is disabled; that
hard ceiling returns `403` for explicit provider actions. The loader exposes the
same status snapshot as `mountedLibrary` for cached-only client initialization.
The server environment flag remains the network ceiling, not the UI preference.

Artwork first uses the provider's canonical Libretro name, then an available
canonical LaunchBox title, without blindly stripping meaningful title text.
An HTTP `404` persists `artwork: "missing"`, not a ROM-identification failure,
and is not retried automatically on browsing or rescans. Other HTTP failures,
timeouts and unsafe image responses persist `artwork: "error"` with the actual
error/status; valid metadata remains ready. Some identified variants simply
have no artwork, and a missing cover does not mean that a ROM is invalid.
Cached covers persist below `storage/metadata/`; manually supplied art below
`storage/attachments/`. Source folders receive no index, image or digest sidecars.

Cover URLs are generated only for the existing Libretro thumbnail provider,
never accepted as arbitrary host/file URLs. Redirects, non-image content types,
and images larger than 10 MiB are rejected. No media or index sidecars are
created beside ROMs/BIOS.
