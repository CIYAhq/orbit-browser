import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeImage } from 'electron'
import {
  apiPermissionsOf,
  ExtensionError,
  type ExtensionManifest,
  hostPatternsOf,
  iconPathOf,
  type LocaleMessages,
  localesToTry,
  localizeManifest,
  optionsPageOf,
  parseManifest,
  popupOf,
} from '../../shared/extensions'

/** What Orbit reads of an extension's folder before it installs or lists it (EX-02, EX-07). */
export interface FolderInfo {
  /** Its manifest as written (with `__MSG_…__` texts). */
  raw: ExtensionManifest
  /** Its manifest with its texts in the user's language. */
  manifest: ExtensionManifest
  permissions: string[]
  hosts: string[]
  popup: string
  options: string
  /** A 32 px PNG data URL, or ''. */
  icon: string
}

/** A manifest larger than this isn't read: real ones are a few kB. */
const MAX_MANIFEST_BYTES = 1024 * 1024

const userLocales = (): string[] => {
  try {
    return [app.getLocale(), ...app.getPreferredSystemLanguages()]
  } catch {
    return ['en']
  }
}

async function readSmall(path: string, max: number): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > max) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Reads and checks an extension's folder. Throws ExtensionError with the reason, in words. */
export async function readFolder(dir: string): Promise<FolderInfo> {
  const text = await readSmall(join(dir, 'manifest.json'), MAX_MANIFEST_BYTES)
  if (text === undefined) throw new ExtensionError('The folder has no manifest.json.')
  const raw = parseManifest(text)
  const messages: LocaleMessages[] = []
  for (const locale of localesToTry(raw.default_locale, userLocales())) {
    if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})*$/.test(locale)) continue
    const json = await readSmall(join(dir, '_locales', locale, 'messages.json'), MAX_MANIFEST_BYTES)
    if (json === undefined) continue
    try {
      const parsed: unknown = JSON.parse(json.replace(/^﻿/, ''))
      if (parsed && typeof parsed === 'object') messages.push(parsed as LocaleMessages)
    } catch {
      // The engine says so when it loads the extension.
    }
  }
  const manifest = localizeManifest(raw, messages)
  return {
    raw,
    manifest,
    permissions: apiPermissionsOf(manifest),
    hosts: hostPatternsOf(manifest),
    popup: popupOf(manifest),
    options: optionsPageOf(manifest),
    icon: iconDataUrl(dir, manifest),
  }
}

/** Its icon at 32 px as a PNG data URL ('' when it has none Orbit can read). */
export function iconDataUrl(dir: string, manifest: ExtensionManifest): string {
  const path = iconPathOf(manifest, 32)
  if (!path) return ''
  try {
    const image = nativeImage.createFromPath(join(dir, path))
    if (image.isEmpty()) return ''
    const { width, height } = image.getSize()
    const small = width > 32 || height > 32 ? image.resize({ width: 32, height: 32, quality: 'best' }) : image
    return small.toDataURL()
  } catch {
    return ''
  }
}
