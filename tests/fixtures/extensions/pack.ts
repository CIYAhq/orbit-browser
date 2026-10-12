import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Packs the fixture extensions into CRX3 files for the tests (EX-09): a ZIP of the folder,
 * signed with a key made on the spot. Nothing here reaches the network. Written apart from Orbit's
 * own reader (src/shared/extensions.ts, src/main/extensions/), so the tests check one against the other.
 *
 * Also makes broken files on purpose: a wrong signature, another extension's ID, a CRX2 header, an
 * archive with a file outside its folder.
 *
 * From a shell: `node tests/fixtures/extensions/pack.ts <folder> <out.crx>` (Node strips the types).
 */

/** The fixture extensions' folders (both test runners run from the repository's root). */
export const FIXTURES = {
  basic: resolve('tests/fixtures/extensions/basic'),
  broad: resolve('tests/fixtures/extensions/broad'),
}

export interface CrxKey {
  algorithm: 'rsa' | 'ecdsa'
  privateKey: KeyObject
  /** DER SubjectPublicKeyInfo. */
  publicKey: Buffer
  /** The extension ID this key gives. */
  id: string
}

/** The ID a public key gives: the first 16 bytes of its SHA-256, as letters a–p. */
export function idOf(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update(publicKey).digest()
  let id = ''
  for (const byte of hash.subarray(0, 16)) id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
  return id
}

/** A new signing key: RSA 2048 (as the store's) or ECDSA P-256. */
export function makeKey(algorithm: 'rsa' | 'ecdsa' = 'rsa'): CrxKey {
  const pair =
    algorithm === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' })
  return { algorithm, privateKey: pair.privateKey, publicKey, id: idOf(publicKey) }
}

export interface ZipFile {
  name: string
  data: Buffer
  /** A Unix mode for the entry (e.g. 0o120777 for a symbolic link). */
  mode?: number
}

const le16 = (n: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const le32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

/** A ZIP archive of the files, deflated unless `stored`. */
export function zip(files: ZipFile[], opts: { stored?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const deflate = !opts.stored && file.data.length > 0
    const body = deflate ? deflateRawSync(file.data) : file.data
    const crc = crc32(file.data) >>> 0
    const method = deflate ? 8 : 0
    const local = Buffer.concat([
      le32(0x04034b50),
      le16(20),
      le16(0x0800),
      le16(method),
      le16(0),
      le16(0x21),
      le32(crc),
      le32(body.length),
      le32(file.data.length),
      le16(name.length),
      le16(0),
      name,
      body,
    ])
    const unix = file.mode !== undefined
    centrals.push(
      Buffer.concat([
        le32(0x02014b50),
        le16(unix ? (3 << 8) | 20 : 20),
        le16(20),
        le16(0x0800),
        le16(method),
        le16(0),
        le16(0x21),
        le32(crc),
        le32(body.length),
        le32(file.data.length),
        le16(name.length),
        le16(0),
        le16(0),
        le16(0),
        le16(0),
        le32(unix ? ((file.mode ?? 0) << 16) >>> 0 : 0),
        le32(offset),
        name,
      ]),
    )
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([
    le32(0x06054b50),
    le16(0),
    le16(0),
    le16(files.length),
    le16(files.length),
    le32(central.length),
    le32(offset),
    le16(0),
  ])
  return Buffer.concat([...locals, central, end])
}

/** Every file under a folder, '/' between names, in a stable order. */
export function folderFiles(dir: string): ZipFile[] {
  const out: ZipFile[] = []
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push({ name: relative(dir, path).split(sep).join('/'), data: readFileSync(path) })
    }
  }
  walk(dir)
  return out
}

/** The folder's files with its manifest changed (a new version, more permissions…). */
export function withManifest(files: ZipFile[], change: (manifest: Record<string, unknown>) => void): ZipFile[] {
  return files.map((file) => {
    if (file.name !== 'manifest.json') return file
    const manifest = JSON.parse(file.data.toString('utf8')) as Record<string, unknown>
    change(manifest)
    return { name: file.name, data: Buffer.from(JSON.stringify(manifest, null, 2)) }
  })
}

const varint = (value: number): Buffer => {
  const out: number[] = []
  let n = value
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}
const field = (num: number, data: Buffer) => Buffer.concat([varint(num * 8 + 2), varint(data.length), data])

export interface PackOptions {
  /** Other keys that also sign it (a publisher's, as the store adds its own). */
  alsoSignedBy?: CrxKey[]
  /** The ID its header names, if not the key's (a file claiming to be another extension). */
  claimId?: string
  /** Signs this archive but ships `archive` (a file changed after it was signed). */
  signedArchive?: Buffer
  /** The format version in its header (2 for an old CRX2 file). */
  version?: number
}

/** An ID's 16 bytes (its letters a–p are nibbles). */
function idBytesOf(id: string): Buffer {
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) out[i] = ((id.charCodeAt(2 * i) - 97) << 4) | (id.charCodeAt(2 * i + 1) - 97)
  return out
}

/** A CRX3 file of the archive, signed by `key`. */
export function crx(archive: Buffer, key: CrxKey, opts: PackOptions = {}): Buffer {
  const idBytes = idBytesOf(opts.claimId ?? key.id)
  const signedHeaderData = field(1, idBytes)
  const prefix = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    le32(signedHeaderData.length),
    signedHeaderData,
  ])
  const proofs = [key, ...(opts.alsoSignedBy ?? [])].map((k) => {
    const signature = sign('sha256', Buffer.concat([prefix, opts.signedArchive ?? archive]), k.privateKey)
    return field(k.algorithm === 'rsa' ? 2 : 3, Buffer.concat([field(1, k.publicKey), field(2, signature)]))
  })
  const header = Buffer.concat([...proofs, field(10000, signedHeaderData)])
  return Buffer.concat([Buffer.from('Cr24'), le32(opts.version ?? 3), le32(header.length), header, archive])
}

/** A fixture folder packed as a CRX3 file (and the key that signed it). */
export function packFolder(
  dir: string,
  key: CrxKey = makeKey(),
  opts: PackOptions = {},
): { file: Buffer; key: CrxKey } {
  return { file: crx(zip(folderFiles(dir)), key, opts), key }
}

// `node tests/fixtures/extensions/pack.ts <folder> <out.crx>`
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [dir, out] = process.argv.slice(2)
  if (!dir || !out) {
    console.error('usage: node tests/fixtures/extensions/pack.ts <folder> <out.crx>')
    process.exit(2)
  }
  const { file, key } = packFolder(resolve(dir))
  writeFileSync(out, file)
  console.log(`${out}: ${key.id}`)
}
