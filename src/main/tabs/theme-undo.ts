import type { ColorMode, OrbitState, OverlayState, SpaceId, SpaceTheme, WindowId } from '../../shared/state'
import type { MainContext } from '../context'
import type { UndoStack } from './undo'

/** The theme picker's overlay panel (SP-14). */
const THEME_PANEL = 'space-theme'

interface Look {
  theme: SpaceTheme
  appearance: ColorMode
}

/** The Space a theme picker in this overlay state edits, if one is open. */
export function themePickerSpace(overlay: OverlayState | undefined): SpaceId | undefined {
  if (overlay?.kind !== 'panel' || overlay.panel !== THEME_PANEL) return undefined
  const spaceId = overlay.params?.spaceId
  return typeof spaceId === 'string' ? spaceId : undefined
}

const sameLook = (a: Look, b: Look) =>
  a.appearance === b.appearance && JSON.stringify(a.theme) === JSON.stringify(b.theme)

/**
 * ⌘Z after the theme picker closes reverts what it changed (SP-14): the Space's theme as it was when
 * the picker opened, and the light/dark setting too if it was changed there (SP-18). ⌘⇧Z puts the
 * change back. Each opening of the picker is one change, however many it made while it was open.
 */
export function registerThemeUndo(ctx: MainContext, undo: Pick<UndoStack, 'push'>): void {
  const { store, commands } = ctx
  /** Each window's open picker: the Space it edits and how it looked when the picker opened. */
  const open = new Map<WindowId, { spaceId: SpaceId; before: Look }>()

  const lookOf = (state: OrbitState, spaceId: SpaceId): Look | undefined => {
    const theme = state.spaces[spaceId]?.theme
    return theme ? { theme, appearance: state.settings.appearance } : undefined
  }

  const apply = (spaceId: SpaceId, look: Look) => {
    const now = lookOf(store.state, spaceId)
    if (!now) return
    if (JSON.stringify(now.theme) !== JSON.stringify(look.theme)) {
      void commands.run('spaces.update', { spaceId, theme: look.theme })
    }
    if (now.appearance !== look.appearance) void commands.run('spaces.setAppearance', { appearance: look.appearance })
  }

  const record = (spaceId: SpaceId, before: Look, after: Look) => {
    undo.push(
      'Change Theme',
      () => {
        apply(spaceId, before)
        return () => {
          apply(spaceId, after)
          record(spaceId, before, after)
        }
      },
      Date.now(),
      // The Space was deleted since: nothing to revert.
      () => !store.state.spaces[spaceId],
    )
  }

  const closed = (windowId: WindowId, state: OrbitState) => {
    const session = open.get(windowId)
    open.delete(windowId)
    if (!session) return
    const after = lookOf(state, session.spaceId)
    if (after && !sameLook(session.before, after)) record(session.spaceId, session.before, after)
  }

  store.subscribe((next, prev) => {
    if (next.windows === prev.windows) return
    for (const windowId of open.keys()) if (!next.windows[windowId]) closed(windowId, next)
    for (const [windowId, win] of Object.entries(next.windows)) {
      const was = prev.windows[windowId]?.overlay
      if (win.overlay === was) continue
      const spaceId = themePickerSpace(win.overlay)
      // The same picker, still open (its overlay state was only touched).
      if (spaceId && spaceId === open.get(windowId)?.spaceId && win.overlay.kind === was?.kind) continue
      closed(windowId, next)
      const before = spaceId ? lookOf(next, spaceId) : undefined
      if (spaceId && before) open.set(windowId, { spaceId, before })
    }
  })
}
