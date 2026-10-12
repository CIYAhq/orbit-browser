import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyCrx } from '../../src/main/extensions/crx'
import { extractZip, safeEntryName, ZIP_LIMITS, ZipError, zipEntries } from '../../src/main/extensions/zip'
import { CrxError, parseCrx } from '../../src/shared/extensions'
import { crx, FIXTURES, folderFiles, makeKey, packFolder, zip } from '../fixtures/extensions/pack'

/**
 * Packed extensions (EX-01, EX-09): a CRX3 file is used only once its signature checks out and its
 * own key gives the ID it names; its archive is written out only inside its folder. The files come
 * from the tests' own packer (tests/fixtures/extensions/pack.ts), written apart from Orbit's reader.
 */

// One key of each kind for the whole file: RSA keys take a moment to make.
const rsa = makeKey('rsa')
const other = makeKey('rsa')
const ec = makeKey('ecdsa')

describe('verifyCrx', () => {
  it('accepts a file signed with its own key, and gives its ID, key and archive', async () => {
    const archive = zip(folderFiles(FIXTURES.basic))
    const file = crx(archive, rsa)
    const verified = await verifyCrx(file)
    expect(verified.id).toBe(rsa.id)
    expect(Buffer.from(verified.publicKey).equals(rsa.publicKey)).toBe(true)
    expect(Buffer.from(verified.archive).equals(archive)).toBe(true)
  })

  it('accepts an ECDSA signature', async () => {
    const { file } = packFolder(FIXTURES.basic, ec)
    expect((await verifyCrx(file)).id).toBe(ec.id)
  })

  it('accepts a file a second key also signed, and takes the ID from the extension’s own', async () => {
    const { file } = packFolder(FIXTURES.basic, rsa, { alsoSignedBy: [other] })
    const verified = await verifyCrx(file)
    expect(verified.id).toBe(rsa.id)
    expect(Buffer.from(verified.publicKey).equals(rsa.publicKey)).toBe(true)
  })

  it('refuses a file changed after it was signed', async () => {
    const archive = zip(folderFiles(FIXTURES.basic))
    const changed = zip(folderFiles(FIXTURES.broad))
    await expect(verifyCrx(crx(changed, rsa, { signedArchive: archive }))).rejects.toThrow(
      'Its signature doesn’t match its contents.',
    )
  })

  it('refuses a file whose signature was made by a key other than the one it carries', async () => {
    const good = packFolder(FIXTURES.basic, rsa).file
    // The other key's signature over the same bytes, under this key's public key: swap the keys.
    const forged = Buffer.from(good)
    const at = forged.indexOf(rsa.publicKey)
    other.publicKey.copy(forged, at)
    await expect(verifyCrx(forged)).rejects.toThrow(CrxError)
  })

  it('refuses a file that names another extension’s ID', async () => {
    const { file } = packFolder(FIXTURES.basic, rsa, { claimId: other.id })
    await expect(verifyCrx(file)).rejects.toThrow('It isn’t signed with its own key.')
  })

  it('refuses a file that isn’t the extension asked for (a store install, EX-01)', async () => {
    const { file } = packFolder(FIXTURES.basic, rsa)
    await expect(verifyCrx(file, other.id)).rejects.toThrow('It isn’t the extension that was asked for.')
    expect((await verifyCrx(file, rsa.id)).id).toBe(rsa.id)
  })

  it('refuses a CRX2 file, a ZIP and a header cut short', async () => {
    const { file } = packFolder(FIXTURES.basic, rsa, { version: 2 })
    await expect(verifyCrx(file)).rejects.toThrow('It is a version 2 CRX file; Orbit installs version 3 only.')
    await expect(verifyCrx(zip(folderFiles(FIXTURES.basic)))).rejects.toThrow('It isn’t a CRX file.')
    const good = packFolder(FIXTURES.basic, rsa).file
    expect(() => parseCrx(good.subarray(0, 40))).toThrow('Its header is cut short.')
  })
})

describe('the archive', () => {
  const dirs: string[] = []
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-ext-zip-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('writes out every file of a deflated or a stored archive as it was', async () => {
    for (const stored of [false, true]) {
      const files = folderFiles(FIXTURES.basic)
      const out = join(scratch(), 'ext')
      await extractZip(zip(files, { stored }), out)
      for (const file of files) expect(readFileSync(join(out, file.name)).equals(file.data)).toBe(true)
    }
  })

  it('refuses names that could leave the folder, and writes nothing', async () => {
    for (const name of [
      '../evil.js',
      'a/../../evil.js',
      '/etc/evil.js',
      'C:/evil.js',
      'a\\..\\evil.js',
      './../evil.js',
    ]) {
      const root = scratch()
      const archive = zip([
        { name: 'manifest.json', data: Buffer.from('{}') },
        { name, data: Buffer.from('evil') },
      ])
      await expect(extractZip(archive, join(root, 'ext'))).rejects.toThrow('Its archive has a file outside its folder.')
      expect(readdirSync(root)).toEqual([])
    }
    expect(safeEntryName('./icons/a.png')).toBe('icons/a.png')
    expect(safeEntryName('icons/')).toBe('icons/')
    expect(safeEntryName('a//b')).toBeNull()
  })

  it('refuses a symbolic link, the same file twice, and a damaged file', async () => {
    const link = zip([{ name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }])
    expect(() => zipEntries(link)).toThrow('Its archive has a link.')
    const twice = zip([
      { name: 'a.js', data: Buffer.from('1') },
      { name: 'A.js', data: Buffer.from('2') },
    ])
    expect(() => zipEntries(twice)).toThrow('Its archive has the same file twice.')
    const damaged = zip([{ name: 'a.js', data: Buffer.from('console.log(1)') }], { stored: true })
    const at = damaged.indexOf('console') + 1
    damaged.writeUInt8(damaged.readUInt8(at) ^ 0xff, at)
    await expect(extractZip(damaged, join(scratch(), 'ext'))).rejects.toThrow('Its archive is damaged.')
  })

  it('refuses an encrypted file and a file past the size limit', () => {
    const archive = zip([{ name: 'a.js', data: Buffer.from('1') }], { stored: true })
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const encrypted = Buffer.from(archive)
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8)
    expect(() => zipEntries(encrypted)).toThrow('Its archive is encrypted.')
    const huge = Buffer.from(archive)
    huge.writeUInt32LE(ZIP_LIMITS.file + 1, central + 24)
    expect(() => zipEntries(huge)).toThrow('Its archive has a file that is too large.')
    expect(() => zipEntries(Buffer.from('not a zip'))).toThrow(ZipError)
  })
})
