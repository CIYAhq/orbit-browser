import { useLayoutEffect, useRef } from 'react'
import { isFolderId } from '../../../../shared/ids'
import type { ItemId } from '../../../../shared/state'
import { invoke } from '../../api'
import { stopRename } from './ui-state'

/**
 * Inline text field for renaming a tab (TB-12, PN-08) or folder (FD-03), or editing a
 * pinned URL (PN-07). Enter or clicking elsewhere saves; Escape cancels.
 */
export function RenameField({ id, mode, initial }: { id: ItemId; mode: 'name' | 'url'; initial: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const input = ref.current
    if (!input) return
    input.focus()
    input.select()
  }, [])
  const save = () => {
    if (done.current) return
    done.current = true
    const value = ref.current?.value ?? ''
    stopRename()
    if (mode === 'url') {
      if (value.trim() && value.trim() !== initial) void invoke('tabs.setPinnedUrl', { tabId: id, url: value.trim() })
    } else if (isFolderId(id)) {
      // An empty folder name keeps the previous name (FD-03).
      if (value.trim()) void invoke('folders.rename', { folderId: id, name: value })
    } else if (value.trim() !== initial.trim()) {
      // An empty tab name reverts to the page's own title (TB-12).
      void invoke('tabs.rename', { tabId: id, title: value.trim() ? value : null })
    }
  }
  const cancel = () => {
    if (done.current) return
    done.current = true
    stopRename()
  }
  return (
    <input
      ref={ref}
      className="rename-field"
      data-testid="rename-field"
      defaultValue={initial}
      spellCheck={false}
      aria-label={mode === 'url' ? 'Pinned URL' : 'Name'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={save}
    />
  )
}
