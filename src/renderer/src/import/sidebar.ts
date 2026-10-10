import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react'
import {
  type ImportOpening,
  MAX_FILE_BYTES,
  PASTED_LIST,
  type ParsedFile,
  parseLinkList,
  TOO_LARGE,
} from '../../../shared/commands/import'
import { pageMayOpen } from '../../../shared/link-routing'
import { engineForSpace, parseInput } from '../../../shared/url'
import { invoke } from '../api'
import { useKeyboardFocus } from '../shell/sidebar/ui-state'
import { getOrbitState } from '../store'
import { prefersReducedMotion } from '../theme'

/** Files the import flow can read (IM-13): a bookmarks file, or a list of links. */
const IMPORTABLE = /\.(html?|txt)$/i
/** A paste is looked at this far for two links: a list's first two are well within it (D58). */
const PASTE_LOOK = 256 * 1024

/**
 * A bookmarks file (or a list of links) dropped on the sidebar opens the import flow at its
 * bookmarks (IM-13). A file that holds neither opens as a page, as a dropped link does (TB-02),
 * when the drop names an address a dropped link may open; otherwise the import window says why it
 * can't be read.
 * Returns whether the drop was taken.
 */
export function importDroppedFile(e: ReactDragEvent, text: string, spaceId: string): boolean {
  const file = [...e.dataTransfer.files].find((f) => IMPORTABLE.test(f.name))
  if (!file) return false
  e.preventDefault()
  void (async () => {
    // A file over the limit isn't read at all (F2); one that can't be read says so in the import window (F1).
    let parsed: ParsedFile
    try {
      parsed =
        file.size > MAX_FILE_BYTES
          ? { kind: 'error', name: file.name, message: TOO_LARGE }
          : await invoke('import.parseFile', { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    } catch {
      parsed = { kind: 'error', name: file.name, message: 'Orbit couldn’t read this file' }
    }
    if (parsed.kind === 'error' && text) {
      const { url } = parseInput(text, engineForSpace(getOrbitState(), spaceId))
      // As a dropped link (SidebarItems' onLinkDrop): a web page may have offered it, so a local
      // file's address opens only when typed or pasted (D49, D58). The import window says why the
      // file itself can't be read.
      if (pageMayOpen(undefined, url)) {
        await invoke('tabs.create', { url, spaceId })
        return
      }
    }
    await invoke('import.open', { start: { kind: 'file', file: parsed } })
  })()
  return true
}

/**
 * ⌘V (Ctrl+V) on the sidebar, outside a text field, with a list of two or more links on the
 * clipboard offers to import them as a pinned folder (IM-12): the import window opens at "Paste a
 * list of links" with them filled in. One link, or other text, is left alone. A list over the file
 * cap isn't sent: the import window says it's too large, as it does of a file (D62 (5)). Returns
 * whether the paste was taken.
 */
export function importPastedLinks(e: ReactClipboardEvent): boolean {
  const el = e.target instanceof Element ? e.target : null
  if (el?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return false
  const text = e.clipboardData.getData('text/plain')
  // Read here, in the browser window: only the start, and only until two links are found (D58).
  if (!text || parseLinkList(text.slice(0, PASTE_LOOK), 2).links.length < 2) return false
  e.preventDefault()
  // As UTF-8: main passes the bytes on to the reader, never making text of them (D62 (5)).
  const start: ImportOpening =
    text.length > MAX_FILE_BYTES
      ? { kind: 'file', file: { kind: 'error', name: PASTED_LIST, message: TOO_LARGE } }
      : { kind: 'links', bytes: new TextEncoder().encode(text) }
  void invoke('import.open', { start })
  return true
}

/** Done in the import flow (IM-14): the imported folder, scrolled to and given the keyboard focus. */
export function revealInSidebar(scroll: HTMLElement | null, id: string): void {
  let tries = 0
  const find = () => {
    const row = scroll?.querySelector<HTMLElement>(`[data-slot][data-key="${CSS.escape(id)}"]`)
    if (!scroll || !row) {
      if (++tries < 40) setTimeout(find, 50)
      return
    }
    row.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    scroll.focus({ preventScroll: true })
    useKeyboardFocus.setState({ id })
  }
  find()
}
