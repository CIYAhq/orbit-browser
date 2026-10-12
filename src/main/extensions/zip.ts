import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { crc32, inflateRaw } from 'node:zlib'
import { ExtensionError } from '../../shared/extensions'

/**
 * The ZIP archive inside a CRX file (EX-01, EX-09): its entries, read and written out. Only what
 * extensions use: stored and deflated files, no ZIP64, no encryption. A name that could leave the
 * folder (absolute, `..`, a drive, a backslash), a symbolic link, a duplicate, or sizes past the
 * limits refuse the whole archive. Inflating runs off main's thread (zlib's thread pool).
 */

const inflate = promisify(inflateRaw)

export const ZIP_LIMITS = {
  entries: 20_000,
  /** All files together, uncompressed. */
  total: 512 * 1024 * 1024,
  file: 256 * 1024 * 1024,
  name: 1024,
}

export interface ZipEntry {
  /** A safe relative path, '/' between folders; a folder's ends with '/'. */
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  /** Where its local header starts. */
  offset: number
}

/** An archive Orbit refuses. */
export class ZipError extends ExtensionError {
  override name = 'ZipError'
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** A name inside the archive made safe, or null when it could reach outside the folder. */
export function safeEntryName(raw: string): string | null {
  if (!raw || raw.length > ZIP_LIMITS.name || raw.includes('\0') || raw.includes('\\')) return null
  let name = raw
  while (name.startsWith('./')) name = name.slice(2)
  if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null
  const parts = name.split('/')
  const dir = name.endsWith('/')
  if (dir) parts.pop()
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return parts.join('/') + (dir ? '/' : '')
}

/** The archive's entries, from its central directory. */
export function zipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i
      break
    }
  }
  if (end < 0) throw new ZipError('Its archive is damaged.')
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const start = view.getUint32(end + 16, true)
  if (count === 0xffff || start === 0xffffffff) throw new ZipError('Its archive is too large.')
  if (count > ZIP_LIMITS.entries) throw new ZipError('Its archive has too many files.')
  if (start + size > end) throw new ZipError('Its archive is damaged.')
  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let total = 0
  let at = start
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw new ZipError('Its archive is damaged.')
    const madeBy = view.getUint16(at + 4, true)
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const fileSize = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const external = view.getUint32(at + 38, true)
    const offset = view.getUint32(at + 42, true)
    if (at + 46 + nameLength > end) throw new ZipError('Its archive is damaged.')
    const raw = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    const name = safeEntryName(raw)
    if (name === null) throw new ZipError('Its archive has a file outside its folder.')
    if (flags & 1) throw new ZipError('Its archive is encrypted.')
    if (madeBy >> 8 === 3 && ((external >>> 16) & S_IFMT) === S_IFLNK) throw new ZipError('Its archive has a link.')
    if (method !== 0 && method !== 8) throw new ZipError('Its archive uses a compression Orbit can’t read.')
    if (compressedSize === 0xffffffff || fileSize === 0xffffffff) throw new ZipError('Its archive is too large.')
    if (fileSize > ZIP_LIMITS.file) throw new ZipError('Its archive has a file that is too large.')
    total += fileSize
    if (total > ZIP_LIMITS.total) throw new ZipError('Its archive is too large.')
    const key = name.toLowerCase()
    if (seen.has(key)) throw new ZipError('Its archive has the same file twice.')
    seen.add(key)
    entries.push({ name, method, crc, compressedSize, size: fileSize, offset })
  }
  return entries
}

/** An entry's contents, checked against its size and checksum. */
export async function zipRead(zip: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const at = entry.offset
  if (at + 30 > zip.length || view.getUint32(at, true) !== LOCAL) throw new ZipError('Its archive is damaged.')
  const begin = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true)
  if (begin + entry.compressedSize > zip.length) throw new ZipError('Its archive is damaged.')
  const data = zip.subarray(begin, begin + entry.compressedSize)
  let out: Uint8Array
  if (entry.method === 0) out = data
  else if (entry.size === 0) out = new Uint8Array(0)
  else {
    try {
      out = await inflate(data, { maxOutputLength: entry.size })
    } catch {
      throw new ZipError('Its archive is damaged.')
    }
  }
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new ZipError('Its archive is damaged.')
  return out
}

/** Writes the archive's files into `dir`, which must not exist yet or be empty. */
export async function extractZip(zip: Uint8Array, dir: string): Promise<void> {
  const root = resolve(dir)
  const entries = zipEntries(zip)
  await mkdir(root, { recursive: true })
  for (const entry of entries) {
    const target = resolve(join(root, entry.name))
    if (target !== root && !target.startsWith(root + sep))
      throw new ZipError('Its archive has a file outside its folder.')
    if (entry.name.endsWith('/')) {
      await mkdir(target, { recursive: true })
      continue
    }
    const data = await zipRead(zip, entry)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data, { flag: 'wx' })
  }
}
