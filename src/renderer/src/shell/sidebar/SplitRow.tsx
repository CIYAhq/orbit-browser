import { memo } from 'react'
import { splitLeaves } from '../../../../shared/tree'
import { invoke } from '../../api'
import { useOrbit } from '../../store'
import { TabRowBody } from './ItemList'

/**
 * A split view as one sidebar row: one tab row per pane. Placeholder until the split lane's
 * SplitRow (same file, same props) replaces it; ItemList draws it inside a drag-and-drop slot,
 * so the slot handles dragging and enter/exit motion whichever version is here.
 */
export const SplitRow = memo(function SplitRow({ splitId, depth }: { splitId: string; depth: number }) {
  const leaves = useOrbit((s) => {
    const split = s.splits[splitId]
    return split ? splitLeaves(split.layout).join(',') : ''
  })
  if (!leaves) return null
  const panes = leaves.split(',')
  return (
    <div
      className="split-row"
      data-testid="split-row"
      data-split-id={splitId}
      onContextMenu={(e) => {
        e.preventDefault()
        void invoke('tabs.contextMenu', { id: panes[0] as string })
      }}
    >
      {panes.map((tabId) => (
        <TabRowBody key={tabId} tabId={tabId} depth={depth} />
      ))}
    </div>
  )
})
