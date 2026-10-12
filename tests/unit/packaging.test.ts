import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import afterPack from '../../scripts/after-pack.mjs'

/** The packaged app's build config (electron-builder.yml), read as electron-builder reads it. */
const root = join(import.meta.dirname, '../..')
const yaml = createRequire(join(root, 'node_modules/app-builder-lib/package.json'))('js-yaml') as {
  load: (text: string) => unknown
}
const config = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as Record<string, unknown>

describe('[ST-17] a packaged Orbit has Chromium’s licences, which the credits page links to', () => {
  it('runs the check after packing', () => {
    expect(config.afterPack).toBe('./scripts/after-pack.mjs')
  })

  it('fails a build without them, where each system keeps them', async () => {
    const out = mkdtempSync(join(tmpdir(), 'orbit-pack-'))
    const packager = { appInfo: { productFilename: 'Orbit' } }
    const mac = { appOutDir: out, electronPlatformName: 'darwin', packager }
    const linux = { appOutDir: out, electronPlatformName: 'linux', packager }
    await expect(afterPack(mac)).rejects.toThrow(/Orbit\.app\/Contents\/Resources\/LICENSES\.chromium\.html/)
    await expect(afterPack(linux)).rejects.toThrow(/LICENSES\.chromium\.html/)
    const inResources = join(out, 'Orbit.app/Contents/Resources/LICENSES.chromium.html')
    mkdirSync(dirname(inResources), { recursive: true })
    writeFileSync(inResources, '')
    await expect(afterPack(mac)).resolves.toBeUndefined()
    // Linux and Windows keep theirs beside the program.
    await expect(afterPack(linux)).rejects.toThrow()
    writeFileSync(join(out, 'LICENSES.chromium.html'), '')
    await expect(afterPack(linux)).resolves.toBeUndefined()
    await expect(afterPack({ ...linux, electronPlatformName: 'win32' })).resolves.toBeUndefined()
  })
})
