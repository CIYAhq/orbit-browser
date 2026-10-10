import { type MenuItemConstructorOptions, nativeImage } from 'electron'
import type { CommandResult } from '../../shared/rpc'
import type { WindowId } from '../../shared/state'
import type { MainContext } from '../context'

/** How many closed tabs the Recently Closed list shows (AR-09: "the last ~10 items"). */
export const RECENTLY_CLOSED_SHOWN = 10
const MAX_LABEL = 60
/** Changes to the tabs settle for this long before the list is read again. */
const REFRESH_MS = 150

type Closed = CommandResult<'tabs.recentlyClosed'>[number]

let shown: Closed[] = []

const label = (c: Closed): string => {
  const text = (c.title || c.url).replace(/\s+/g, ' ').trim()
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}

/** The tab's favicon at menu size (macOS menus show icons); none when it is missing or unreadable. */
const iconOf = (c: Closed): Electron.NativeImage | undefined => {
  if (process.platform !== 'darwin' || !c.favicon?.startsWith('data:image/')) return undefined
  try {
    const icon = nativeImage.createFromDataURL(c.favicon)
    return icon.isEmpty() ? undefined : icon.resize({ width: 16, height: 16 })
  } catch {
    return undefined
  }
}

/**
 * The Recently Closed list (AR-09): the last closed tabs, newest first, each reopening that tab
 * (in its place, with its history, TB-07) in the window that asks. Built from the list read last
 * (`watchRecentlyClosed`), so the app menu can be made at once.
 */
export function recentlyClosedItems(
  ctx: MainContext,
  windowIdOf: () => WindowId | undefined = () => ctx.windows.focusedWindowId(),
): MenuItemConstructorOptions[] {
  if (shown.length === 0) return [{ label: 'No Recently Closed Tabs', enabled: false }]
  return shown.map((c) => {
    const icon = iconOf(c)
    return {
      label: label(c),
      ...(icon ? { icon } : {}),
      click: () => {
        ctx.commands
          .run('tabs.reopenClosed', { tabId: c.tabId }, { windowId: windowIdOf() })
          .catch((err) => console.error('[archive] could not reopen a closed tab', err))
      },
    }
  })
}

/** Reads the list now (a menu is about to show). True when it changed. */
export async function refreshRecentlyClosed(ctx: MainContext): Promise<boolean> {
  const list = ctx.commands.has('tabs.recentlyClosed')
    ? (await ctx.commands.run('tabs.recentlyClosed', {})).slice(0, RECENTLY_CLOSED_SHOWN)
    : []
  const key = (l: Closed[]) => JSON.stringify(l.map((c) => [c.tabId, c.title, c.url, !!c.favicon]))
  if (key(list) === key(shown)) return false
  shown = list
  return true
}

/** Keeps the list current as tabs close and come back; `onChange` rebuilds what shows it (the app menu). */
export function watchRecentlyClosed(ctx: MainContext, onChange: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let tabs = ctx.store.state.tabs
  ctx.store.subscribe((next) => {
    if (next.tabs === tabs) return
    tabs = next.tabs
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      refreshRecentlyClosed(ctx)
        .then((changed) => {
          if (changed) onChange()
        })
        .catch((err) => console.error('[archive] could not read recently closed tabs', err))
    }, REFRESH_MS)
  })
}
