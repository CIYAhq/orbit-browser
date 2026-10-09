# Orbit status

_Last updated: 2026-10-09 11:50 UTC by the lead (relaunched session)._

## In plain words
Orbit is a working skeleton, and five build agents are turning it into the milestone-1 experience in parallel:
- **tabs**: tabs, pinned tabs, Favorites, Today, folders, drag and drop
- **split**: split view
- **commandbar**: command bar and browsing history
- **spaces**: Spaces, profiles, themes and the Space swipe
- **core**: fixes from the scaffold review

The behaviour spec is complete: 22 areas, 485 behaviours. An independent reviewer found 8 must-fix bugs in the scaffold (for example, links that open a new tab created a hidden duplicate page). Each one is assigned to the lane that owns the code and blocks that lane's merge. Performance is good except cold start (see `PERF.md`).

## What happened so far
- 05:37–06:14 UTC: first lead run. Spec team started, repo scaffolded (branch `wip/scaffold`). The lead then hung.
- 10:52 UTC: lead relaunched. Checked the scaffold (green), relaunched the missing spec work, and wrote this file, `FEATURES.md` and `docs/ARCHITECTURE.md`.
- 10:59 UTC: scaffold opened as PR #1. CI went green on Linux and macOS.
- 11:00–11:10 UTC: build lanes **tabs** and **split** started in their own worktrees.
- 11:15 UTC: performance harness (`npm run perf`) and screen-capture recorder (`npm run capture`) added. First results are in `PERF.md`.
- 11:17 UTC: all missing spec areas landed (Spaces/profiles, feel, command bar, navigation, shortcuts, split view, link preview, mini window, media).
- 11:25–11:36 UTC: lanes **commandbar**, **spaces** and **core** started. The scaffold review came back REQUEST CHANGES (8 must-fix, 15 follow-ups); its fixes are split between **core** and **tabs**.
- 11:40 UTC: README (with the clean-room and non-affiliation statement) and MIT LICENSE added. The macOS `.dmg`/`.zip` builds in CI.

## Milestone 1: core experience that feels good
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | 🔨 lane running | 🟡 smoke test |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | 🔨 lane running | – |
| Spaces and profiles (SP, PR) | ✅ written | 🔨 lane running | – |
| Command bar (CB) | ✅ written | 🔨 lane running | 🟡 smoke test |
| Split view (SV) | ✅ written | 🔨 lane running | – |
| Interaction feel (FL) | ✅ written | – | – |

## Next
1. Merge **core** into the scaffold, re-review, then merge PR #1 to `main`.
2. Review and merge each lane as it finishes: **tabs**, **split**, **commandbar**, **spaces**.
3. Then start **chrome-nav** (top bar, address display, sidebar hide/hover/resize, navigation, find in page), **peek-mini**, **media** and **archive**.
4. Milestone 1 capture (30–60 s clip + screenshots) and a `checkpoint` signal once the four core lanes are merged.

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
