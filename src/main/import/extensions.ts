import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceExtension } from '../../shared/commands/import'
import type { Scratch } from './copy'

/**
 * A Chromium-family profile's extensions (IM-09), from its `Preferences` and `Secure Preferences`.
 * They are listed, not installed: the extensions lane's install path isn't in Orbit yet, so the
 * import says they can't come over yet. Nothing here ever reaches a store.
 */

/** Install locations that are the browser's own (component) extensions: never listed. */
const BROWSERS_OWN = new Set([5, 10])
/** Location 1 is the store's; 4 is unpacked (developer mode). */
const FROM_STORE = 1
/** An extension's id: 32 letters from a to p. */
const ID = /^[a-p]{32}$/
/** Names that mark an ad or content blocker, for IM-09's de-duplication. */
const BLOCKER = /\b(ad ?block\w*|adguard|ublock\w*|\w*blocker|content filter)\b/i

interface ExtensionPrefs {
  location?: unknown
  from_webstore?: unknown
  path?: unknown
  manifest?: { name?: unknown; default_locale?: unknown }
}

interface Prefs {
  extensions?: { settings?: Record<string, ExtensionPrefs>; pinned_extensions?: unknown }
}

/**
 * A JSON file of another browser's, read from a copy; undefined when it's missing, held or broken.
 * Listing is best effort, and nothing of a file's text is ever logged.
 */
async function readJson(scratch: Scratch, path: string): Promise<Record<string, unknown> | undefined> {
  const copy = await scratch.take(path).catch(() => undefined)
  if (!copy) return undefined
  const value: unknown = await readFile(copy, 'utf8')
    .then((text) => JSON.parse(text.replace(/^\uFEFF/, '')))
    .catch(() => undefined)
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export async function chromiumExtensions(scratch: Scratch, dir: string): Promise<SourceExtension[]> {
  const prefs = async (name: string) => ((await readJson(scratch, join(dir, name))) ?? {}) as Prefs
  const [open, secure] = [await prefs('Preferences'), await prefs('Secure Preferences')]
  const settings = { ...open.extensions?.settings, ...secure.extensions?.settings }
  const pinned = new Set(Array.isArray(open.extensions?.pinned_extensions) ? open.extensions.pinned_extensions : [])
  const out: SourceExtension[] = []
  for (const [id, s] of Object.entries(settings)) {
    if (!ID.test(id) || !s || typeof s !== 'object' || BROWSERS_OWN.has(Number(s.location))) continue
    const name = await extensionName(scratch, dir, s)
    if (!name) continue
    const fromStore = s.from_webstore === true || Number(s.location) === FROM_STORE
    out.push({ id, name, pinned: pinned.has(id), fromStore, blocker: BLOCKER.test(name) })
  }
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
}

/** The name in its prefs, or in its manifest on disk; a "__MSG_x__" name from its default locale. */
async function extensionName(scratch: Scratch, dir: string, s: ExtensionPrefs): Promise<string | undefined> {
  let manifest = s.manifest && typeof s.manifest === 'object' ? s.manifest : undefined
  const folder = typeof s.path === 'string' && !s.path.includes('..') ? join(dir, 'Extensions', s.path) : undefined
  if (typeof manifest?.name !== 'string' && folder) manifest = await readJson(scratch, join(folder, 'manifest.json'))
  const name = typeof manifest?.name === 'string' ? manifest.name.trim() : ''
  const key = /^__MSG_(\w+)__$/.exec(name)?.[1]
  if (!key) return name || undefined
  const locale =
    typeof manifest?.default_locale === 'string' && /^[\w-]+$/.test(manifest.default_locale)
      ? manifest.default_locale
      : 'en'
  const messages = folder ? await readJson(scratch, join(folder, '_locales', locale, 'messages.json')) : undefined
  const entry = Object.entries(messages ?? {}).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1]
  const message = (entry as { message?: unknown } | undefined)?.message
  return typeof message === 'string' && message.trim() ? message.trim() : undefined
}
