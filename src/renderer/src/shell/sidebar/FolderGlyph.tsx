/**
 * A folder's default icon (FD-07): a folder drawn in full colour, in the Space's accent. Closed, its
 * front covers it; open, the front tips forward. The two fronts cross-fade as the folder opens or
 * closes (FL-12: about 150 ms), which is a fade, so reduced motion keeps it.
 */
export function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg
      className={`folder-glyph${open ? ' is-open' : ''}`}
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      data-testid="folder-glyph"
    >
      <path
        className="folder-glyph__back"
        d="M1.5 3.5a1 1 0 0 1 1-1h3.6L7.5 4h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
      />
      <path className="folder-glyph__front folder-glyph__shut" d="M1.5 5.75h13v6.75a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      <path
        className="folder-glyph__front folder-glyph__lid"
        d="M3.3 7h11.6a.6.6 0 0 1 .58.76l-1.4 5a1 1 0 0 1-.96.74H1.6a.6.6 0 0 1-.58-.76l1.3-5A1 1 0 0 1 3.3 7z"
      />
    </svg>
  )
}
