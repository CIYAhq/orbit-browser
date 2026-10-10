import type { ComponentType } from 'react'

/**
 * The Settings window's section registry (ST-01).
 *
 * A section is one entry in the Settings sidebar and the page it shows. Sections are found by
 * file name: every module under `src/renderer/src/` whose name ends in `.settings.tsx` and
 * default-exports a `SettingsSection` is in the window. Another lane adds a section with a file of
 * its own and no edit here, e.g. the keys lane's Shortcuts section (ST-08):
 *
 * ```tsx
 * // src/renderer/src/keys/shortcuts.settings.tsx
 * import { Keyboard } from 'lucide-react'
 * import type { SettingsSection } from '../settings/registry'
 *
 * function ShortcutsPage() { … }
 *
 * export default {
 *   id: 'shortcuts',
 *   label: 'Shortcuts',
 *   icon: Keyboard,
 *   order: 40,
 *   component: ShortcutsPage,
 *   keywords: ['keyboard', 'keys', 'remap'],
 * } satisfies SettingsSection
 * ```
 *
 * - `id`: stable and unique. `settings.open({ section: id })` opens it (command-bar actions use
 *   that), and Settings reopens at the section shown last (`settings.settingsSection`).
 * - `label`: the sidebar entry and the page title.
 * - `icon`: a lucide-react icon, or any component that takes `size`.
 * - `order`: the sidebar position, low first. Orbit's sections: General 10, Profiles 20, Search 25,
 *   Appearance 30, Shortcuts 40 (keys lane), Links 50, Privacy & security 60, Site settings 65,
 *   Advanced 70, About 90. Pick a number between two to slot in.
 * - `component`: the page, rendered without props. Build it from `./controls` (`SettingGroup`,
 *   `SettingRow`, `Switch`, `Select`…): the search box (ST-02) finds settings by the text of their
 *   rows, and `settings.open({ section, item })` scrolls to the row whose `id` is `item`. Read the
 *   profile and window Settings acts for with `useSettingsContext()` from `./context`.
 * - `keywords` (optional): more words the search box finds the section by.
 *
 * Keep pages cheap while Settings sits open in the background: select narrow slices of state
 * (`useOrbit((s) => s.settings.someFlag)`), never whole maps such as `s.tabs`.
 */
export interface SettingsSection {
  id: string
  label: string
  icon: ComponentType<{ size?: number | string; strokeWidth?: number | string }>
  order: number
  component: ComponentType
  keywords?: string[]
}

const modules = import.meta.glob<{ default?: SettingsSection }>('../**/*.settings.tsx', { eager: true })

function isSection(value: unknown): value is SettingsSection {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Partial<SettingsSection>
  return typeof s.id === 'string' && typeof s.label === 'string' && typeof s.order === 'number' && !!s.component
}

let sorted: SettingsSection[] | undefined

/** Every registered section, in sidebar order (the first of a duplicate id wins). */
export function settingsSections(): SettingsSection[] {
  if (sorted) return sorted
  const seen = new Set<string>()
  const list: SettingsSection[] = []
  for (const [path, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const section = mod.default
    if (!isSection(section)) {
      console.warn(`[settings] ${path} does not default-export a settings section`)
      continue
    }
    if (seen.has(section.id)) {
      console.warn(`[settings] section id "${section.id}" is used twice; ${path} is ignored`)
      continue
    }
    seen.add(section.id)
    list.push(section)
  }
  sorted = list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  return sorted
}
