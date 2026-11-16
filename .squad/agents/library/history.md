# Library History

## Project Context

- Requested by Stephen Long; approved November 16, 2026.
- Stack: Hono, Drizzle, SQLite and Node/Workers, integrated with React/React Router and Nostalgist.
- Ownership: immutable mounted libraries, BIOS, identification, database contracts and caches.

## 2026-11-16: Delivered Backend Baseline

- `3d347979` introduced immutable mounted libraries and shared mounted rows without a fake user.
- Safe canonical roots, opaque IDs and skipped/rejected symlinks protect source access; failed scans must not reconcile prior rows away.
- Same-path replacement retains ROM identity while invalidating automatic revision-dependent metadata. Preserve explicit manual edits and artwork.
- `7c25be3d` and `c4330bc8` establish bounded payload hashing, safe ZIP selection, output-size verification and separate metadata/artwork outcomes.
- Non-arcade ZIPs require one safe eligible payload. Arcade ZIPs remain intact; filename fallback and provider confidence are not universal compatibility.
- Settings/jobs separate source scans, metadata refresh and artwork retry. Persisted settings are not overwritten from environment seeds on every restart.

Primary inputs: `mounted-files.ts`, `mounted-library.ts`, `mounted-identification.ts`, `mounted-metadata.ts`, `rom-access.ts`, `file-access.ts`, `src/databases/schema.ts`, `tests/unit/mounted-library.test.ts` and `docs/mounted-library.md`.

Shared mounted entries currently allow app-wide metadata edits/hides; confirm policy before changing it. Clarify the unavailable-source documentation without silently changing API statuses.

Full reviewed evidence and limitations are in `.squad/team.md`. The next backend feature is not selected merely by hiring the team.
