/**
 * What a download is saved as (DL-01): a name every file system takes, a free name next to the files
 * already in the folder (`report (1).pdf`), and the temporary name of the file while it downloads.
 * Pure Node, unit-tested.
 */
import { join } from 'node:path'

/** A file being downloaded has this suffix until it is complete (Chromium-standard). */
export const PARTIAL_SUFFIX = '.crdownload'

/** Extensions kept whole when a number goes in: `logs.tar.gz` → `logs (1).tar.gz`. */
const DOUBLE_EXTENSION = /\.tar\.(gz|bz2|xz|zst|lz|lzma|z)$/i
/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
/** Characters Windows and macOS don't take in a name (path separators included). */
const UNSAFE = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
/** Longest name kept, in characters (file systems allow 255 bytes; the suffixes need room). */
const MAX_NAME = 180

/** A name safe on every platform: no separators or control characters, no leading dots. */
export function safeFilename(name: string, fallback = 'download'): string {
  let out = ''
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f || UNSAFE.has(ch) ? '_' : ch
  }
  // No hidden files, and Windows drops trailing dots and spaces.
  out = out
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (!out) return fallback
  if (RESERVED.test(out)) out = `_${out}`
  if (out.length > MAX_NAME) {
    const [base, ext] = splitName(out)
    const keep = ext.length < 20 ? ext : ''
    out = `${base.slice(0, MAX_NAME - keep.length).trimEnd()}${keep}`
  }
  return out
}

/** A name's base and extension: `report.pdf` → [`report`, `.pdf`], `logs.tar.gz` → [`logs`, `.tar.gz`]. */
export function splitName(name: string): [string, string] {
  const double = DOUBLE_EXTENSION.exec(name)
  if (double && double.index > 0) return [name.slice(0, double.index), name.slice(double.index)]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** The n-th alternative of a name: 0 → `report.pdf`, 1 → `report (1).pdf`. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name
  const [base, ext] = splitName(name)
  return `${base} (${n})${ext}`
}

/**
 * The first path in `dir` for `name` that `taken` says is free: the name itself, then
 * `name (1)`, `name (2)`… A name whose partial file is still there counts as taken.
 */
export function freePath(dir: string, name: string, taken: (path: string) => boolean): string {
  for (let n = 0; n < 10_000; n++) {
    const path = join(dir, numberedName(name, n))
    if (!taken(path) && !taken(`${path}${PARTIAL_SUFFIX}`)) return path
  }
  // Ten thousand copies: give up on numbers and use the time.
  const [base, ext] = splitName(name)
  return join(dir, `${base} (${Date.now()})${ext}`)
}
