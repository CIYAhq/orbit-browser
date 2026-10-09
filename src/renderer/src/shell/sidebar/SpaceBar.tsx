import { Plus } from 'lucide-react'
import type { WindowState } from '../../../../shared/state'
import { invoke } from '../../api'
import { useOrbit } from '../../store'

/** Space switcher at the bottom of the sidebar. */
export function SpaceBar({ win }: { win: WindowState }) {
  const order = useOrbit((s) => s.spaceOrder)
  return (
    <nav className="spacebar" data-testid="spacebar">
      <div className="spacebar__spaces">
        {order.map((id) => (
          <SpaceDot key={id} spaceId={id} active={id === win.spaceId} />
        ))}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label="New Space"
        title="New Space"
        data-testid="new-space"
        onClick={() => void invoke('spaces.create', {})}
      >
        <Plus size={16} />
      </button>
    </nav>
  )
}

function SpaceDot({ spaceId, active }: { spaceId: string; active: boolean }) {
  const space = useOrbit((s) => s.spaces[spaceId])
  if (!space) return null
  return (
    <button
      type="button"
      className={`space-dot${active ? ' is-active' : ''}`}
      title={space.name}
      aria-label={`Switch to ${space.name}`}
      aria-pressed={active}
      data-testid="space-dot"
      data-space-id={spaceId}
      onClick={() => void invoke('spaces.switch', { spaceId })}
      style={{ '--dot': space.theme.color } as React.CSSProperties}
    >
      {space.icon ? <span className="space-dot__icon">{space.icon}</span> : <span className="space-dot__dot" />}
    </button>
  )
}
