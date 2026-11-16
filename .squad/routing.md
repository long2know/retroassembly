# Work Routing

Assign one accountable specialist to each requested outcome.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Requirements and architecture | Lead | Confirmed priorities, upstream integration, scope decisions, code review |
| Mounted libraries and metadata | Library | Immutable scans, BIOS, ZIP identification, Drizzle schema, caches, privacy |
| Browser emulation and experience | Browser | Nostalgist, gameplay, save UX, settings, accessibility, localization |
| Containers and releases | Platform | Docker, GHCR, hosted CI, Node/Workers packaging, backup and recovery |
| Tests and compatibility evidence | Quality | Unit regressions, production-browser acceptance, no-write and privacy assertions |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage a user-approved issue if GitHub issues are enabled | Lead |
| `squad:{name}` | Work within the approved issue's scope | Named specialist |

### How Issue Assignment Works

GitHub issues were disabled at initial review. Do not enable them or invent issue numbers to initialize the team. Direct user requests route through the table above. If issues are enabled later, Lead resolves ambiguous ownership and delegates only approved work.

## Rules

1. Select one owner. Split only independently deliverable outcomes; do not launch speculative agents.
2. Lead handles unmatched work and scope questions. Add contributors only for bounded needs.
3. Give the owner explicit deliverables, exclusions, evidence requirements and the resolved team root.
4. Preserve immutable sources, private user activity, uploaded-library behavior and runtime boundaries.
5. Use `stlong/` branches and focused PRs targeting `main`; follow the accepted working agreement in `decisions.md`.
6. Scribe merges accepted durable decisions only. Ralph monitors approved work only when activated.
7. Rai and Fact Checker are support reviewers, not routing destinations. Use a material-risk gate when warranted, not automatic review fan-out.
8. A rejected artifact's author cannot produce or contribute to its immediate revision. Escalate if no qualified independent owner is available.
