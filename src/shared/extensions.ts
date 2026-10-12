/**
 * Chrome extensions (EX-*): the pure logic, shared by main and the renderers. Main installs, loads
 * and runs extensions (src/main/extensions/); the UI shows them from `OrbitState.extensions`.
 *
 * - Keys: an extension is installed per profile (EX-09), so the state keys it by profile and ID.
 * - Manifests: what Orbit reads of one (name, version, icons, popup, options page, permissions),
 *   with `__MSG_name__` texts taken from its `_locales`, as the engine does when it loads one.
 * - Permissions in plain language, for the confirmation (EX-02) and the extensions page (EX-07).
 * - CRX3 files: the header's proofs and signed data, which main verifies (src/main/extensions/crx.ts),
 *   and the extension ID they name.
 */
import type { InstalledExtension, ProfileId } from './state'

// ---- IDs and keys ---------------------------------------------------------

/** Chromium's extension IDs: 32 letters from a to p. */
export const EXTENSION_ID = /^[a-p]{32}$/

/** The state's key for an extension installed in a profile. */
export function extensionKey(profileId: ProfileId, id: string): string {
  return `${profileId}:${id}`
}

/** An ID from a SHA-256: its first 128 bits, each half-byte a letter from a (0) to p (15). */
export function idFromHash(hash: Uint8Array): string {
  if (hash.length < 16) throw new Error('hash too short')
  let id = ''
  for (let i = 0; i < 16; i++) {
    const byte = hash[i] as number
    id += String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
  }
  return id
}

/** A profile's extensions, enabled or not, in the order they were installed. */
export function extensionsOf(all: Record<string, InstalledExtension>, profileId: ProfileId): InstalledExtension[] {
  return Object.values(all)
    .filter((e) => e.profileId === profileId)
    .sort((a, b) => a.installedAt - b.installedAt || a.name.localeCompare(b.name))
}

/** A profile's pinned extensions, in pin order (EX-04). */
export function pinnedExtensions(all: Record<string, InstalledExtension>, profileId: ProfileId): InstalledExtension[] {
  return extensionsOf(all, profileId)
    .filter((e) => e.enabled && e.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
}

// ---- Manifests ------------------------------------------------------------

/** An extension Orbit refuses, with the reason in words for the person who added it. */
export class ExtensionError extends Error {
  override name = 'ExtensionError'
}

export interface ManifestAction {
  default_popup?: unknown
  default_title?: unknown
  default_icon?: unknown
}

export interface ManifestCommand {
  description?: unknown
  suggested_key?: unknown
}

/** What Orbit reads of an extension's manifest.json; the engine reads the rest itself. */
export interface ExtensionManifest {
  manifest_version: number
  name: string
  version: string
  short_name?: unknown
  description?: unknown
  default_locale?: unknown
  icons?: unknown
  action?: ManifestAction
  browser_action?: ManifestAction
  page_action?: ManifestAction
  options_page?: unknown
  options_ui?: { page?: unknown; open_in_tab?: unknown }
  permissions?: unknown
  optional_permissions?: unknown
  host_permissions?: unknown
  optional_host_permissions?: unknown
  content_scripts?: unknown
  commands?: unknown
  update_url?: unknown
  homepage_url?: unknown
  key?: unknown
  [field: string]: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 1 to 4 numbers from 0 to 65535, dot-separated, without leading zeros: the engine's rule. */
export function isValidVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false
  const parts = version.split('.')
  return (
    parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535)
  )
}

/** Compares two valid versions: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Reads manifest.json's text: an object with a name and a valid version, for Manifest V2 or V3.
 * Its texts aren't localized yet (`localizeManifest`).
 */
export function parseManifest(text: string): ExtensionManifest {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new ExtensionError('Its manifest isn’t valid JSON.')
  }
  if (!isObject(json)) throw new ExtensionError('Its manifest isn’t valid JSON.')
  const version = json.manifest_version
  if (version !== 2 && version !== 3) {
    throw new ExtensionError(
      typeof version === 'number'
        ? `It uses manifest version ${version}, which Orbit can’t run.`
        : 'Its manifest has no manifest version.',
    )
  }
  if (typeof json.name !== 'string' || json.name.trim() === '') throw new ExtensionError('Its manifest has no name.')
  if (!isValidVersion(json.version)) throw new ExtensionError('Its manifest’s version isn’t valid.')
  return json as ExtensionManifest
}

/** A locale's messages.json: `{ key: { message } }`. */
export type LocaleMessages = Record<string, { message?: unknown }>

/** The locales to try for an extension's texts: the user's, then its default. Folder names use `_`. */
export function localesToTry(defaultLocale: unknown, preferred: readonly string[]): string[] {
  const out: string[] = []
  const add = (l: string) => {
    if (l && !out.includes(l)) out.push(l)
  }
  for (const p of preferred) {
    const l = p.replace(/-/g, '_')
    add(l)
    add(l.split('_')[0] ?? '')
  }
  add(str(defaultLocale))
  return out
}

/** Replaces `__MSG_key__` with the message (keys are case-insensitive); unknown keys become ''. */
export function localize(text: string, messages: readonly LocaleMessages[]): string {
  if (!text.includes('__MSG_')) return text
  return text.replace(/__MSG_([A-Za-z0-9_@]+?)__/g, (_m, key: string) => {
    const wanted = key.toLowerCase()
    for (const set of messages) {
      for (const [k, v] of Object.entries(set)) {
        if (k.toLowerCase() === wanted && isObject(v) && typeof v.message === 'string') return v.message
      }
    }
    return ''
  })
}

/** The manifest with its name, description and action title in the first locale that has them. */
export function localizeManifest(manifest: ExtensionManifest, messages: readonly LocaleMessages[]): ExtensionManifest {
  const out: ExtensionManifest = { ...manifest, name: localize(manifest.name, messages).trim() || manifest.name }
  if (typeof manifest.short_name === 'string') out.short_name = localize(manifest.short_name, messages)
  if (typeof manifest.description === 'string') out.description = localize(manifest.description, messages)
  const action = actionOf(manifest)
  if (action && typeof action.default_title === 'string') {
    const title = localize(action.default_title, messages)
    if (manifest.action) out.action = { ...manifest.action, default_title: title }
    else if (manifest.browser_action) out.browser_action = { ...manifest.browser_action, default_title: title }
    else if (manifest.page_action) out.page_action = { ...manifest.page_action, default_title: title }
  }
  return out
}

/** Its toolbar action: Manifest V3's `action`, or V2's browser or page action. */
export function actionOf(manifest: ExtensionManifest): ManifestAction | undefined {
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action
  return isObject(action) ? action : undefined
}

/** A path inside the extension, as the manifest gives it: no scheme, no leading slash, no `..`. */
export function extensionPath(path: unknown): string {
  if (typeof path !== 'string') return ''
  const clean = path.trim().replace(/^\.?\/+/, '')
  if (!clean || clean.includes('\\') || /^[a-z][\w+.-]*:/i.test(clean)) return ''
  if (clean.split('/').some((part) => part === '..')) return ''
  return clean
}

/** Its popup's path inside the extension, '' for none (EX-05). */
export function popupOf(manifest: ExtensionManifest): string {
  return extensionPath(actionOf(manifest)?.default_popup)
}

/** Its options page's path inside the extension, '' for none (EX-07). */
export function optionsPageOf(manifest: ExtensionManifest): string {
  return (
    extensionPath(isObject(manifest.options_ui) ? manifest.options_ui.page : undefined) ||
    extensionPath(manifest.options_page)
  )
}

/**
 * The icon to show at `size` px: the toolbar action's own icon first, else the extension's.
 * The smallest one at least that big, else the biggest there is; '' for none.
 */
export function iconPathOf(manifest: ExtensionManifest, size = 32): string {
  const pick = (icons: unknown): string => {
    if (typeof icons === 'string') return extensionPath(icons)
    if (!isObject(icons)) return ''
    const sized = Object.entries(icons)
      .map(([k, v]) => [Number(k), extensionPath(v)] as const)
      .filter(([k, v]) => Number.isFinite(k) && k > 0 && v)
      .sort((a, b) => a[0] - b[0])
    const fit = sized.find(([k]) => k >= size) ?? sized[sized.length - 1]
    return fit?.[1] ?? ''
  }
  return pick(actionOf(manifest)?.default_icon) || pick(manifest.icons)
}

// ---- Permissions ----------------------------------------------------------

/** A match pattern (or `<all_urls>`) rather than an API permission. */
export function isHostPattern(value: string): boolean {
  return value === '<all_urls>' || /^(\*|https?|wss?|ftp|file|urn):\/\//i.test(value)
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The API permissions it asks for at install (not its optional ones), as written. */
export function apiPermissionsOf(manifest: ExtensionManifest): string[] {
  return [...new Set(strings(manifest.permissions).filter((p) => !isHostPattern(p)))]
}

/**
 * The sites it asks for at install: Manifest V3's host permissions, V2's patterns among its
 * permissions, and every page its content scripts run on (they read and change those pages too).
 */
export function hostPatternsOf(manifest: ExtensionManifest): string[] {
  const out = new Set<string>()
  for (const p of strings(manifest.host_permissions)) out.add(p)
  for (const p of strings(manifest.permissions)) if (isHostPattern(p)) out.add(p)
  if (Array.isArray(manifest.content_scripts)) {
    for (const script of manifest.content_scripts) {
      if (isObject(script)) for (const p of strings(script.matches)) out.add(p)
    }
  }
  return [...out]
}

/** The host a pattern names (`*.example.com` → `example.com`); '*' for any host; '' for none. */
export function patternHost(pattern: string): string {
  if (pattern === '<all_urls>') return '*'
  const m = /^[^:]+:\/\/([^/]*)/.exec(pattern)
  if (!m) return ''
  const host = (m[1] ?? '').replace(/:\d+$|:\*$/, '').toLowerCase()
  if (host === '*') return '*'
  return host.replace(/^\*\./, '')
}

/** True when the patterns reach every website. */
export function reachesAllSites(patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === '<all_urls>') return true
    const scheme = p.split(':')[0]?.toLowerCase()
    return patternHost(p) === '*' && (scheme === '*' || scheme === 'http' || scheme === 'https')
  })
}

/** The named sites the patterns reach, without duplicates (file:// pages aside). */
export function sitesOf(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const p of patterns) {
    if (/^file:/i.test(p)) continue
    const host = patternHost(p)
    if (host && host !== '*' && !out.includes(host)) out.push(host)
  }
  return out
}

/** Where it may run, for its Details (EX-07): "On all sites", "On a.com and b.com", "None". */
export function siteAccessText(patterns: readonly string[]): string {
  if (reachesAllSites(patterns)) return 'On all sites'
  const sites = sitesOf(patterns)
  if (sites.length === 0) return 'None'
  if (sites.length === 1) return `On ${sites[0]}`
  if (sites.length <= 3) return `On ${sites.slice(0, -1).join(', ')} and ${sites[sites.length - 1]}`
  return `On ${sites[0]}, ${sites[1]} and ${sites.length - 2} other sites`
}

/** The all-sites line, in the spec's words (EX-02). */
export const ALL_SITES_TEXT = 'Read and change all your data on all websites'

/**
 * What an API permission lets an extension do, in plain words (EX-02). Permissions that can do
 * nothing a person would notice on their own (storage, alarms, context menus…) have no line.
 */
const API_TEXT: Readonly<Record<string, string>> = {
  debugger: ALL_SITES_TEXT,
  proxy: ALL_SITES_TEXT,
  history: 'Read and change your browsing history',
  tabs: 'Read your browsing history',
  webNavigation: 'Read your browsing history',
  declarativeNetRequestFeedback: 'Read your browsing history',
  topSites: 'Read a list of the websites you visit most',
  bookmarks: 'Read and change your bookmarks',
  readingList: 'Read and change your reading list',
  downloads: 'Manage your downloads',
  'downloads.open': 'Open files you downloaded',
  clipboardRead: 'Read what you copy and paste',
  clipboardWrite: 'Change what you copy and paste',
  geolocation: 'Know where you are',
  desktopCapture: 'Record what is on your screen',
  tabCapture: 'Record what your tabs show',
  pageCapture: 'Save the pages you visit',
  declarativeNetRequest: 'Block content on any page',
  contentSettings: 'Change which websites may use cookies, JavaScript, your camera, microphone or location',
  privacy: 'Change your privacy settings',
  management: 'Manage your other extensions',
  nativeMessaging: 'Talk to apps installed on your computer',
  notifications: 'Show notifications',
  'system.storage': 'See and eject storage devices',
  favicon: 'Read the icons of the websites you visit',
  ttsEngine: 'Read all text spoken with synthesized speech',
  userScripts: 'Run scripts you add on websites',
}

/**
 * Everything an extension may do, in plain words, most far-reaching first (EX-02, EX-07): its sites
 * (all of them, or the ones it names), then what its API permissions allow.
 */
export function permissionLines(permissions: readonly string[], hosts: readonly string[]): string[] {
  const lines: string[] = []
  const add = (line: string) => {
    if (!lines.includes(line)) lines.push(line)
  }
  if (reachesAllSites(hosts)) add(ALL_SITES_TEXT)
  else {
    const sites = sitesOf(hosts)
    if (sites.length === 1) add(`Read and change your data on ${sites[0]}`)
    else if (sites.length === 2) add(`Read and change your data on ${sites[0]} and ${sites[1]}`)
    else if (sites.length === 3) add(`Read and change your data on ${sites[0]}, ${sites[1]} and ${sites[2]}`)
    else if (sites.length > 3) {
      add(`Read and change your data on ${sites[0]}, ${sites[1]} and ${sites.length - 2} other websites`)
    }
  }
  if (hosts.some((h) => /^file:/i.test(h))) add('Read files on your computer that you open in Orbit')
  for (const p of permissions) {
    const text = API_TEXT[p]
    if (text) add(text)
  }
  return lines
}

/** The permissions in `next` that `prev` didn't have (EX-02, EX-15): an update asking for more. */
export function addedPermissions(
  prev: { permissions: readonly string[]; hosts: readonly string[] },
  next: { permissions: readonly string[]; hosts: readonly string[] },
): string[] {
  const before = new Set(permissionLines(prev.permissions, prev.hosts))
  return permissionLines(next.permissions, next.hosts).filter((line) => !before.has(line))
}

// ---- State ----------------------------------------------------------------

/** The installed extensions of a saved state, checked: entries of profiles that are gone are dropped. */
export function normalizeExtensions(
  raw: unknown,
  profiles: Readonly<Record<string, unknown>>,
): Record<string, InstalledExtension> {
  const out: Record<string, InstalledExtension> = {}
  if (!isObject(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (!isObject(value)) continue
    const id = str(value.id)
    const profileId = str(value.profileId)
    if (!EXTENSION_ID.test(id) || !Object.hasOwn(profiles, profileId) || key !== extensionKey(profileId, id)) continue
    const path = str(value.path)
    if (!path) continue
    const source = value.source === 'store' || value.source === 'folder' ? value.source : 'crx'
    const ext: InstalledExtension = {
      id,
      profileId,
      name: str(value.name) || id,
      version: isValidVersion(value.version) ? value.version : '0',
      description: str(value.description),
      source,
      path,
      enabled: value.enabled !== false,
      allowPrivate: value.allowPrivate === true,
      allowFileAccess: value.allowFileAccess === true,
      permissions: strings(value.permissions),
      hosts: strings(value.hosts),
      icon: /^data:image\/png;base64,[A-Za-z0-9+/=]*$/.test(str(value.icon)) ? str(value.icon) : '',
      popup: extensionPath(value.popup),
      options: extensionPath(value.options),
      installedAt: typeof value.installedAt === 'number' && Number.isFinite(value.installedAt) ? value.installedAt : 0,
    }
    if (typeof value.pinnedAt === 'number' && Number.isFinite(value.pinnedAt)) ext.pinnedAt = value.pinnedAt
    if (typeof value.updateUrl === 'string' && /^https?:\/\//i.test(value.updateUrl)) ext.updateUrl = value.updateUrl
    out[key] = ext
  }
  return out
}

/** The extension settings of a saved state, checked (EX-07). */
export function normalizeExtensionSettings(settings: { extensionsDevMode?: unknown }): void {
  if (typeof settings.extensionsDevMode !== 'boolean') settings.extensionsDevMode = false
}

// ---- CRX3 files -----------------------------------------------------------

/**
 * A CRX3 file (the engine's packed extension): "Cr24", version 3, the header's size, the header (a
 * protobuf `CrxFileHeader`), then the ZIP archive. The header holds proofs (a public key and its
 * signature) and the signed header data, which names the extension's ID.
 */
export interface CrxProof {
  algorithm: 'rsa' | 'ecdsa'
  /** DER SubjectPublicKeyInfo. */
  publicKey: Uint8Array
  signature: Uint8Array
}

export interface ParsedCrx {
  proofs: CrxProof[]
  /** The signed header data (a protobuf `SignedData`), as signed. */
  signedHeaderData: Uint8Array
  /** The 16-byte ID it declares (`SignedData.crx_id`), if any. */
  crxId: Uint8Array | undefined
  /** The ZIP archive after the header. */
  archive: Uint8Array
}

/** A CRX file Orbit refuses, with the reason in words. */
export class CrxError extends ExtensionError {
  override name = 'CrxError'
}

const MAGIC = [0x43, 0x72, 0x32, 0x34] // "Cr24"

interface ProtoField {
  field: number
  bytes?: Uint8Array
}

/** The fields of a protobuf message: length-delimited ones with their bytes, others skipped. */
function protoFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let at = 0
  const varint = (): number => {
    let value = 0
    let scale = 1
    for (let i = 0; i < 8; i++) {
      if (at >= buf.length) throw new CrxError('Its header is cut short.')
      const b = buf[at++] as number
      value += (b & 0x7f) * scale
      if ((b & 0x80) === 0) return value
      scale *= 128
    }
    throw new CrxError('Its header is malformed.')
  }
  while (at < buf.length) {
    const key = varint()
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) varint()
    else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else if (wire === 2) {
      const length = varint()
      if (at + length > buf.length) throw new CrxError('Its header is cut short.')
      out.push({ field, bytes: buf.subarray(at, at + length) })
      at += length
    } else throw new CrxError('Its header is malformed.')
    if (at > buf.length) throw new CrxError('Its header is cut short.')
  }
  return out
}

/** Reads a CRX3 file's header. Throws CrxError for anything else (CRX2 included). */
export function parseCrx(bytes: Uint8Array): ParsedCrx {
  if (bytes.length < 12 || MAGIC.some((b, i) => bytes[i] !== b)) throw new CrxError('It isn’t a CRX file.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  if (version !== 3) throw new CrxError(`It is a version ${version} CRX file; Orbit installs version 3 only.`)
  const headerSize = view.getUint32(8, true)
  if (headerSize > bytes.length - 12) throw new CrxError('Its header is cut short.')
  const header = bytes.subarray(12, 12 + headerSize)
  const proofs: CrxProof[] = []
  let signedHeaderData: Uint8Array | undefined
  for (const { field, bytes: value } of protoFields(header)) {
    if (!value) continue
    if (field === 2 || field === 3) {
      let publicKey: Uint8Array | undefined
      let signature: Uint8Array | undefined
      for (const f of protoFields(value)) {
        if (f.field === 1) publicKey = f.bytes
        if (f.field === 2) signature = f.bytes
      }
      if (!publicKey || !signature) throw new CrxError('A signature in its header is incomplete.')
      proofs.push({ algorithm: field === 2 ? 'rsa' : 'ecdsa', publicKey, signature })
    } else if (field === 10000) signedHeaderData = value
  }
  if (!signedHeaderData) throw new CrxError('Its header names no extension.')
  let crxId: Uint8Array | undefined
  for (const f of protoFields(signedHeaderData)) if (f.field === 1) crxId = f.bytes
  if (crxId && crxId.length !== 16) throw new CrxError('Its header names no extension.')
  if (proofs.length === 0) throw new CrxError('It isn’t signed.')
  return { proofs, signedHeaderData, crxId, archive: bytes.subarray(12 + headerSize) }
}

const SIGNED_PREFIX = 'CRX3 SignedData\x00'

/**
 * What each proof signs, before the archive: "CRX3 SignedData\0", the signed header data's length
 * (4 bytes, little-endian), and the signed header data. The archive follows.
 */
export function crxSignedPrefix(signedHeaderData: Uint8Array): Uint8Array {
  const out = new Uint8Array(SIGNED_PREFIX.length + 4 + signedHeaderData.length)
  for (let i = 0; i < SIGNED_PREFIX.length; i++) out[i] = SIGNED_PREFIX.charCodeAt(i)
  new DataView(out.buffer).setUint32(SIGNED_PREFIX.length, signedHeaderData.length, true)
  out.set(signedHeaderData, SIGNED_PREFIX.length + 4)
  return out
}
