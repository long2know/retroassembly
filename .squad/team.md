# Squad Team

> Continue the RetroAssembly fork without compromising immutable collections or browser emulation.

## Coordinator

| Name | Role | Notes |
|------|------|-------|
| Squad | Coordinator | Routes work, enforces handoffs and reviewer gates. |

## Members

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Lead | Lead / Technical Steward | `.squad/agents/lead/charter.md` | ✅ Active |
| Library | Backend / Library & Metadata Engineer | `.squad/agents/library/charter.md` | ✅ Active |
| Browser | Frontend / Emulation & Experience Engineer | `.squad/agents/browser/charter.md` | ✅ Active |
| Platform | DevOps / Container & Release Engineer | `.squad/agents/platform/charter.md` | ✅ Active |
| Quality | QA / Acceptance & Compatibility Engineer | `.squad/agents/quality/charter.md` | ✅ Active |

## Built-in Support Agents

| Name | Role | Charter | Status |
|------|------|---------|--------|
| Scribe | Decision Merger | `.squad/agents/scribe/charter.md` | 📋 Silent |
| Ralph | Work Monitor | `.squad/agents/ralph/charter.md` | 🔄 Monitor |
| Rai | RAI Reviewer | `.squad/agents/rai/charter.md` | 🛡️ RAI |
| Fact Checker | Devil's Advocate & Verification Agent | `.squad/agents/fact-checker/charter.md` | 🔍 Verifier |

## Coding Agent

<!-- copilot-auto-assign: false -->

| Name | Role | Charter | Status |
|------|------|---------|--------|
| @copilot | Coding Agent | — | 🤖 Coding Agent |

### Capabilities

**🟢 Good fit — auto-route when enabled:**
- Bug fixes with clear reproduction steps
- Test coverage (adding missing tests, fixing flaky tests)
- Lint/format fixes and code style cleanup
- Dependency updates and version bumps
- Small isolated features with clear specs
- Boilerplate/scaffolding generation
- Documentation fixes and README updates

**🟡 Needs review — route to @copilot but flag for squad member PR review:**
- Medium features with clear specs and acceptance criteria
- Refactoring with existing test coverage
- API endpoint additions following established patterns
- Migration scripts with well-defined schemas

**🔴 Not suitable — route to squad member instead:**
- Architecture decisions and system design
- Multi-system integration requiring coordination
- Ambiguous requirements needing clarification
- Security-critical changes (auth, encryption, access control)
- Performance-critical paths requiring benchmarking
- Changes requiring cross-team discussion

## Project Context

- **Project:** retroassembly
- **Created:** 2026-11-16
- **Requested by:** Stephen Long
- **Repository:** `long2know/retroassembly`, forked from `arianrhodsandlot/retroassembly`
- **Stack:** React, React Router, Radix Themes, Tailwind, Jotai, SWR and i18next; Hono, Drizzle and SQLite; Nostalgist browser emulation; Node.js and Cloudflare Workers.
- **Team approval:** Five descriptive specialists and four built-in support identities approved on November 16, 2026. Coding-agent auto-assignment remains disabled.
- **Integration:** Create `stlong/` branches from current `main`; use focused PRs targeting `main`. There is no `dev` or `insiders` release workflow in this fork.
- **Persistence:** Local Squad state, casting history and agent histories are versioned in this repository. Do not commit credentials, private transcripts, runtime caches or machine-specific editor settings.

## Confirmed Product Direction

The recovered November 12, 2026 conversation requested existing ROM/BIOS folders without mandatory uploads, rearrangement or source writes; browser-side emulation; Docker configuration; and separate writable application data. Continue this fork rather than assuming an ES-DE rewrite.

Preserve original collection names and layout, read-only source mounts, app-owned metadata/artwork/saves, private per-user activity, uploaded libraries and the Node/Workers boundary. Never mount or modify native emulator save collections without separate authorization.

## Delivered Baseline

The initial review covered all 19 fork-specific commits after `fb062eff`, affected source/tests, documentation, selected CI logs and retained artifact metadata. At review time, `main` and `stlong/rom-metadata-settings` were identical at `490bc49e`; no metadata-branch merge was necessary.

| Area | Delivered behavior | Primary evidence |
|------|--------------------|------------------|
| Mounted libraries | Immutable recursive indexing, ES-DE aliases, BIOS discovery, safe reconciliation, shared games and private user activity | `docs/mounted-library.md`; `3d347979`; `src/utils/server/mounted-files.ts`; `src/utils/server/mounted-library.ts` |
| Identification | Content MD5, safe single-payload ZIP handling, revision-aware digest caches, confidence-qualified matching and separate artwork outcomes | `7c25be3d`; `c4330bc8`; `src/utils/server/mounted-identification.ts`; `src/utils/server/mounted-metadata.ts` |
| Management UX | Independent scans/metadata/artwork jobs, persisted settings, indexed platform counts, manual overrides and 12-locale coverage | `2f8e92d3`; `32a1970b`; `490bc49e`; `src/pages/library/components/library-layout/layout-menu/settings-dialog/` |
| Releases | Production-container/browser acceptance, immutable GHCR candidates, registry-digest acceptance, promotion and separate anonymous-pull verification | `deploy/README.md`; `.github/workflows/test.yaml`; `.github/workflows/verify-published.yaml` |

Historical acceptance for `490bc49e`: feature run `43342915252`, main publication run `43343670420` and anonymous-public-image run `43344499884` succeeded on November 12, 2026, Pacific time. The accepted image digest was `sha256:0d091b6680db913bc850ac51b5e475db751f377363a3e5c7ceb33f0818750b99`. These are dated baseline observations, not proof about future commits or every game.

## Continuation Boundaries

- Indexing, metadata identification and emulator compatibility are different contracts. Do not promise universal ROM/core support, multi-file disc resolution, native-save imports or additional architectures.
- Existing shared metadata edits and hides are app-wide. Ask before changing that authority or adding restore behavior.
- A documentation discrepancy around unavailable sources needs a focused decision: eligible source reads can report `503`, changed revisions `409`, and reconciled unavailable/hidden entries `404`. Do not silently change the API.
- Source CI and one controlled production-browser scenario do not establish real-catalog coverage, large-library performance, all firmware/controllers or deployed Workers acceptance.
- The accessible earlier conversation ends before later metadata refinements; those refinements are evidenced by code/commits, not recovered verbatim requests. This clone's reflog cannot recover other machines' checkout history.
- CI artifact archives were inventoried, not downloaded. No live collection, native saves or personal deployment was inspected.

## Working Agreement

Use one accountable specialist per outcome; add contributors or a reviewer only for a concrete need. Lead owns clarifying the next user-approved priority, not inventing a backlog. Ralph does not start an autonomous loop merely because the team exists.

Follow `agents.md` and `.squad/decisions.md`. Keep PR summaries short and user-facing; put evidence and frontend screenshots in descriptions, not authored PR comments. Include focused regression coverage and preserve required feature gates. Never send Teams messages without an explicit request.
