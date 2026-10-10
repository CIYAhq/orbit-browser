import type { ComponentType } from 'react'

/**
 * Orbit's internal pages (DT-13): `orbit://<name>/` in a normal tab, listed on `orbit://pages/`.
 * Main serves and guards them; see src/main/devtools/internal-pages.ts for how.
 *
 * A page is `{ name, title, description, component }`:
 * - `name`: the address's host, `orbit://<name>/`: lowercase letters, digits and dashes. `pages`
 *   is the list itself.
 * - `title`: the tab's title, and the page's name on the list.
 * - `description`: one line on the list.
 * - `component`: the page. It fills the tab, scrolls itself, and renders like any Orbit UI: the
 *   store (`useOrbit`), commands (`invoke`), and `useWindow()`, the window the tab was in when the
 *   page loaded. A big page loads its code on demand (`React.lazy`). It runs only the commands
 *   `INTERNAL_PAGE_COMMANDS` (src/main/devtools/internal-urls.ts) lists for it, and sends no events
 *   (D53): list a new page's commands there.
 * - `hidden` (optional): left off the list.
 *
 * Pages register by file name, so adding one edits no file here: any module under
 * `src/renderer/src` named `*.internal-page.tsx` that exports `page: InternalPage` is collected at
 * build time (`import.meta.glob` below). Names must be unique; the first one wins.
 *
 * A page never acts on what its address says (`?query`, `#hash`): any web page can't send the user
 * there, but a link the user copies can. It shows things, and acts on the user's clicks.
 */
export interface InternalPage {
  name: string
  title: string
  description: string
  component: ComponentType
  hidden?: boolean
}

/** The page listing the others. */
export const INDEX_NAME = 'pages'

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const modules = import.meta.glob<{ page?: InternalPage }>('../**/*.internal-page.tsx', { eager: true })

function collect(): InternalPage[] {
  const seen = new Set<string>([INDEX_NAME])
  const list: InternalPage[] = []
  for (const path of Object.keys(modules).sort()) {
    const page = modules[path]?.page
    if (!page || !NAME_RE.test(page.name) || seen.has(page.name)) continue
    seen.add(page.name)
    list.push(page)
  }
  return list.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every page but the list itself, by name. */
export const INTERNAL_PAGES: readonly InternalPage[] = collect()

/** The address of a page. */
export const internalUrl = (name: string): string => `orbit://${name}/`
