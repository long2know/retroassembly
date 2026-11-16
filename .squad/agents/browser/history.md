# Browser History

## Project Context

- Requested by Stephen Long; approved November 16, 2026.
- Stack: React, React Router, Radix Themes, Tailwind, Jotai, SWR, i18next and Nostalgist browser emulation.
- Ownership: gameplay/save journeys, mounted-library settings, accessibility and localization.

## 2026-11-16: Delivered Experience Baseline

- `32a1970b` adds mounted platform detection and ROM metadata settings; `70c31837` supplies locale keys.
- Indexed counts include disabled platforms. Viewing/filtering counts is non-mutating; enabling populated platforms explicitly replaces the selected set.
- Scans, metadata refresh, artwork-only retries and automatic download policy are separate controls.
- Persisted scan preferences survive restarts. Interval zero disables periodic scanning, not startup reconciliation.
- Manual custom/missing artwork states must survive automatic metadata work.
- `490bc49e` handles completion-triggered loader revalidation as an asynchronous React action.

The controlled production-browser baseline proves one fixture's actual core loading/frames, save/resume and settings/cache persistence. It is not evidence that every game, firmware or controller works.

Frontend changes require screenshots in PR descriptions, focused regression coverage and preservation of required feature gates. No authored PR comments without an explicit request.

Use the existing settings-dialog paths, all 12 locale files and the mounted-library/gameplay/save suites. See `.squad/team.md` for evidence limits; no new UX expansion was authorized by team creation.
