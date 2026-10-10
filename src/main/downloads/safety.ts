/**
 * Download safety (DL-12). Pure Node, unit-tested.
 * - Files that run code when opened (programs, installers, scripts, disk images) are held back
 *   before they go into place: the user keeps or discards each one.
 * - Finished files carry the OS's "downloaded from the internet" marker, so the OS asks before it
 *   runs one: the quarantine attribute on macOS (Gatekeeper), the Zone.Identifier stream on Windows
 *   (SmartScreen). Linux has no such marker.
 * Orbit has no reputation service (Safe Browsing needs a key from Google), so it can't tell a known
 * site from an unknown one: every file of these types is held, whatever the site.
 */
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { extensionOf } from '../../shared/commands/downloads'

const words = (...lines: string[]) => new Set(lines.join(' ').split(' '))

/** File types that can harm the computer when opened (by extension), on every system. */
const DANGEROUS = words(
  // Windows programs and installers (run elsewhere too: Wine, a shared drive), PowerShell
  'exe msi msix msixbundle appx appxbundle bat cmd com ps1 psm1',
  // macOS installers, and scripts Terminal runs when opened
  'dmg pkg mpkg app command tool terminal',
  // Linux packages, installers and launchers
  'deb rpm appimage run desktop',
  // scripts an installed interpreter runs when opened
  'sh bash zsh py pl rb',
  // disk images: opened, they mount as a drive whose files have no marker
  'iso img vhd vhdx',
  // other programs
  'jar jnlp apk',
)

/** File types only Windows runs when opened (a .js file is a program there: Windows Script Host). */
const ON_WINDOWS = words(
  // scripts
  'js jse vbs vbe wsf wsh wsc sct hta msh msh1 msh2 mshxml msh1xml msh2xml ps1xml ps2 ps2xml psc1 psc2',
  // shortcuts and Explorer files that run, open or fetch something elsewhere
  'lnk pif scr url scf settingcontent-ms library-ms searchconnector-ms',
  // settings, installer parts, system and add-in code, consoles, troubleshooters, remote desktops
  'reg inf cpl msc msp mst msu dll xll application appref-ms diagcab rdp',
  // compiled help, which runs its pages' scripts
  'chm',
)

/** A file that is held back until the user keeps it (DL-12). */
export function isDangerous(name: string, platform: string = process.platform): boolean {
  const ext = extensionOf(name)
  return DANGEROUS.has(ext) || (platform === 'win32' && ON_WINDOWS.has(ext))
}

/** Where a file came from, for its marker. */
export interface FileOrigin {
  /** The address it was downloaded from. */
  url: string
  /** The page it was downloaded from. */
  pageUrl?: string
  /** Downloaded in a private window: its marker names no address (DL-16). */
  private?: boolean
}

/** A URL fit to keep in a marker: http(s) only, without user name or password. */
function markerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    u.username = ''
    u.password = ''
    return u.href
  } catch {
    return undefined
  }
}

/**
 * Windows' Zone.Identifier stream: from the Internet zone (3), with the addresses when there are. A
 * private window's download says only where it is from: the zone (DL-16).
 */
export function zoneIdentifier(origin: FileOrigin): string {
  const lines = ['[ZoneTransfer]', 'ZoneId=3']
  const referrer = origin.private ? undefined : markerUrl(origin.pageUrl)
  const host = origin.private ? undefined : markerUrl(origin.url)
  if (referrer) lines.push(`ReferrerUrl=${referrer}`)
  if (host) lines.push(`HostUrl=${host}`)
  return `${lines.join('\r\n')}\r\n`
}

/** macOS's quarantine attribute: downloaded (flags 0081), when (hex seconds), by Orbit. */
export function quarantineValue(now: number = Date.now()): string {
  return `0081;${Math.floor(now / 1000).toString(16)};Orbit;`
}

/** Runs a program (the OS's `xattr` on macOS); swapped in tests. */
export type Runner = (file: string, args: string[]) => Promise<void>

const run: Runner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()))
  })

/**
 * Marks a finished file as downloaded from the internet (DL-12). Never throws: a file system without
 * the marker (FAT, a network share) just goes without.
 */
export async function markFromInternet(
  path: string,
  origin: FileOrigin,
  platform: string = process.platform,
  deps: { runner?: Runner; write?: (path: string, data: string) => Promise<void> } = {},
): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      await (deps.runner ?? run)('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(), path])
      return true
    }
    if (platform === 'win32') {
      await (deps.write ?? writeFile)(`${path}:Zone.Identifier`, zoneIdentifier(origin))
      return true
    }
  } catch (err) {
    console.error('[downloads] cannot mark a download as from the internet:', err)
  }
  return false
}
