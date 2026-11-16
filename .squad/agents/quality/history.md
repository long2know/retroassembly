# Quality History

## Project Context

- Requested by Stephen Long; approved November 16, 2026.
- Stack: Node unit tests and Playwright production-browser/Docker acceptance for React, Hono/SQLite and Nostalgist.
- Ownership: focused regressions, immutable-source/privacy assertions and qualified compatibility evidence.

## 2026-11-16: Reviewed Acceptance Baseline

At `490bc49e`, historical CI reported 27 total unit tests with no failures and one focused production-browser scenario. This was not a new local run and does not mean 27 tests were added in the last change.

The mounted Docker/browser gate uses legal original/synthetic fixtures and a controlled metadata provider. It checks actual core loading/changing frames, source preservation, runtime app-data ownership, save/resume, metadata/cache persistence and restarts. A writable ROM-bind mutation must fail the specific read-only-mount assertion.

Unit coverage includes content-identified ZIPs, metadata/artwork outcomes, management controls and private-user behavior. Read `tests/unit/mounted-library.test.ts`, `tests/unit/auth.test.ts`, `tests/e2e/mounted-library.spec.ts` and `tests/e2e/mounted-library-docker.ts`.

Do not infer real-firmware validity from synthetic BIOS routing fixtures, real-provider catalog accuracy from the controlled provider, or all-platform/controller/Workers support from one NES scenario. Artifact archives were inventoried rather than downloaded.

Use the smallest relevant existing command and add only contract-focused regressions. Never weaken source immutability or privacy assertions to obtain a pass. Review `.squad/team.md` for remaining evidence gaps before making claims.
