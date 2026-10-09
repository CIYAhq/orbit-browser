# Orbit status

_Last updated: 2026-10-09 11:06 UTC by the lead (relaunched session)._

## In plain words
Orbit is a working skeleton. It opens a window with a vertical sidebar, Spaces, Favorites and a command bar, and every tab is a real Chromium page. The code typechecks, all 40 unit tests pass and the app builds. The behaviour spec is about 60% written: 13 of 22 areas, 276 behaviours. Three spec researchers are now writing the missing areas: Spaces/profiles, interaction feel, command bar, navigation, keyboard shortcuts, split view, link preview, mini window and media. Nothing is merged to `main` yet.

## What happened so far
- 05:37–06:14 UTC: first lead run. Spec team started, repo scaffolded (branch `wip/scaffold`). The lead then hung.
- 10:52 UTC: lead relaunched. Checked the scaffold (green), relaunched the missing spec work, and wrote this file, `FEATURES.md` and `docs/ARCHITECTURE.md`.

## Milestone 1: core experience that feels good
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | 🟡 scaffold | 🟡 smoke test |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | 🟡 scaffold | – |
| Spaces and profiles (SP, PR) | ⏳ being written | 🟡 scaffold | – |
| Command bar (CB) | ⏳ being written | 🟡 scaffold | 🟡 smoke test |
| Split view (SV) | ⏳ being written | – | – |
| Interaction feel (FL) | ⏳ being written | – | – |

## Next
1. Open the scaffold as PR #1 so CI (Linux + macOS) runs. Get an independent review, then merge to `main`.
2. Start build lanes from `main`, each in its own worktree: **sidebar-tabs** first (its spec is ready), then **spaces-profiles**, **commandbar** and **split** as their spec files land. At most 5 agents at once.
3. Write the performance harness and record the first numbers vs Chrome in `PERF.md`.

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
