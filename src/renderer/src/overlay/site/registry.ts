import type { ComponentType } from 'react'
import type { SiteControlsInfo } from '../../../../shared/site'
import type { TabId } from '../../../../shared/state'

/** What every registered section's component gets. */
export interface SiteSectionProps {
  /** The tab the panel is for. */
  tabId: TabId
  /** What main said about its page (`site.info`): URL, host, connection, `web`, `private`… */
  info: SiteControlsInfo
  /** Asks main for `info` again, e.g. after a change that the built-in rows show. */
  refresh(): void
  /** Closes the panel, e.g. before opening something of the section's own in its place. */
  close(): Promise<void>
}

/**
 * The site controls panel's section registry (NV-16): other features' rows in the panel, such as
 * a site's Tweaks (BO-14) or the extensions that may read it (extensions lane).
 *
 * A section is a block of rows between the panel's built-in ones. Sections are found by file name:
 * every module under `src/renderer/src/` whose name ends in `.site-controls.tsx` and exports
 * `section: SiteControlsSection` is in the panel, so adding one edits no panel file:
 *
 * ```tsx
 * // src/renderer/src/tweaks/tweaks.site-controls.tsx
 * import type { SiteControlsSection, SiteSectionProps } from '../overlay/site/registry'
 *
 * function TweakRows({ tabId, info }: SiteSectionProps) {
 *   if (!info.web) return null
 *   return (
 *     <section className="site-panel__section" aria-label="Tweaks">
 *       <h3 className="site-panel__title">Tweaks</h3>
 *       <ul className="site-panel__rows">…</ul>
 *     </section>
 *   )
 * }
 *
 * export const section: SiteControlsSection = { id: 'tweaks', order: 45, component: TweakRows }
 * ```
 *
 * - `id`: stable and unique (the first module of a duplicate id wins); the section's React key.
 * - `order`: its place among the built-in sections, low first. The panel's own are Permissions 20,
 *   Devices 30, Picture in Picture 40 and Zoom 50, between the header (site, connection, Reload)
 *   and the footer (reset permissions, clear site data). Pick a number between two to slot in.
 * - `component`: rendered with `SiteSectionProps` once `site.info` has answered, on every kind of
 *   page; it returns null where it has nothing to say (`info.web` is false on internal, file and
 *   blank pages). Build it from the panel's classes (`site.css`): `site-panel__section`,
 *   `site-panel__title`, `site-panel__rows`, `site-panel__row`, `site-panel__name` with a
 *   `site-panel__state` line, `site-switch` (a `role="switch"` button) and
 *   `site-panel__icon-button`. Use `<button>`s for controls: the arrow keys move between the
 *   panel's enabled buttons, and Esc closes the panel wherever focus is.
 *
 * The panel lives in the window's overlay view: keep sections cheap and select narrow slices of
 * state (`useOrbit((s) => …)`), never whole maps such as `s.tabs`.
 */
export interface SiteControlsSection {
  id: string
  order: number
  component: ComponentType<SiteSectionProps>
}

const modules = import.meta.glob<{ section?: SiteControlsSection }>('../../**/*.site-controls.tsx', { eager: true })

function isSection(value: unknown): value is SiteControlsSection {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Partial<SiteControlsSection>
  return typeof s.id === 'string' && typeof s.order === 'number' && !!s.component
}

function collect(): SiteControlsSection[] {
  const seen = new Set<string>()
  const list: SiteControlsSection[] = []
  for (const path of Object.keys(modules).sort()) {
    const section = modules[path]?.section
    if (!isSection(section)) {
      console.warn(`[site-controls] ${path} does not export a site controls section`)
      continue
    }
    if (seen.has(section.id)) {
      console.warn(`[site-controls] section id "${section.id}" is used twice; ${path} is ignored`)
      continue
    }
    seen.add(section.id)
    list.push(section)
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** Every registered section, in panel order. */
export const SITE_CONTROLS_SECTIONS: readonly SiteControlsSection[] = collect()

/** The panel's built-in sections' places, for slotting registered ones between them. */
export const BUILT_IN_ORDER = { permissions: 20, devices: 30, pip: 40, zoom: 50 } as const
