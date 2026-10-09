# Orbit status

_Last updated: 2026-10-09 13:42 UTC by the lead (relaunched session)._

## In plain words
The scaffold and its review fixes are merged to `main` (PR #1), with CI green on Linux and macOS, including a signed-for-local-use macOS `.dmg`. Four feature lanes have finished their milestone-1 work:
- **tabs**: tabs, pinned, Favorites, Today, folders
- **spaces**: Spaces, profiles, themes, swipe
- **commandbar**: command bar and history
- **split**: split view

Each lane got an independent review. The spaces, commandbar and split lanes are fixing their review findings and integrating onto the tabs lane, whose own review is running. Next: merge the four lanes to `main` one by one, then record the milestone-1 screen capture.

## What happened so far
- 05:37–06:14 UTC: first lead run. Spec team started, repo scaffolded (branch `wip/scaffold`). The lead then hung.
- 10:52 UTC: lead relaunched. Checked the scaffold (green), relaunched the missing spec work, and wrote this file, `FEATURES.md` and `docs/ARCHITECTURE.md`.
- 10:59 UTC: scaffold opened as PR #1. CI went green on Linux and macOS.
- 11:00–11:10 UTC: build lanes **tabs** and **split** started in their own worktrees.
- 11:15 UTC: performance harness (`npm run perf`) and screen-capture recorder (`npm run capture`) added. First results are in `PERF.md`.
- 11:17 UTC: all missing spec areas landed (Spaces/profiles, feel, command bar, navigation, shortcuts, split view, link preview, mini window, media).
- 11:25–11:36 UTC: lanes **commandbar**, **spaces** and **core** started. The scaffold review came back REQUEST CHANGES (8 must-fix, 15 follow-ups); its fixes are split between **core** and **tabs**.
- 11:40 UTC: README (with the clean-room and non-affiliation statement) and MIT LICENSE added. The macOS `.dmg`/`.zip` builds in CI.
- 12:37 UTC: **spaces** lane done. All P0s are built and tested, including real cookie isolation between profiles.
- 12:47 UTC: **commandbar** lane done. All P0s are built; the bar opens in about 12 ms and results appear about 10 ms after each keystroke.
- 13:01 UTC: **split** lane done. P0s are built; two depend on wiring in the tabs lane.
- 13:06 UTC: **core** lane done. All 18 core review items are fixed with tests, and the packaged app shrank from 46 MB to 1.35 MB of app code. Merged into PR #1; re-review running.
- 13:15–13:33 UTC: reviews of spaces (7 must-fix), commandbar (5 must-fix) and split (5 must-fix) came back. Each lane is fixing its findings.
- 13:26 UTC: **tabs** lane done (60 e2e tests). Its review is running.
- 13:36 UTC: macOS-only CI failures traced to two real bugs (a command bar race, a stuck fullscreen exit) and fixed.
- 13:40 UTC: **PR #1 merged to `main`.**

## Milestone 1: core experience that feels good
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | 🔨 lane running | 🟡 smoke test |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | 🔨 lane running | – |
| Spaces and profiles (SP, PR) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Command bar (CB) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Split view (SV) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Interaction feel (FL) | ✅ written | – | – |

## Next
1. Merge the lanes to `main` in order: tabs, spaces, commandbar, split. Each one needs its review fixes, green CI and a PR.
2. Milestone 1 capture (30–60 s clip + screenshots) and a `checkpoint` signal.
3. Next lanes: **chrome-nav** (top bar, address display, sidebar hide/hover/resize, navigation, find in page), **peek-mini**, **media**, **archive**, **settings/downloads/devtools**.

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
