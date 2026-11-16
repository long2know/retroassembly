# Squad Decisions

## Active Decisions

### 2026-11-16: Approved continuation team

**By:** Repository maintainer, confirmed through the team-approval prompt.

**What:** Hire Lead, Library, Browser, Platform and Quality, with Scribe, Ralph, Rai and Fact Checker as fixed support identities. Use descriptive names and one accountable specialist per requested outcome.

**Why:** Continue the existing fork with an evidence-grounded understanding of immutable mounted libraries, content-based metadata, browser emulation and reproducible container releases. Team creation does not authorize an ES-DE rewrite, emulator expansion, live deployment or an autonomous work loop.

### 2026-11-16: Preserve the fork's product boundaries

**What:** Existing ROM/BIOS folders remain immutable and retain their layout. Database, metadata, artwork and application saves remain in separate writable app storage. Preserve browser-side emulation, private per-user activity, uploaded-library behavior and the Node/Workers separation.

**Why:** These are the recovered original requirements and delivered contracts summarized with evidence and limitations in `team.md`. Indexing and matching are not promises of universal emulator compatibility; new work requires a confirmed priority.

### 2026-11-16: Commit team state through a main-targeted PR

**By:** Repository maintainer.

**What:** Commit the Squad team, casting state and histories, create a focused `stlong/` branch and PR, satisfy applicable checks, and merge into `main`. Keep the local state backend so the requested histories are part of the checkout. Exclude credentials, private transcripts, runtime caches and unrelated editor settings.

**Why:** Explicit request to persist all team work and complete its PR. The metadata branch already matched `main` at the initial review; do not manufacture another merge for it.

### 2026-11-16: Contributor workflow

**What:** New branches use `stlong/`, not `squad/` or agent names. Keep PR summaries short and user-facing. Put evidence and frontend screenshots in PR descriptions; do not author PR comments unless explicitly asked. Add focused regression coverage, preserve required feature gates, and never send Teams messages without an explicit request.

**Why:** Retain the maintainer's stated workflow preferences across team handoffs.

### 2026-11-16: Separate generated Squad state from application tooling

**What:** Keep the versioned `.squad/` framework/state tree outside application linting and formatting through Vite+'s `lint.ignorePatterns` and `fmt.ignorePatterns`. Retain all shared application defaults, type checks, rules and zero-diagnostic acceptance requirements. Active `.github/` integration remains formatted by the application checker.

**Why:** Tracking team/history must not turn bundled CommonJS framework templates into application code or reformat the SDK's transaction-checksummed casting registry/history. Validate that state with `squad health` and `squad doctor` instead of independently reserializing it.

## Governance

- The coordinator records accepted decisions; agents propose changes without rewriting this ledger.
- Select one accountable owner and bounded collaboration, not whole-team consensus for routine work.
- Keep histories focused on evidence and learnings, and decisions focused on accepted direction.
