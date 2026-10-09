export type IdKind = 't' | 'f' | 'v' | 's' | 'p' | 'w' | 'a' | 'd' | 'x'

let counter = 0

/**
 * Creates a unique, sortable-ish ID with a type prefix:
 * t tab, f folder, v split view, s space, p profile, w window, a archived, d download, x tweak.
 */
export function newId(kind: IdKind): string {
  counter = (counter + 1) % 1679616
  const rand = Math.floor(Math.random() * 1679616)
    .toString(36)
    .padStart(4, '0')
  return `${kind}-${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${rand}`
}

export function idKind(id: string): IdKind | undefined {
  const i = id.indexOf('-')
  return i > 0 ? (id.slice(0, i) as IdKind) : undefined
}

export const isTabId = (id: string) => id.startsWith('t-')
export const isFolderId = (id: string) => id.startsWith('f-')
export const isSplitId = (id: string) => id.startsWith('v-')
