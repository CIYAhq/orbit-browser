import { registerArchive } from './archive'
import { registerSearch } from './commandbar/search'
import type { MainContext } from './context'
import { registerCore } from './core'
import { registerDownloads } from './downloads'
import { registerExtensions } from './extensions'
import { registerHistory } from './history'
import { registerImport } from './import'
import { registerMedia } from './media'
import { registerMiniWindow } from './miniwindow'
import { registerNav } from './nav'
import { registerPeek } from './peek'
import { registerSettings } from './settings'
import { registerSpaces } from './spaces/commands'
import { registerSplit } from './split'
import { registerTabs } from './tabs/commands'
import { registerTweaks } from './tweaks'
import { registerUpdates } from './updates'

/** Every feature module registers its commands, actions and hooks here, in dependency order. */
export function registerFeatures(ctx: MainContext): void {
  registerCore(ctx)
  const { ops } = registerTabs(ctx)
  registerNav(ctx, ops)
  registerSpaces(ctx)
  const history = registerHistory(ctx)
  registerSearch(ctx, history)
  registerSplit(ctx)
  registerArchive(ctx)
  registerPeek(ctx)
  registerMiniWindow(ctx)
  registerMedia(ctx)
  registerTweaks(ctx)
  registerExtensions(ctx)
  registerDownloads(ctx)
  registerSettings(ctx)
  registerImport(ctx, history)
  registerUpdates(ctx)
}
