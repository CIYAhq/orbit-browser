/**
 * Typed RPC between renderers and the main process.
 *
 * - Commands: renderer → main request/response (`orbit.invoke(name, args)`).
 * - Events: renderer → main fire-and-forget (`orbit.send(name, payload)`), for
 *   high-frequency updates such as pane layout.
 *
 * Each feature area declares its commands in its own file under ./commands/
 * (owned by that area's build lane) and is composed here.
 */
import type { ArchiveCommands } from './commands/archive'
import type { CommandBarCommands } from './commands/commandbar'
import type { CoreCommands, CoreEvents } from './commands/core'
import type { DevtoolsCommands } from './commands/devtools'
import type { DownloadCommands } from './commands/downloads'
import type { ExtensionCommands } from './commands/extensions'
import type { HistoryCommands } from './commands/history'
import type { ImportCommands } from './commands/import'
import type { KeyCommands } from './commands/keys'
import type { MediaCommands, MediaEvents } from './commands/media'
import type { NavCommands } from './commands/nav'
import type { PagesCommands } from './commands/pages'
import type { PeekCommands, PeekEvents } from './commands/peek'
import type { SettingsCommands } from './commands/settings'
import type { SpaceCommands } from './commands/spaces'
import type { SplitCommands } from './commands/split'
import type { TabCommands } from './commands/tabs'
import type { TweakCommands } from './commands/tweaks'

export interface OrbitCommands
  extends CoreCommands,
    TabCommands,
    SpaceCommands,
    CommandBarCommands,
    HistoryCommands,
    SplitCommands,
    ArchiveCommands,
    PeekCommands,
    TweakCommands,
    ExtensionCommands,
    SettingsCommands,
    DownloadCommands,
    DevtoolsCommands,
    ImportCommands,
    NavCommands,
    MediaCommands,
    KeyCommands,
    PagesCommands {}

export interface OrbitEvents extends CoreEvents, PeekEvents, MediaEvents {}

export type CommandName = keyof OrbitCommands
export type CommandArgs<K extends CommandName> = OrbitCommands[K] extends { args: infer A } ? A : never
export type CommandResult<K extends CommandName> = OrbitCommands[K] extends { result: infer R } ? R : never
export type EventName = keyof OrbitEvents

/** One JSON patch operation (structurally identical to Immer's Patch). */
export interface StatePatch {
  op: 'replace' | 'remove' | 'add'
  path: (string | number)[]
  value?: unknown
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Which UI a renderer instance is showing. */
export type RendererView =
  | 'shell'
  | 'overlay'
  | 'mini'
  | 'settings'
  | 'strip'
  | 'sidebar'
  | 'tools'
  | 'prompt'
  /** The page loading indicator (SB-28) and the link status pill (SB-27), chrome lane. */
  | 'loading'
  | 'link'
  /** Archive lane: the Library view. */
  | 'library'
  /** Media lane: the picture-in-picture window. */
  | 'pip'
  /** Settings lane: the first-run onboarding window (OB-01). */
  | 'onboarding'
  /** Import lane: the import window (IM-01). */
  | 'import'
  /** Downloads lane: an internal page, `orbit://<page>/` in a tab (DT-13). */
  | 'internal'
  /** Pages lane: a page's dialog over its page (alert, confirm, prompt, leave-page, sign-in; NV-24). */
  | 'dialog'
  /** Pages lane: what a page's area shows when its page couldn't load or crashed (NV-13, NV-14). */
  | 'screen'
  /** Pages lane: the print dialog over a page (NV-07). */
  | 'print'
  /** Pages lane: the arrow a two-finger swipe over a page slides in (NV-02). */
  | 'swipe'

/** The API the preload exposes on `window.orbit` to Orbit's own UI renderers. */
export interface OrbitBridge {
  windowId: string
  view: RendererView
  platform: string
  invoke<K extends CommandName>(name: K, args: CommandArgs<K>): Promise<CommandResult<K>>
  send<K extends EventName>(name: K, payload: OrbitEvents[K]): void
  getState(): Promise<{ state: import('./state').OrbitState; seq: number }>
  onPatches(listener: (seq: number, patches: StatePatch[]) => void): () => void
  /** Main → renderer notifications (e.g. "overlay:focus-input"). */
  on(channel: string, listener: (payload: unknown) => void): () => void
}
