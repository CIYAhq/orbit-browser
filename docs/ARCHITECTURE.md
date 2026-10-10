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
- **Preload** (`src/preload/shell.ts`) runs sandboxed with context isolation. It exposes `window.orbit` (`OrbitBridge` in `src/shared/rpc.ts`) only to Orbit UI contents, and its `orbit:*` IPC handlers reject any sender that isn't registered Orbit UI. Web pages get one preload of their own, `src/preload/page.ts` (NV-15), on D40's terms. It runs in main frames only and adds nothing to page globals: it patches only the built-ins NV-15 needs (`Notification.permission`, `Notification.requestPermission`, the `Notification` constructor and `PermissionStatus.prototype.state`), so a permission the user hasn't decided reads "default"/"prompt" as in Chromium and a click on one of the page's notifications reaches main. It talks to main only over its own `orbit-page:*` channels, separate from the UI's `orbit:*` channels, and main takes the origin and profile from `event.senderFrame`, never from the message.

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
- **E2E** (`@playwright/test` `_electron`): `tests/e2e/helpers.ts` launches the built app with an isolated `userData` and `ORBIT_E2E=1`. That exposes `globalThis.__orbit` test hooks in main (state, view bounds, run command) and serves local fixture pages from a loopback HTTP server. The app runs behind a dead local proxy that loopback bypasses, and `launchOrbit` waits until every profile's session uses it, so a test that searches or follows a link to a real site gets the URL but loads nothing. Playwright reaches main through the inspector, which can interrupt main-process code part-way, even inside a store update. So `launchOrbit` makes each `app.evaluate` start in a task of its own, and the hooks' `run` and `action` defer the same way (D25). Main logs an exception nothing caught as `[orbit] uncaught exception:` rather than letting Electron show its modal box, which blocks quitting. `app.close()` fails a test whose main process logged one (`takeUncaught()` claims one thrown on purpose), and kills an app that hasn't quit 15 s after being asked (D28). **Every test title starts with the feature IDs it covers**, e.g. `test('[TB-06][TB-07] close and reopen a tab', …)`. `scripts/features.mjs` reads those IDs to mark rows tested in `FEATURES.md`.
- **CI** (`.github/workflows/ci.yml`): typecheck + lint + unit (Linux), e2e under Xvfb (Linux), and build + unit + e2e + unsigned `.dmg`/`.zip` packaging (macOS). Green CI is required before merge.
- **Feel checks and clips**: `scripts/capture/record.mjs <scenario>` drives the built app through `scripts/capture/scenarios/<scenario>.mjs` while ffmpeg (`ORBIT_FFMPEG`, needs x11grab) records the X display, so native tab views are captured exactly as composited. Clips are named by feature ID and stored in `clips/` in the Orca context directory, screenshots in `screenshots/`. "Feels right" in `FEATURES.md` is a lead sign-off against `feel.md`.

## 10. Security baseline

Sandboxed, context-isolated renderers everywhere. No Node in pages. Pages get one preload, `src/preload/page.ts`, on D40's terms: main frames only, nothing added to page globals, built-ins patched only where the spec needs Chromium's behaviour (captured before the page runs, `Reflect.apply` included), and its own `orbit-page:*` channels. Main takes a page's origin and profile from the sender frame (`event.senderFrame`), never from the message, and each channel either returns read-only state for that origin or carries a request main checks against its own state before acting. Its uses, all of them (any other channel, patch or global is a lead decision, D40):
- `orbit-page:permission` (NV-15): a synchronous read of how a permission reads for the sending frame's own origin and profile ("prompt" while the user hasn't decided). Read-only.
- `orbit-page:notification-click` (NV-15): a trusted click on one of the page's notifications. Main brings the tab forward only for a site allowed to show notifications, and at most once per `NOTIFICATION_CLICK_GAP_MS` per tab.

The UI's `orbit:*` IPC accepts registered Orbit UI senders only. UI renderers can't navigate or open windows. Permission prompts are per origin. Tweak JS (user-authored, per site) is injected only through `webFrame.executeJavaScript` in an isolated world, never with Node. Extensions use Electron's built-in extension support plus Orbit's own (MIT) API shims (D3: no GPL dependency).

## 11. Packaging and updates

`electron-builder` produces ad-hoc signed macOS `.dmg` and `.zip` (arm64 + x64) in CI, and a Linux `dir` build for local testing. Ad-hoc signing (`mac.identity: '-'`, no certificate) keeps arm64 Macs from rejecting the bundle as "damaged"; until Orbit has a Developer ID, a downloaded build still needs right-click → Open once (or `xattr -dr com.apple.quarantine /Applications/Orbit.app`). The updater is a stub for now (UP-10): it checks a release feed, says when a newer version exists, and links to it. There's no silent install until signing exists.

Only packages the main process imports at runtime belong in `dependencies` (today just `immer`); they are the only `node_modules` packed into `app.asar`. Renderer packages (React, motion, lucide, dnd-kit, zustand) are bundled by Vite and live in `devDependencies`.
