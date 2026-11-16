# Lead History

## Project Context

- Project: `long2know/retroassembly`, forked from `arianrhodsandlot/retroassembly`.
- Requested by: Stephen Long.
- Team approved: November 16, 2026.
- Stack: React, React Router, Radix Themes, Tailwind, Jotai, SWR, i18next; Nostalgist; Hono, Drizzle, SQLite; Node and Cloudflare Workers.

## 2026-11-16: Initial due diligence and team approval

Reviewed all 19 fork-specific commits after `fb062eff`, affected source/tests, documentation, selected CI logs, retained artifact metadata and an accessible earlier conversation. The maintainer approved Lead, Library, Browser, Platform and Quality with four fixed support identities.

Recovered original requirements: index existing ROM/BIOS folders without uploads, rearrangement or source writes; browser-side emulation; Docker configuration; and separate writable app data. An ES-DE browser rewrite was considered, not selected. Native-save import was not authorized.

Delivered work:

- `3d347979` and `84159671`: immutable mounted libraries and gated container publication.
- `6e06c1b6` through `987739fa`: management contracts, identification/cache behavior, metadata settings, localization and focused regressions.
- `ea4b4fb8` through `490bc49e`: preserved formatter diagnostics, manual-artwork and ZIP-size fixes, accessibility/types and handled asynchronous revalidation.

At initial review, both `main` and `stlong/rom-metadata-settings` pointed to `490bc49e`; no merge was necessary. The fork had no PR records and issues were disabled. This clone's reflog contained only its November 16 clone event; it cannot establish prior machines' checkouts.

Historical acceptance runs for `490bc49e`: `43342915252`, `43343670420`, `43344499884`. Source/unit, built-image, registry-digest and anonymous-public-image checks succeeded. These are dated CI outcomes, not fresh local execution.

## Evidence Limits and Next Ownership

The accessible conversation ends before later metadata refinements. Do not label every implemented refinement a recovered verbatim request. Artifact archives were inventoried, not downloaded; live collections, native saves and personal deployment were not inspected.

Lead should clarify the next user priority. Shared-edit/hide authority and the documented `404`/`409`/`503` distinction are decision candidates, not approval to change product behavior. Preserve source immutability, user privacy, uploaded libraries and Workers separation.

The maintainer requested committing the team, casting state and histories through a focused PR and merging it into `main`. That authorization is specific to team setup; it does not start speculative product work.
