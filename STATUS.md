# Orbit status

_Last updated: 2026-10-09 11:20 UTC by the lead (relaunched session)._

## In plain words
Orbit is a working skeleton. It opens a window with a vertical sidebar, Spaces, Favorites and a command bar, and every tab is a real Chromium page. CI is green on Linux and macOS. The behaviour spec is now complete: 22 areas, 484 behaviours, 174 of them P0. Two build lanes are working in parallel: **tabs** (tabs, pinned, Favorites, Today, folders) and **split** (split view). An independent reviewer is checking the scaffold PR. First performance numbers are in: tab switch 2 ms, command bar 6 ms, Space switch 16 ms, smooth 60 fps sidebar scroll with 200 tabs, and less memory per tab than Chromium. Cold start is 115 ms over budget.

## What happened so far
- 05:37–06:14 UTC: first lead run. Spec team started, repo scaffolded (branch `wip/scaffold`). The lead then hung.
- 10:52 UTC: lead relaunched. Checked the scaffold (green), relaunched the missing spec work, and wrote this file, `FEATURES.md` and `docs/ARCHITECTURE.md`.
- 10:59 UTC: scaffold opened as PR #1. CI went green on Linux and macOS.
- 11:00–11:10 UTC: build lanes **tabs** and **split** started in their own worktrees.
- 11:15 UTC: performance harness (`npm run perf`) and screen-capture recorder (`npm run capture`) added. First results are in `PERF.md`.
- 11:17 UTC: all missing spec areas landed (Spaces/profiles, feel, command bar, navigation, shortcuts, split view, link preview, mini window, media).

## Milestone 1: core experience that feels good
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | 🔨 lane running | 🟡 smoke test |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | 🔨 lane running | – |
| Spaces and profiles (SP, PR) | ✅ written | 🟡 scaffold | – |
| Command bar (CB) | ✅ written | 🟡 scaffold | 🟡 smoke test |
| Split view (SV) | ✅ written | 🔨 lane running | – |
| Interaction feel (FL) | ✅ written | – | – |

## Next
1. Merge PR #1 once the review passes (macOS packaging fix is in CI now).
2. Start the next lanes as slots free up (at most 5 agents at once): **spaces-profiles**, **commandbar**, **chrome-nav** (sidebar chrome, address display, navigation), then **peek-mini**, **media** and **archive**.
3. Bring cold start under budget.

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
