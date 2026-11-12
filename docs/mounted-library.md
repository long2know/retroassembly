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
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL`    | `300`   | Seconds between completed scans, from `0` to `86400`; `0` disables periodic scans, not the startup scan.                                             |
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
- `GET /api/v1/mounted-library`: last scan status, errors, counts, BIOS warnings.
- `POST /api/v1/mounted-library`: rescan, preserving previous rows on failure.
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

Automatic enrichment uses upstream msleuth providers and runs separately from
startup scanning/request handling, in sequential batches of at most 50 games.
Pending batches drain in the background; identification failures back off at
least five minutes before periodic retries. Cover failures retain identification
and surface a warning for explicit retries. Per-game metadata errors and scan/enrichment failures
are visible in records/logs, and manual retries use the identification endpoint.
Provider access depends on network availability and provider usage policies;
there is no unlimited/free scraping guarantee.

Identification records persist in the app database. Cached covers persist below
`storage/metadata/`; manually supplied art below `storage/attachments/`.
ROM identification uses the original basename, not bulk content hashing;
ambiguous matches can be corrected without renaming files.
Cover URLs are generated only for the existing Libretro thumbnail provider,
never accepted as arbitrary host/file URLs. Redirects, non-image content types,
and images larger than 10 MiB are rejected. No media or index sidecars are
created beside ROMs/BIOS.
