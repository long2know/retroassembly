# Mounted libraries (Node runtime)

This fork indexes an existing collection in place. Emulation still runs in the
browser using upstream Nostalgist/Libretro cores. It does not run desktop
emulators, stream video, download games/firmware, convert sources, or import
native saves.

## Runtime configuration

| Environment variable                                 | Default | Meaning                                                                                                                                                        |
| ---------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETROASSEMBLY_RUN_TIME_ENABLE_SHARED_ROM_LIBRARY`   | `false` | Enable mounted sources in Node. Workers retain uploaded-library behavior.                                                                                      |
| `RETROASSEMBLY_RUN_TIME_SHARED_LIBRARY_ONLY`         | `false` | Hide uploaded games and reject new ROM uploads while mounted sources are enabled.                                                                              |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_DIRECTORY`        | empty   | Required absolute, existing ROM root when enabled.                                                                                                             |
| `RETROASSEMBLY_RUN_TIME_SHARED_BIOS_DIRECTORY`       | empty   | Optional absolute, existing BIOS root.                                                                                                                         |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_SCAN_INTERVAL`    | `300`   | Initial seconds between completed scans (`0` to `86400`); `0` is manual-only after startup. Persisted app settings take precedence after first initialization. |
| `RETROASSEMBLY_RUN_TIME_SHARED_ROM_METADATA_ENABLED` | `true`  | Allow provider identification and cover caching. `false` disables automatic and explicit provider requests; manual metadata/art editing still works.           |

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

On a console page, use **Filter games** to match a title or filename across
that console. Filtering keeps sorting and favorites in the cover grid. Press
Escape while the filter is focused, or use its clear button, to clear it.

Shared titles/descriptions, manual matching, and uploaded artwork are app-wide
metadata edits. Mounted ROMs cannot be deleted or hidden from the library, even
by an administrator. ROM deletion and bulk selection apply only to uploads
you can edit. **Delete from history** removes only your own launch records.

Games hidden by older versions stay hidden across rescans. The app
administrator (the oldest active account) can open **Settings → Library →
Hidden mounted games** and select **Restore for everyone**. This makes the same
game visible again, retaining its metadata, artwork, and private favorites and
savestates. It does not recover deleted launch history or uploaded ROMs.
Availability in the hidden list reflects the saved index. If a ROM is missing
or has changed, make it available again and run **Scan ROM folders** under
**ROM / Metadata** before retrying the restore.

Scans are idempotent and coalesce concurrent requests. Only a complete,
successful enumeration reconciles missing files. An inaccessible/replaced root
or an incomplete traversal preserves previous rows and records an error.
Verified removals mark sources unavailable without deleting metadata or states.
Same-path replacement changes the revision, clears automatic identification/art,
and queues fresh enrichment. Explicit manual metadata survives rescans and
replacement. Existing savestates are not converted or guaranteed compatible with
replacement ROM bytes. Reads detect unscanned replacements and return `409`
until a rescan; unavailable/unsafe sources return `503`.

### Sync in-game cartridge saves

For a supported NES or Famicom game, save using the game's own save menu.
Pause the game and select **Sync in-game save**. Wait for the confirmation
before exiting. The next **Start** on the same account loads the latest
compatible copy, including on another browser. **Save State**, **Continue**
and **Save & Exit** still operate on snapshots; they do not sync a cartridge
save. Closing the tab does not sync it either.

This initial release supports standalone `.nes` files with a standard iNES
MMC1 battery header and 8 KiB of SRAM, using FCEUmm. It works with both uploads
and mounted files. It needs a secure browser context (HTTPS or localhost).
Other mappers and cores, archives, disks, playlists and demos do not
participate. For these compatible cartridges, RetroAssembly preserves the
cartridge RAM when loading a snapshot and disables rewind and run-ahead so
they cannot roll back the RAM.

The copy lives in RetroAssembly's database, not beside the ROM. It is private
to the signed-in account and tied to the game, core and exact ROM contents
(plus the mounted revision where applicable). A new ROM revision does not
load the old copy. If another session syncs first, the older session cannot
overwrite it. Exit and choose **Start** to load the newer copy. If sync
storage is unavailable on launch, gameplay can continue, but syncing is
disabled for that session until you exit and start again. If you switch
accounts in the browser, a game already running cannot sync to the new account.

Authenticated API endpoints:

- `GET /api/v1/roms` and `GET /api/v1/roms/:id`: visible games/details.
- `GET /api/v1/roms/:id/content`: original ROM bytes.
- `DELETE /api/v1/roms/:id` and `DELETE /api/v1/roms?ids=…`: delete editable
  uploads only. A visible mounted ROM returns `403`, and the entire batch is
  rejected before any ROM or launch record is deleted.
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
- `GET /api/v1/mounted-library/hidden`: administrator-only list of hidden
  mounted games, including entries marked unavailable in the index. It returns
  IDs, display names, filenames relative to their system folders, platforms,
  and indexed availability without exposing mount paths or reading ROMs.
- `POST /api/v1/mounted-library/hidden/:id/restore`: administrator-only restore
  of a hidden game whose source still matches the saved index. This checks
  one source without writing files or reading ROM bytes. Returns `404` for
  non-hidden/non-mounted or unknown IDs, `409` for unavailable or changed index
  entries or an unscanned replacement, and `503` if the source cannot be opened
  safely. Failed checks do not change the row.
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
  or a `launchboxId`/`libretroId`. This remains the legacy single-result msleuth
  endpoint; provider failures are persisted and retryable.
- `GET /api/v1/roms/:id/match?query=...`: search the game's platform catalog for
  up to 12 candidates. An empty list is a successful search with no matches;
  an unavailable provider is `502`. PC Engine CD and SuperGrafx folder aliases
  return `422` rather than searching the PC Engine cartridge catalog. Search
  does not edit a game.
- `POST /api/v1/roms/:id/match`: apply `{ "candidateId": "...", "snapshot": "...",
  "intent": "cover" }` from a search on this game. Omit `intent` or use `"match"`
  to apply the full match. The server resolves the ID in the game's platform
  catalog. An invalid candidate or stale game/source is `409`; search again
  after reloading or rescanning as appropriate. The response reports
  `artwork: "ready"`, `"missing"`, `"error"` or `"manual"`. A cover-only request
  changes nothing unless the cover is ready.
- `POST /api/v1/roms/:id/retry-artwork`: retry only this game's cover, using its
  chosen cover if set, or its current match or title, without re-identifying
  it. Returns the same cover outcomes, or `"no-title"` when a match or title
  is needed first. Both repair actions use the existing mounted edit
  authority; they do not require admin.
- Existing ROM `PATCH`, artwork, favorites, history, and state APIs also work
  with mounted rows under the same authorization checks.

Open a mounted game's details and choose **Find match** to search by title (or
MAME set name). Review the candidates and choose the intended release. Titles
include regions and revisions where available; an available year is shown
without inventing a release date. Choose **Use cover only** to try a candidate's
cover without changing the game's title, description, videos, or other details.
No cover or a provider error leaves the existing cover untouched. A successful
choice is remembered by **Retry cover art**.

Choose **Use full match** to set the title and update scraped details. An
already confirmed catalog match or the exact Libretro release on the same
platform preserves existing details and provider media. A different or
unverified release discards the old scraped details and videos while
preserving manually edited fields. Freeform changes protect only the
fields that actually changed (release dates are compared by UTC calendar day);
a no-op does not change automatic enrichment. Older manual records without
field tracking retain their existing fields. The media editor can upload
custom cover art. An uploaded or removed cover is never replaced by either action.
Both actions are available with automatic metadata off, but respect the server
network ceiling (`403`). Source bytes are immutable.

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

Supported standalone extensions follow the upstream platform lists, with
compatible PlayStation PBP additionally supported on Node mounts. Mounted
PlayStation `.m3u` playlists must contain only CHDs. CUE/BIN disc sets, ISO,
M3U8, mixed-format playlists and playlists for other systems are not playable.
The scanner shows why a recognized format or playlist is unsupported; it
never converts source files.
After an upgrade, run **Scan ROM folders** to refresh compatibility for
unchanged entries, including previously unsupported Virtual Boy `.bin` cartridges
in `vb` or `virtualboy` folders.
Archive/core/ROM-set compatibility is still the upstream browser runtime’s
responsibility; indexing a supported extension is not a compatibility guarantee.

### Standalone PlayStation PBP

The pinned PCSX ReARMed browser core can play compatible, unencrypted single-disc
`.pbp` images in mounted `psx` or `ps1` folders, including `.PBP`. Both an explicit
final block end and the standard zero-padded index terminator (as written by
PSXPackager) are accepted. For a zero terminator, the browser supplies the validated
end offset to the emulator in memory; the mounted file and authenticated file
responses remain byte-for-byte unchanged.

Packages with stored (uncompressed) blocks, encrypted packages, PSP games/updates,
multi-disc PBP and PBP entries in M3U are not supported. Scanning checks the
container, disc table and block index and samples compressed blocks. It accepts
both a disc-relative lead-out (as written by PSXPackager) and a lead-out that
includes the 150-frame lead-in (as written by pop-fe when it generates the disc
table). These checks do not verify every block or guarantee that a game boots.

After upgrading, run **Scan ROM folders** to enable compatible PBP files already
in the index, including those previously blocked because of these index or
lead-out differences.
Rescanning preserves existing IDs and metadata. Identification uses the name,
not the container hash. Compatible PBP uses the same app save states as other
standalone games. PlayStation uploads still accept only CHD; PBP support is not
available on Workers.

### PlayStation disc playlists

Put a UTF-8 `.m3u` file (up to 64 KiB) under a mounted `psx` or `ps1` folder.
List **two to eight distinct CHDs**, one per line in play order, using the
exact names and case on disk. Relative paths may go into subfolders beside the
playlist: for example, `Disc 1.chd` and `Discs/Disc 2.chd`. Blank lines, `#`
comments and an initial UTF-8 BOM are allowed. Absolute paths, URLs,
backslashes, `.`/`..` segments, percent escapes, symlinks, duplicate discs and
nested playlists are not allowed. Fix any reported line and rescan; one bad
entry prevents the playlist from launching but does not hide standalone CHDs.

The playlist boots disc 1 with PCSX ReARMed. When the game asks for another
disc, open the in-game overlay and choose it under **Change disc**. Later
discs are downloaded on demand. If you skip an unloaded disc, the core needs
that image too; it is downloaded when you make the jump, not at launch. If a
download fails before the tray opens, the current disc stays active and you can
retry. If a file changes or disappears, rescan and reload the game. Existing
individual CHD entries, favorites and saves are unchanged.

Manual and automatic playlist saves remember the disc and the indexed playlist
revision. **Continue** or loading an in-game save selects the right disc first.
Changing the playlist or replacing a disc can make old playlist saves
incompatible; those saves are kept, but cannot load on the new revision.
Standalone CHD saves, external states and native saves are not imported into
playlists. Rewind and its controls are disabled for playlists so rewind cannot
load a snapshot from another disc. Playlist playback is for Node mounts only,
not uploads or Workers.

On platforms with more than one emulator, use **Emulator for this game** on a
game’s details page to choose one just for your account. Choose **Platform
default** to follow your platform-wide setting again. Manual saves remain tied
to the emulator that made them and are available when you switch back.
Auto-save retention still applies per ROM, across all emulators.

Before serving this version, self-hosted Workers deployments must apply any
pending D1 migrations, including `0011_mounted_playlist_states.sql`,
`0012_private_game_collections.sql`, and `0013_in_game_saves.sql`, to their library
database. Existing saves are unchanged. Node applies migrations automatically
at startup.

## Private game collections

Open **Collections** in library navigation to create a private list, then use
**Collections** on a game's details page to add or remove it. Lists can contain
mounted, uploaded, or shared-library games across platforms, even if their
platforms are disabled in your browse settings. A hidden or unavailable game
is not shown or counted until it becomes visible again. Removing a game from
a collection or deleting the collection does not change the ROM or its files.

## Metadata and covers

Identification uses the installed msleuth SDK and its existing platform-scoped
Libretro MD5 matching followed by ROM-name, No-Intro/GoodTools-aware filename,
and LaunchBox alternate-name matching. Normal cartridge files are hashed in
bounded chunks. Non-arcade ZIPs are inspected through a random-access reader;
only one safe, system-eligible cartridge payload is hashed, never compressed
archive bytes or an arbitrary first entry. The payload's basename is the first
filename fallback after content MD5; the archive basename is tried only when
that lookup finds no match. No mounted directory path is sent to the provider.
Directories, documentation and macOS
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
hard ceiling returns `403` for explicit provider actions. The browser starts
cached-only until it has status authorizing automatic requests; the authenticated
status endpoint supplies that state when the page loader has no snapshot.

Explicit search reads the [Libretro database](https://github.com/libretro/libretro-database/tree/90601bff67dba7057381292f17e08ed2cecbd6dc)
(CC BY-SA 4.0, Libretro database contributors) at a pinned revision using the
MIT-licensed `libretrodb` parser. Only the platform's RDB is downloaded, with a
10 MiB limit and a small in-memory cache. Arcade search uses MAME names and
set names; a match is not a guarantee of emulator or ROM-set compatibility.
Famicom/NES, Super Famicom/SNES, and Mega Drive/Genesis each share a cartridge
catalog across regions; Famicom Disk System is separate. Game & Watch uses the
Libretro handheld electronic game `.mgw` catalog. The recognized
`pcenginecd`/`supergrafx` folder aliases are not part of the PC Engine cartridge
picker scope.
None of the catalog data is bundled. The search text, mounted paths and ROM
bytes are not sent to the catalog host.

Artwork uses the canonical Libretro name, with a canonical LaunchBox title
or arcade set name as applicable. For each name, an origin `404` tries a pinned
jsDelivr mirror for the same system. Only all-`404` results are marked `missing`.
HTTP errors, timeouts, redirects and unsafe media are marked `error`; a saved
match remains saved. A changed full match drops the old automatic cover if no
replacement is available. An unsuccessful cover-only choice or a failed refresh
for the same target keeps any existing cached cover. App-stored covers take
priority. A previously identified mounted game may fall back to Libretro box
art, title screens, or gameplay screenshots for its existing provider identity
only while both the server network policy and automatic metadata are enabled.
A custom or removed cover,
an edited title no longer matching that identity, and an explicit catalog
cover or full match do not use the old browser cover fallbacks.
Cached covers persist below `storage/metadata/`; manually supplied art below
`storage/attachments/`. Source folders receive no index, image or digest sidecars.

Cover URLs use only the Libretro thumbnail origin and pinned mirrors, never an
arbitrary host or file URL. Server-side cover caching rejects redirects,
invalid image signatures or content types, and images larger than 10 MiB.
No media or index sidecars are created beside ROMs/BIOS.

### Focused production browser check

```sh
pnpm build
pnpm exec playwright install chromium --only-shell
pnpm exec playwright test -c tests/e2e/mounted-metadata-repair.config.ts --tsconfig=tests/e2e/tsconfig.playwright.json
```

The spec starts a local production Node bundle on an ephemeral loopback port
and uses synthetic mounted files and mocked provider responses at `/` and a
nested base path. It verifies that repairing a cover leaves the Atari 7800
fixture's synopsis, video and mounted ROM intact. It does not need Docker,
real ROMs, or a running deployment.
