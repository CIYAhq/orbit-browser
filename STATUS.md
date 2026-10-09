# Orbit status

_Last updated: 2026-10-09 14:40 UTC by the lead (relaunched session)._

## In plain words
`main` now has the scaffold with its review fixes (PR #1) and the full tabs experience (PR #2): tabs, pinned tabs, Favorites, Today with auto-archive, folders and drag and drop. CI is green on Linux and macOS. Spaces, command bar and split view are reviewed, fixed and verified. They merge next, in that order. Two more lanes started from `main`: **peek** (link preview + Mini Window) and **media** (picture-in-picture, sidebar media controls). After the three merges comes the milestone-1 screen capture.

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
- 13:58 UTC: lane **peek** (link preview + Mini Window) started.
- 14:25 UTC: **PR #2 (tabs) merged to `main`** after review, verified fixes and green CI. On the way, two CI-only test problems were fixed: the macOS runner's small screen clamped a window, and slow 2-core runners needed longer waits.
- 14:31 UTC: lane **media** (picture-in-picture, media tray) started.
- 14:32–14:37 UTC: commandbar and spaces fixes verified by their reviewers.

## Milestone 1: core experience that feels good
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | ✅ merged (PR #2) | ✅ unit + e2e |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | ✅ merged (PR #2) | ✅ unit + e2e |
| Spaces and profiles (SP, PR) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Command bar (CB) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Split view (SV) | ✅ written | ✅ built (in review) | ✅ unit + e2e |
| Interaction feel (FL) | ✅ written | – | – |

## Next
1. Merge spaces, then commandbar, then split. Each is verified; each needs its final merge with `main` and green CI.
2. Milestone 1 capture (30–60 s clip + screenshots) and a `checkpoint` signal.
3. Review and merge **peek** and **media**. Then start **chrome-nav** (top bar, address display, sidebar hide/hover/resize, navigation, find in page), **archive** and **settings/downloads/devtools**.
4. Performance follow-up: mounting a 200-tab list for the first time takes about 1.2 s (budget: Space switch ≤ 100 ms).

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
