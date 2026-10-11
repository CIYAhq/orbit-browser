import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { PdfAppStatus } from '../../shared/commands/settings'

/**
 * The class Windows knows Orbit's PDF files by: the installer registers Orbit for .pdf under it
 * (`win.fileAssociations` in electron-builder.yml, whose `name` is the class).
 */
export const PDF_PROG_ID = 'Orbit.PDF'

/** Where Windows keeps the app a user chose for .pdf files, the newer key first. */
const CHOICE_KEYS = ['UserChoiceLatest', 'UserChoice'].map(
  (key) => `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.pdf\\${key}`,
)

/** The text value `reg query` printed (`    ProgId    REG_SZ    Orbit.PDF`), or null. */
export function regText(output: string): string | null {
  return /\sREG_(?:EXPAND_)?SZ[ \t]+(.+)$/m.exec(output)?.[1]?.trim() || null
}

function regQuery(key: string, value: string | null): Promise<string | null> {
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const args = ['query', key, ...(value ? ['/v', value] : ['/ve'])]
  return new Promise((resolve) => {
    execFile(reg, args, { windowsHide: true, timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : regText(String(stdout))),
    )
  })
}

/** The class that opens .pdf files for this user: their choice in Windows, else the computer's. */
async function pdfClass(): Promise<string | null> {
  for (const key of CHOICE_KEYS) {
    const progId = await regQuery(key, 'ProgId')
    if (progId) return progId
  }
  return regQuery('HKCR\\.pdf', null)
}

/** Orbit as the app for the computer's PDF files (DL-13, ST-03): Windows only. */
export interface PdfApp {
  status(): Promise<PdfAppStatus>
  /** Windows lets only the user choose the app for a file type: its Default apps settings open. */
  set(): Promise<PdfAppStatus>
}

/** The real one. Unverified on Windows: no Windows build is tested. */
export function systemPdfApp(): PdfApp {
  const status = async (): Promise<PdfAppStatus> => {
    if (process.platform !== 'win32') return { available: false, isDefault: false, canSet: false }
    if (!app.isPackaged) {
      return {
        available: true,
        isDefault: false,
        canSet: false,
        note: 'Only an installed copy of Orbit can open PDF files from Windows.',
      }
    }
    return { available: true, isDefault: (await pdfClass()) === PDF_PROG_ID, canSet: true }
  }
  return {
    status,
    async set() {
      const now = await status()
      if (now.canSet && !now.isDefault) await shell.openExternal('ms-settings:defaultapps')
      return now
    },
  }
}

/** For e2e runs: stands in for Windows when asked (ORBIT_E2E_PDF_APP=1) and never touches the OS. */
export function stubPdfApp(available: boolean): PdfApp {
  let isDefault = false
  const status = async (): Promise<PdfAppStatus> => ({ available, isDefault, canSet: available })
  return {
    status,
    async set() {
      // As if the user chose Orbit in Windows' settings and came back.
      if (available) isDefault = true
      return status()
    },
  }
}
