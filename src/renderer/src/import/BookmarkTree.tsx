import { ChevronRight, Folder } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { BookmarkNode } from '../../../shared/commands/import'
import { leafKey, leafKeys, type TreeRoot } from './tree'

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * A source's bookmark tree with checkboxes (IM-04). A folder's box sets every bookmark in it, and
 * shows mixed when only some are chosen. Folders below the top level start closed, so a big tree
 * draws only what is opened.
 */
export function BookmarkTree({
  roots,
  selected,
  onChange,
}: {
  roots: TreeRoot[]
  selected: ReadonlySet<string>
  onChange: (next: Set<string>) => void
}) {
  const leaves = useMemo(() => new Map<BookmarkNode, string[]>(), [])
  const leavesOf = (root: string, node: BookmarkNode) => {
    let list = leaves.get(node)
    if (!list) {
      list = leafKeys(root, node.children ?? [])
      leaves.set(node, list)
    }
    return list
  }
  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(selected)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    onChange(next)
  }
  const ctx: RowContext = { selected, leavesOf, setMany }
  return (
    <div className="im-tree" role="group" aria-label="Bookmarks" data-testid="import-tree">
      {roots.map((root) =>
        root.title ? (
          <FolderRow
            key={root.key}
            root={root.key}
            node={{ id: `root-${root.key}`, title: root.title, children: root.nodes }}
            depth={0}
            ctx={ctx}
          />
        ) : (
          root.nodes.map((n) => <Row key={n.id} root={root.key} node={n} depth={0} ctx={ctx} />)
        ),
      )}
    </div>
  )
}

interface RowContext {
  selected: ReadonlySet<string>
  leavesOf: (root: string, node: BookmarkNode) => string[]
  setMany: (keys: string[], on: boolean) => void
}

function Row({ root, node, depth, ctx }: { root: string; node: BookmarkNode; depth: number; ctx: RowContext }) {
  if (node.children) return <FolderRow root={root} node={node} depth={depth} ctx={ctx} />
  if (!node.url) return null
  const key = leafKey(root, node)
  const on = !node.skip && ctx.selected.has(key)
  return (
    <label
      className={`im-tree__row${node.skip ? ' is-skipped' : ''}`}
      style={{ paddingLeft: 8 + depth * 18 + 18 }}
      data-testid="import-tree-bookmark"
      title={node.skip ? `${node.url}\n${node.skip}` : node.url}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={!!node.skip}
        onChange={(e) => ctx.setMany([key], e.target.checked)}
      />
      <span className="im-tree__title">{node.title}</span>
      <span className="im-tree__meta">{node.skip ?? hostOf(node.url)}</span>
    </label>
  )
}

const FolderRow = memo(function FolderRow({
  root,
  node,
  depth,
  ctx,
}: {
  root: string
  node: BookmarkNode
  depth: number
  ctx: RowContext
}) {
  const [open, setOpen] = useState(depth === 0)
  const keys = ctx.leavesOf(root, node)
  let chosen = 0
  for (const k of keys) if (ctx.selected.has(k)) chosen++
  const all = keys.length > 0 && chosen === keys.length
  const some = chosen > 0 && !all
  return (
    <div role="group">
      <div
        className="im-tree__row im-tree__row--folder"
        style={{ paddingLeft: 8 + depth * 18 }}
        data-testid="import-tree-folder"
      >
        <button
          type="button"
          className="im-tree__toggle"
          aria-label={open ? `Close ${node.title}` : `Open ${node.title}`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        </button>
        <input
          type="checkbox"
          checked={all}
          disabled={keys.length === 0}
          ref={(el) => {
            if (el) el.indeterminate = some
          }}
          aria-label={`Import ${node.title}`}
          onChange={() => ctx.setMany(keys, !all)}
        />
        <Folder size={14} className="im-tree__icon" aria-hidden="true" />
        <span className="im-tree__title">{node.title}</span>
        <span className="im-tree__meta">{keys.length.toLocaleString()}</span>
      </div>
      {open && node.children?.map((n) => <Row key={n.id} root={root} node={n} depth={depth + 1} ctx={ctx} />)}
    </div>
  )
})
