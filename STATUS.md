# Orbit status

_Last updated: 2026-10-09 19:55 UTC by the lead (third session, after the usage-limit stop)._

## In plain words
`main` has the scaffold (PR #1), the full tabs experience (PR #2), Spaces (PR #3), the command bar (PR #4) and, since 19:44 UTC, split view (PR #5). **Every milestone-1 area is on `main`, and milestone 1 is recorded.** Spaces covers themes and the two-finger swipe, profiles with separate cookies, and per-profile Favorites.

- **Milestone-1 capture (19:50 UTC):** a 37-second screen recording of the core experience, built from `main`, plus six screenshots. They show the sidebar, the command bar switching tabs and running an action, a swipe between Spaces, and a three-pane split. A `checkpoint` signal was sent.
  - Clip: `clips/milestone1.mp4`. Screenshots: `screenshots/milestone1-01-sidebar.png` to `milestone1-06-commandbar-action.png` (Orca context directory).
- **Command bar (PR #4):** merged at 19:07 UTC, green on Linux and macOS. Its macOS checks found two test problems on the way, both fixed:
  - one test left a web address on the clipboard, and later tests saw it;
  - a timing race in the reduced-motion check.
- **Split view (PR #5):** merged at 19:44 UTC, green on Linux and macOS. Before merging, I fixed the reviewer's last drag finding (W1) and added a test for it. I also made 12 split tests pass on the macOS test machine. The causes:
  - shortcuts written as Ctrl rather than ⌘;
  - the machine's smaller window;
  - rows measured while still animating in;
  - one race in a test.
- **Running now:**
  - **peek** (link preview and Mini Window) and **media** (picture-in-picture, media tray) are finishing their work;
  - **chrome** (sidebar top, show/hide, navigation) has been running since 18:55 UTC.

At about 15:00 UTC the shared Claude usage limit stopped the previous lead and five running lanes. Their unfinished work was saved and nothing was lost. The peek and media lanes have resumed from it. From now on at most three agents run at once (decision D16).

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
- ~15:00 UTC: the shared Claude usage limit stopped the lead and the peek, media, settings, downloads and spaces lanes. A watchdog saved their uncommitted work at 15:31.
- 17:54 UTC: lead relaunched (third session). Fixed the two CI failures on PR #3: a swipe edge case on busy machines, and two timing-sensitive tests.
- 18:01 UTC: peek and media lanes resumed from their saved work.
- 18:10 UTC: **PR #3 (Spaces) merged to `main`.** PR #4 (command bar) opened, with two small review follow-ups fixed.
- 18:15–18:50 UTC:
  - Three macOS CI rounds on PR #4. The causes, all now fixed:
    - a test-only clipboard leak (macOS keeps the clipboard after the app quits);
    - a reduced-motion timing race;
    - the macOS CI machine drawing frames 4–8× slower than budget (D17).
  - The command bar also got a guard: a mouse resting where the bar opens no longer picks a row.
  - Split view merged with Spaces and the command bar.
  - The flaky Spaces swipe test was hardened.
  - Briefs written for the next lanes: chrome (sidebar top, show/hide, navigation, find, zoom, windows), archive (Archive and Library), settings (Settings window, appearance, onboarding, updates), downloads (downloads, DevTools, import) and keys (one keymap, remapping).
- 18:55 UTC: lane **chrome** started.
- 19:07 UTC: **PR #4 (command bar) merged to `main`.**
- 19:44 UTC: **PR #5 (split view) merged to `main`**, after the W1 fix and the macOS test fixes.
- 19:50 UTC: **milestone-1 capture recorded** from `main` (37 s, six screenshots). `checkpoint` signal sent.
  - The first take swiped two Spaces instead of one. The machine was busy (load average 31), so the scripted swipe's events reached the app more than 90 ms apart, and the app read them as two swipes.
  - A real swipe can't skip a Space: its movement is capped at one sidebar width. So this was the recording, not the product.
  - The capture now sends each swipe from inside the page at a fixed 16 ms rhythm, as the tests do. Its mouse pointer now moves on screen too.

## Milestone 1: core experience that feels good (✅ reached 19:50 UTC)
Target: sidebar, tabs, Spaces, pinned tabs and Favorites, command bar and split view all work and feel smooth. That includes a 30–60 s screen capture under Xvfb, screenshots and a `checkpoint` signal.

| Area | Spec | Code | Tests |
|---|---|---|---|
| Sidebar and tabs (SB, TB) | ✅ written | ✅ merged (PR #2) | ✅ unit + e2e |
| Pinned, Favorites, Today, Folders (PN, FV, TD, FD) | ✅ written | ✅ merged (PR #2) | ✅ unit + e2e |
| Spaces and profiles (SP, PR) | ✅ written | ✅ merged (PR #3) | ✅ unit + e2e |
| Command bar (CB) | ✅ written | ✅ merged (PR #4) | ✅ unit + e2e |
| Split view (SV) | ✅ written | ✅ merged (PR #5) | ✅ unit + e2e |
| Interaction feel (FL) | ✅ written | – | – |

**Capture:** ✅ `clips/milestone1.mp4` (37 s, 1440×900) and six screenshots, recorded from `main` at 19:50 UTC. `checkpoint` signal sent.

## Next
1. Review and merge **peek** and **media** when their agents finish.
2. Start the next lanes, three agents at a time. Briefs are in `lanes/`. Order:
   1. **chrome:** sidebar top, show/hide, resize, navigation, find in page, zoom, windows. *(running since 18:55 UTC)*
   2. **archive:** Archive and Library.
   3. **settings:** Settings window, appearance, onboarding, updates.
   4. **downloads:** downloads, DevTools, import.
   5. **keys:** one keymap, remapping, conflicts with pages.
   6. Then tweaks and extensions, and a "feel" audit.
3. Land the lead's branch `lead/docs` as one reviewed PR. It holds the capture tooling, the milestone tour and the Spaces swipe-test hardening.
4. Performance follow-up: the first mount of a 200-tab Space takes about 1.2 s. The budget for a Space switch is 100 ms.
5. Small follow-ups for a later polish lane (none blocks a merge):
   - **Split W2:** resting on a row arms a split only on the half of the row nearer where the drag started. On the other half, the reorder gap slides the row away.
   - **Tabs W3:** undoing Delete Folder after the Space changed profile brings the tab back on the old profile.
   - **Split:** the Favorites limit counts each pane, and a full split's rows still highlight as drop targets.
   - **Command bar N3.**
   - **Spaces:** panels lost their overlay fade-in.

## Blockers
None. All decisions are logged in `DECISIONS.md` (Orca context directory).
