import { Columns2 } from 'lucide-react'
import { invoke } from '../../api'
import './split-button.css'

/**
 * Windows and Linux: the split button beside the window controls (SV-07, SB-26). It opens a small
 * menu: Add Split Right, Left, Above and Below, each showing its key (KS-18).
 */
export function SplitButton() {
  return (
    <button
      type="button"
      className="icon-button topbar__split"
      aria-label="Split View"
      aria-haspopup="menu"
      title="Split View"
      data-testid="split-button"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        void invoke('split.addMenu', { x: r.left, y: r.bottom + 4 })
      }}
    >
      <Columns2 size={15} />
    </button>
  )
}
