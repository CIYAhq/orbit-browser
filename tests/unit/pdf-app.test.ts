import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { urlsInArgv } from '../../src/main/external-links'
import { PDF_PROG_ID, regText, stubPdfApp } from '../../src/main/settings/pdf-app'

/** electron-builder.yml, read with the YAML reader electron-builder itself uses. */
function builderConfig(): Record<string, unknown> {
  const require = createRequire(resolve('node_modules/app-builder-lib/package.json'))
  const yaml = require('js-yaml') as { load: (text: string) => unknown }
  return yaml.load(readFileSync(resolve('electron-builder.yml'), 'utf8')) as Record<string, unknown>
}

describe('Orbit for PDF files on Windows (DL-13, ST-03)', () => {
  it('has the Windows installer register Orbit for .pdf under the class Settings looks for', () => {
    const config = builderConfig()
    const win = config.win as { fileAssociations?: { ext: string; name: string }[] } | undefined
    expect(win?.fileAssociations).toEqual([expect.objectContaining({ ext: 'pdf', name: PDF_PROG_ID })])
    // Windows only: the Mac app's document types stay its own (mac.extendInfo).
    expect(config.fileAssociations).toBeUndefined()
    expect((config.mac as Record<string, unknown>).fileAssociations).toBeUndefined()
  })

  it('reads the class Windows names in `reg query`', () => {
    const choice =
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\UserChoice\r\n    ProgId    REG_SZ    Orbit.PDF\r\n\r\n'
    expect(regText(choice)).toBe(PDF_PROG_ID)
    expect(regText('\r\nHKEY_CLASSES_ROOT\\.pdf\r\n    (Default)    REG_SZ    AcroExch.Document.DC\r\n')).toBe(
      'AcroExch.Document.DC',
    )
    // A key with no value set, or nothing printed.
    expect(regText('\r\nHKEY_CLASSES_ROOT\\.pdf\r\n    (Default)    REG_SZ    \r\n')).toBeNull()
    expect(regText('')).toBeNull()
  })

  it('opens a PDF Windows passes on the command line (the installer runs `Orbit.exe "%1"`)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-pdf-'))
    const file = join(dir, 'Report 2026.pdf')
    writeFileSync(file, '%PDF-1.4\n')
    expect(urlsInArgv(['/opt/Orbit/orbit', file], dir)).toEqual([pathToFileURL(file).href])
  })

  it('offers nothing where it stands in for no Windows, and becomes the app once chosen where it does', async () => {
    expect(await stubPdfApp(false).status()).toEqual({ available: false, isDefault: false, canSet: false })
    expect(await stubPdfApp(false).set()).toEqual({ available: false, isDefault: false, canSet: false })
    const win = stubPdfApp(true)
    expect(await win.status()).toEqual({ available: true, isDefault: false, canSet: true })
    expect(await win.set()).toEqual({ available: true, isDefault: true, canSet: true })
  })
})
