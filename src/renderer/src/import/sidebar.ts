import type { DragEvent as ReactDragEvent } from 'react'
import { engineForSpace, parseInput } from '../../../shared/url'
import { invoke } from '../api'
import { useKeyboardFocus } from '../shell/sidebar/ui-state'
import { getOrbitState } from '../store'
import { prefersReducedMotion } from '../theme'

/** Files the import flow can read (IM-13): a bookmarks file, or a list of links. */
const IMPORTABLE = /\.(html?|txt)$/i
const MAX_BYTES = 64 * 1024 * 1024

/**
 * A bookmarks file (or a list of links) dropped on the sidebar opens the import flow at its
 * bookmarks (IM-13). A file that holds neither opens as a page, as a dropped link does (TB-02),
 * when the drop names its address; otherwise the import window says why it can't be read.
 * Returns whether the drop was taken.
 */
export function importDroppedFile(e: ReactDragEvent, text: string, spaceId: string): boolean {
  const file = [...e.dataTransfer.files].find((f) => IMPORTABLE.test(f.name))
  if (!file) return false
  e.preventDefault()
  void (async () => {
    const parsed =
      file.size > MAX_BYTES
        ? ({ kind: 'error', name: file.name, message: 'No bookmarks found in this file' } as const)
        : await invoke('import.parseFile', { name: file.name, text: await file.text() })
    if (parsed.kind === 'error' && text) {
      const { url } = parseInput(text, engineForSpace(getOrbitState(), spaceId))
      await invoke('tabs.create', { url, spaceId })
      return
    }
    await invoke('import.open', { start: { kind: 'file', file: parsed } })
  })()
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
