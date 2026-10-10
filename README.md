# Orbit

An open-source, Chromium-based browser built around a vertical sidebar: Spaces with their own colours, pinned tabs and Favorites that always return to their page, Today tabs that tidy themselves away into an Archive, folders, Split View, a command bar, link previews and a mini window for links from other apps. It's written in TypeScript on Electron, so every tab is real Chromium with Chromium DevTools and Chrome extensions.

> **Status: pre-alpha.** The core experience is being built now. [FEATURES.md](FEATURES.md) is the feature checklist: every behaviour in the spec, and whether it is built, tested and feels right.

## Clean room

Orbit is an independent, clean-room implementation in the spirit of Arc. It was built from a behaviour specification written in our own words from public documentation and observed behaviour, never from another browser's code, binaries or assets. Its name, icon and interface text are original. **Orbit is not affiliated with, endorsed by or connected to The Browser Company or Atlassian.**

## Develop

Requirements: Node.js 22+ and npm. macOS is the primary target. Linux works for development and testing.

```sh
npm ci
npm run dev          # run with hot reload
npm run build        # production build into out/
npm start            # run the production build
```

Checks:

```sh
npm run typecheck
npm run lint
npm test             # unit tests (vitest)
npm run test:e2e     # end-to-end tests (Playwright for Electron); run `npm run build` first
```

Before a merge, the whole check runs locally on the PR's head ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §9). Its e2e run uses one worker, no retries and a 1440×900 screen; on Linux without a display:

```sh
xvfb-run -a -s "-screen 0 1440x900x24" npx playwright test --workers 1 --retries 0
```

Performance and screen captures (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §8–9):

```sh
npm run perf                      # cold start, tab/Space switch, command bar, scroll, memory vs Chromium
ORBIT_FFMPEG=/path/to/ffmpeg npm run capture -- <scenario>   # needs an ffmpeg with x11grab
```

Packaging (unsigned):

```sh
npm run package:mac      # .dmg and .zip (arm64 + x64) in release/
npm run package:linux    # unpacked Linux build in release/
```

Build the macOS `.dmg`/`.zip` on a Mac. The CI workflow that built them (on pushes to `main`, on manual runs and for PRs labelled `package`) is turned off.

## How it's built

- **Main process** owns all state (one store, broadcast to the UI as small patches), every tab's `WebContentsView`, sessions (one per profile), windows, shortcuts and persistence.
- **UI** is React 19 in sandboxed renderers: the sidebar shell, plus a transparent overlay for the command bar, link previews and menus.
- **Tabs** sleep when idle and wake on demand, so a sidebar with hundreds of tabs stays light.

The full map, file ownership and performance budgets are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).
