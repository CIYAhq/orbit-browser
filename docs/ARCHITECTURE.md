# Orbit architecture

Orbit is an Electron app (Chromium + Node) written in TypeScript. Every tab is a real Chromium `WebContentsView`. Orbit's own UI (sidebar, command bar, menus) is a small React app. This document is the build team's map: how the pieces fit, who owns which files, and the performance and test rules every lane follows.

Clean room: the build team implements only from the behaviour spec (`/home/coder/orca/context/orbit/spec/`, IDs like `TB-02`) and the docs in this repo. Never from Arc material. See `CLEANROOM.md` in the Orca context directory.

## 1. Process and view model

```
BrowserWindow (frameless; hiddenInset traffic lights on macOS)
├── shell renderer (the window's own web contents)    React: sidebar + rounded content frame
├── tab WebContentsView × N (one per *visible* awake tab) positioned over the frame's pane rects
└── overlay WebContentsView (transparent, top-most)     React: command bar, Peek chrome, menus, popovers
```

- **Main process** (`src/main`) owns all state, all web contents, sessions, windows, menus, shortcuts and persistence.
- **Shell renderer** (`src/renderer`, `?view=shell`) draws the sidebar and an empty rounded "frame". It measures the frame (and split panes) and reports pane rectangles to main (`layout.panes` event). Main then places the native tab views exactly over them. Pages are never iframes.
- **Overlay renderer** (`?view=overlay`) is a transparent full-window view above the tabs. It's shown only while something floats (command bar, Peek card chrome, menus). Clicking its backdrop closes it.
- **Other renderer views**: `mini` (Mini Window chrome) and `settings` (settings window). They come from the same bundle and are selected by the `view` query.
- **Preload** (`src/preload/shell.ts`) runs sandboxed with context isolation. It exposes `window.orbit` (`OrbitBridge` in `src/shared/rpc.ts`) only to Orbit UI contents. Web pages get **no preload**. IPC handlers reject any sender that isn't registered Orbit UI.

## 2. State: one store, patches out

- `src/shared/state.ts` defines `OrbitState`: windows, spaces (+ `spaceOrder`), profiles, tabs, folders, splits, archive, settings, downloads and tweaks. It is plain JSON. IDs are prefixed (`t-` tab, `f-` folder, `v-` split, `s-` space, `p-` profile, `w-` window; `src/shared/ids.ts`).
- Sidebar membership is **containers of ordered item IDs**: `profile.favorites`, `space.pinned`, `space.today` and `folder.children`. An item is a tab, a folder or a split. `src/shared/tree.ts` has the only functions allowed to move items (`locate`, `insertItem`, `removeItem`, `moveItem`, `sidebarTabOrder`, `splitLeaves`…). It is unit-tested.
- `src/main/store.ts`: `store.update(draft => …)` applies an Immer recipe and produces patches. Synchronous listeners (window manager, persistence) see every update. Patch batches are coalesced per microtask, numbered (`seq`) and broadcast to every UI renderer.
- Renderers hold a **read-only mirror** (`src/renderer/src/store.ts`, zustand). They apply patches in sequence order and refetch a snapshot on a gap. Components subscribe to narrow slices (`useOrbit(selector)`), so a title change re-renders one row, not the sidebar.
- **Persistence** (`src/main/persist.ts`): debounced (400 ms) atomic JSON write (`.tmp` then rename) to `userData/orbit-state.json`, plus a flush on quit. On load, `normalizeState` fills defaults, resets runtime-only fields (`loading`, `audible`, `asleep`…) and keeps a corrupt file aside. Schema version is `STATE_SCHEMA`; migrations go in `normalizeState`.
- Large or append-heavy data (history, downloads list, archive beyond N entries, canvases) must **not** live in `OrbitState`. Those get their own store files or SQLite-free JSONL logs owned by their lane, behind commands. That keeps the broadcast state small.

## 3. Commands, events and actions

- **Commands** (renderer → main, request/response): `orbit.invoke('tabs.create', args)`. Each feature declares its command types in `src/shared/commands/<area>.ts`, composed into `OrbitCommands` in `src/shared/rpc.ts`, and registers handlers in `src/main/<area>/`. The `CommandRegistry` refuses duplicate names.
- **Events** (renderer → main, fire-and-forget) are for high-frequency signals such as `layout.panes` and perf marks.
- **Actions** are user-facing verbs (`tab.new`, `split.add`, `space.next`…). They are declared once in `src/shared/actions.ts` with title, category and default shortcuts (macOS and other). Main-process features register handlers in the `ActionRegistry`. The same table feeds keyboard shortcuts, the app menu and the command bar's action list.
- **Keyboard shortcuts** are matched in main via `before-input-event` on every Orbit-owned web contents **and** every tab, so they work whatever has focus. The renderer has a fallback (`src/renderer/src/shortcuts.ts`). The final shortcut set follows `spec/shortcuts.md` (KS-*). Remapping (ST-08) layers user overrides over the defaults.
- **Hooks** (`MainContext.hooks`) let features plug into tab creation, navigation and `window.open` without editing core files (Peek and Mini Window take over link opens this way).

## 4. Tabs: lifecycle, sleeping, layout

- A tab exists in state whether or not it is **awake**. `TabRuntime.ensure(tabId)` creates its `WebContentsView` lazily (sandboxed, per-profile session) and restores saved navigation history if the tab slept. `sleep(tabId)` saves history and closes the renderer process. That's how memory per idle tab stays low (TB-16). Sleeping is driven by `settings.sleepAfterMs`. Favorites stay warm (FV-08) and audible/visible tabs never sleep.
- **Tab switching fast path**: when the active tab changes in a single-pane layout, main swaps the views immediately using the last known pane rect (`WindowManager.fastSwitch`), without waiting for the shell to re-report. The shell's next report confirms it, and stale reports are dropped using `seq`. This keeps tab switching off the renderer's critical path.
- Views get `setBorderRadius(radius)` to match the frame's rounded corners (SB-19). Views not in the current layout are hidden, not destroyed.
- **Split View**: `Split.layout` is a tree (`row`/`column` nodes with `sizes`, tab leaves, max 4 leaves). The shell renders the split frame and dividers and reports N pane rects. Main places N views. A split is one sidebar item (`v-` id).
- **Peek** is an overlay state (`{kind: 'peek', tabId}`) plus a real tab view placed in a floating card the overlay draws chrome around. **Mini Window** is a `WindowState` with `kind: 'mini'` (small frameless window, its own view type).

## 5. Profiles and sessions

Each profile maps to an Electron session partition (`persist:orbit-<profileId>`; `src/main/sessions.ts`). That isolates cookies, storage, cache, permissions and extensions. A Space belongs to one profile, and Favorites belong to the profile. Sessions are configured once: Chrome-like user agent without "Electron", permission handler (ask once per origin), and downloads/extension/tweak listeners registered through `sessions.onSessionCreated`.

## 6. Renderer stack (and why)

| Choice | Why |
|---|---|
| **React 19** | Mature, fast enough with fine-grained selectors, best ecosystem for drag-and-drop and animation, familiar to contributors. The shell's hot paths (tab switch, scroll) don't depend on React render speed. Native views move in main. |
| **zustand + Immer patches** | Main is the single source of truth. Renderers apply small JSON patches instead of whole snapshots. Selector subscriptions keep re-renders local. |
| **motion** (Framer Motion's successor) | Spring physics for the sidebar, Space swipe, command bar and drag lift. Matching the feel spec (`feel.md`) needs springs, not CSS easing alone. |
| **@dnd-kit** | Accessible, pointer- and keyboard-driven sortable lists for tabs, folders and favorites. Works with virtualization. |
| **lucide-react** (ISC) | Neutral, original icon set. No Arc assets. |
| **Plain CSS with design tokens** (`styles/global.css`, `--orbit-*` variables from `src/shared/theme.ts` palettes) | Zero runtime cost. Space theme changes are a handful of CSS variable writes and can be animated. |
| **electron-vite + Vite 7**, **Biome**, **TypeScript 7** | Fast builds/HMR, one formatter+linter, strict types across main/preload/renderer. |

The sidebar list is virtualized once a Space exceeds ~150 rows (perf budget below). Rows are memoized by item ID.

## 7. Directory layout and lane ownership

```
src/main/            main process
  index.ts           boot; context assembly                         lead
  core.ts            window/overlay/sidebar commands                lead
  windows.ts         windows, views, layout, shortcuts routing      lead (split lane may extend layout)
  store.ts persist.ts registry.ts ipc.ts sessions.ts perf.ts       lead
  tabs/              tab model, runtime, commands, context menus    lane: sidebar-tabs
  spaces/            spaces, profiles, themes                       lane: spaces-profiles
  commandbar/        search providers and ranking                   lane: commandbar
  split/             split view commands                            lane: split
  peek/ miniwindow/  link preview, mini window                      lane: peek-mini
  media/             PiP, mini player                               lane: peek-mini (media)
  tweaks/ extensions/                                               lane: tweaks-extensions
  history/           browsing-history store (per-profile JSONL + index) lane: commandbar (query API used by archive)
  archive/                                                          lane: archive-persistence
  settings/ import/ downloads/ updates/                             lane: settings-import
src/shared/          types and pure logic shared by main+renderer (state, tree, url, theme, actions, commands/<area>.ts per lane)
src/renderer/src/
  shell/             sidebar + frame (sidebar/ is lane sidebar-tabs; SpaceBar is spaces-profiles)
  overlay/           command bar (commandbar lane), Peek chrome (peek-mini), menus
  styles/            tokens and global CSS (lead; lanes add namespaced blocks)
tests/unit/          vitest, pure logic and main modules with fakes
tests/e2e/           Playwright for Electron, one spec file per area, test titles carry feature IDs
scripts/             perf harness, feature checklist generator, icon rendering
```

Rules for lanes: stay inside your directories plus your own `src/shared/commands/<area>.ts`. Shared files (`state.ts`, `actions.ts`, `rpc.ts`, `global.css`) are edited with small, additive changes, and you say so in the PR description. New state fields need defaults in `src/shared/defaults.ts` and normalization in `persist.ts`.

## 8. Performance budgets

Measured by `scripts/perf/` (Electron under Xvfb on Linux; the same harness runs on macOS), with marks from `src/main/perf.ts` and the renderer (`perf.mark` event). Results go in `PERF.md` in the Orca context directory, next to Chrome numbers from the same machine.

| Metric | Budget | How |
|---|---|---|
| Cold start → first shell frame | ≤ 600 ms (Linux CI box), ≤ 400 ms on an M-series Mac | `main:start` → `shell:first-frame` |
| Cold start → active tab painted | ≤ 1.2 s, the page itself excluded | first `did-first-visually-non-empty-paint` |
| Tab switch (awake tab) | ≤ 16 ms main-side, visible next frame | `tabs.activate` → view swapped (fast path) |
| Space switch | ≤ 100 ms including theme transition start | command → shell frame with new list |
| Command bar open | ≤ 50 ms to visible input, results ≤ 30 ms per keystroke | overlay mark → input focus |
| Sidebar scroll with 200 tabs | 60 fps, no long tasks > 50 ms | Chrome tracing / `PerformanceObserver` long tasks |
| Memory per sleeping tab | ≈ 0 renderer processes; state entry only | `app.getAppMetrics()` |
| Memory per idle awake tab | ≤ Chrome's per-tab figure on the same page | `app.getAppMetrics()` vs Chrome's task manager |

Rules: no synchronous disk I/O on hot paths after boot, no full-state broadcasts after startup, debounce persistence, sleep background tabs, and keep the overlay renderer preloaded (hidden) so the command bar opens without a cold renderer.

## 9. Testing and CI

- **Unit** (`vitest`): shared logic (tree moves, URL parsing, accelerators, theme math, persistence normalization), main-process models with fakes. Fast; run on every commit.
- **E2E** (`@playwright/test` `_electron`): `tests/e2e/helpers.ts` launches the built app with an isolated `userData` and `ORBIT_E2E=1`. That exposes `globalThis.__orbit` test hooks in main (state, view bounds, run command) and serves local fixture pages from a loopback HTTP server. The app runs behind a dead local proxy that loopback bypasses, and `launchOrbit` waits until every profile's session uses it, so a test that searches or follows a link to a real site gets the URL but loads nothing. Playwright reaches main through the inspector, which can interrupt main-process code part-way, even inside a store update. So `launchOrbit` makes each `app.evaluate` start in a task of its own, and the hooks' `run` and `action` defer the same way (D25). Main logs an exception nothing caught as `[orbit] uncaught exception:` rather than letting Electron show its modal box, which blocks quitting. `app.close()` fails a test whose main process logged one (`takeUncaught()` claims one thrown on purpose). It also kills an app that hasn't quit 15 s after the quit reached main (main logs `[orbit] quit requested` in e2e mode), or that the quit hasn't reached 35 s after `app.close()` (D28). An app that quit on its own, when its last window closed, is checked by the next `launchOrbit()`. On Linux the failure names the main thread's kernel wait; on macOS, the deepest frames of a one-second `sample`. **Every test title starts with the feature IDs it covers**, e.g. `test('[TB-06][TB-07] close and reopen a tab', …)`. `scripts/features.mjs` reads those IDs to mark rows tested in `FEATURES.md`.
- **CI** (`.github/workflows/ci.yml`): typecheck + lint + unit (Linux), e2e under Xvfb (Linux), and build + unit + e2e + unsigned `.dmg`/`.zip` packaging (macOS). Green CI is required before merge.
- **Feel checks and clips**: `scripts/capture/record.mjs <scenario>` drives the built app through `scripts/capture/scenarios/<scenario>.mjs` while ffmpeg (`ORBIT_FFMPEG`, needs x11grab) records the X display, so native tab views are captured exactly as composited. Clips are named by feature ID and stored in `clips/` in the Orca context directory, screenshots in `screenshots/`. "Feels right" in `FEATURES.md` is a lead sign-off against `feel.md`.

## 10. Security baseline

Sandboxed, context-isolated renderers everywhere. No Node in pages. Pages never get a preload. IPC accepts registered Orbit UI senders only. UI renderers can't navigate or open windows. Permission prompts are per origin. Tweak JS (user-authored, per site) is injected only through `webFrame.executeJavaScript` in an isolated world, never with Node. Extensions use Electron's built-in extension support plus Orbit's own (MIT) API shims (D3: no GPL dependency).

## 11. Packaging and updates

`electron-builder` produces ad-hoc signed macOS `.dmg` and `.zip` (arm64 + x64) in CI, and a Linux `dir` build for local testing. Ad-hoc signing (`mac.identity: '-'`, no certificate) keeps arm64 Macs from rejecting the bundle as "damaged"; until Orbit has a Developer ID, a downloaded build still needs right-click → Open once (or `xattr -dr com.apple.quarantine /Applications/Orbit.app`). Licence and Open-source credits in About open `credits.html`, which the renderer build makes (`scripts/credits.ts`) so it comes with the app and opens offline (D43): Orbit's and Electron's licences, a link to the `LICENSES.chromium.html` Electron ships, and the licence of every npm package whose code ships. electron-builder drops that Chromium file from Mac apps, so `electron-builder.yml` puts it in Resources; main finds it there or beside the program (`src/main/settings/credits.ts`).

Updates (`src/main/updates/`, `src/shared/updates.ts`; UP-01…UP-12) are UP-10's stub: Orbit checks a release feed and offers a newer version's page in a tab. Nothing downloads or installs until Orbit is signed.
- **The feed.** None is set by default (Settings → General), and Orbit never checks without one. A feed address is https, or http to this computer; test and development builds only take one on this computer. A feed answers JSON: Orbit's own `{ version, url, summary?, security? }`, or a GitHub release, or a list of them, as GitHub's REST API returns them (drafts and pre-releases skipped).
- **When.** 30 s after launch, then every 4 h ± 30 min; at once when the feed changes; after waking from sleep if a check fell due. Automatic checks can be turned off. Check for Updates (app menu, command bar) opens About and checks now; About and General have the same button.
- **How.** Each check uses an in-memory session of its own (no cookies, cache or profile data). The user agent says only Orbit's version, system and processor. It follows no redirect, gives up after 20 s and reads at most 1 MB.
- **What shows.** The result is `state.updates`: runtime only, never saved. A newer version shows as the sidebar's banner and in Settings (UP-02); a security release says so (UP-12). Its ✕ hides it for about a day or until the next launch. Download opens the release's page. A failed check shows only in Settings and keeps what an earlier check found. After an update, a What's new banner shows for a few days (UP-06).

Only packages the main process imports at runtime belong in `dependencies` (today just `immer`); they are the only `node_modules` packed into `app.asar`. Renderer packages (React, motion, lucide, dnd-kit, zustand) are bundled by Vite and live in `devDependencies`.
