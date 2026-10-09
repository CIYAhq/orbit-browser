import { Archive, ClipboardPaste, Globe, History, Layers, RotateCw, Search, X, Zap } from 'lucide-react'
import { type MouseEvent, memo } from 'react'
import type { SearchResult } from '../../../../shared/commands/commandbar'
import { Favicon } from '../../ui/Favicon'

/** Truncates long text in the middle so both ends of a URL stay visible (CB-06). */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

function RowIcon({ r }: { r: SearchResult }) {
  if (r.splitFavicons && r.splitFavicons.length > 1) {
    return (
      <span className="cmdbar__split" data-testid="split-favicons">
        {r.splitFavicons.slice(0, 4).map((src, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: panes have no other identity here
          <Favicon key={i} src={src ?? undefined} size={12} />
        ))}
      </span>
    )
  }
  switch (r.kind) {
    case 'tab':
    case 'history':
    case 'current':
    case 'url':
      return r.favicon ? (
        <Favicon src={r.favicon} />
      ) : r.kind === 'history' ? (
        <History size={16} />
      ) : (
        <Globe size={16} />
      )
    case 'archived':
      return r.favicon ? <Favicon src={r.favicon} /> : <Archive size={16} />
    case 'paste':
      return <ClipboardPaste size={16} />
    case 'action':
      return <Zap size={16} />
    case 'space':
      return r.spaceIcon ? <span className="cmdbar__emoji">{r.spaceIcon}</span> : <Layers size={16} />
    default:
      return <Search size={16} />
  }
}

interface RowProps {
  r: SearchResult
  index: number
  selected: boolean
  onHover: (index: number) => void
  onChoose: (r: SearchResult, e: MouseEvent) => void
  onRemove: (r: SearchResult) => void
}

function sameRow(a: SearchResult, b: SearchResult): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.favicon === b.favicon &&
    a.label === b.label &&
    a.hint === b.hint &&
    a.shortcut === b.shortcut &&
    a.url === b.url &&
    a.splitFavicons?.join() === b.splitFavicons?.join()
  )
}

/** One result row. Memoized by content so unchanged rows don't re-render while typing (FL-17). */
export const ResultRow = memo(
  function ResultRow({ r, index, selected, onHover, onChoose, onRemove }: RowProps) {
    return (
      <div
        id={`cmdbar-option-${index}`}
        role="option"
        aria-selected={selected}
        className={`cmdbar__row${selected ? ' is-selected' : ''}`}
        data-testid="command-result"
        data-id={r.id}
        data-kind={r.kind}
        data-label={r.label}
        onMouseMove={() => onHover(index)}
        onMouseDown={(e) => {
          e.preventDefault()
          if (e.button === 0) onChoose(r, e)
        }}
      >
        <span className="cmdbar__icon">
          {r.kind === 'current' ? <RotateCw size={16} className="cmdbar__reload" /> : null}
          {r.kind === 'current' ? null : <RowIcon r={r} />}
        </span>
        <span className="cmdbar__text">
          <span className="cmdbar__title" data-testid="command-result-title">
            {r.title}
          </span>
          {r.subtitle && <span className="cmdbar__subtitle">{middleTruncate(r.subtitle, 72)}</span>}
        </span>
        {selected && r.hint && (
          <span className="cmdbar__hint">{r.hint === 'Tab' ? <kbd>Tab</kbd> : `${r.hint} ↩`}</span>
        )}
        {r.shortcut && (
          <kbd className="cmdbar__shortcut" data-testid="command-shortcut">
            {r.shortcut}
          </kbd>
        )}
        <span className="cmdbar__label">{r.label}</span>
        {r.removable && (
          <button
            type="button"
            className="cmdbar__remove"
            aria-label="Remove from history"
            title="Remove from history"
            data-testid="command-remove"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onRemove(r)
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
    )
  },
  (a, b) => a.selected === b.selected && a.index === b.index && sameRow(a.r, b.r),
)
