/**
 * Printing a page (pages lane, NV-07): what Orbit's print dialog shows and sends back, and the
 * pure parts main and the dialog share. The dialog previews the whole page as it would print, and
 * prints to a printer or saves a PDF.
 */

/** The destination that saves a PDF instead of printing. */
export const SAVE_AS_PDF = 'pdf'

/** What the user chose in the print dialog. */
export interface PrintSettings {
  /** A printer's system name, or SAVE_AS_PDF. */
  destination: string
  /** Every page, or only `ranges`. */
  allPages: boolean
  /** The pages to print when not all, as typed: "1-5, 8, 11-13". */
  ranges: string
  /** Printers only. */
  copies: number
  landscape: boolean
  /** Printers only: false prints in black and white. */
  color: boolean
  /** The date, title, address and page numbers in the margins. */
  headerFooter: boolean
  /** The page's background colours and images. */
  background: boolean
}

/** Chromium's first choices; the dialog then starts from the last one's, until Orbit quits. */
export const DEFAULT_PRINT_SETTINGS: PrintSettings = {
  destination: SAVE_AS_PDF,
  allPages: true,
  ranges: '',
  copies: 1,
  landscape: false,
  color: true,
  headerFooter: true,
  background: false,
}

/** The settings that change how the page lays out on paper: the preview is made again for each. */
export const LAYOUT_SETTINGS = ['landscape', 'headerFooter', 'background'] as const

export const MAX_COPIES = 999

export interface PrintDestination {
  /** A printer's system name, or SAVE_AS_PDF. */
  id: string
  name: string
}

/** The preview: the whole page as it prints with the dialog's settings. */
export type PrintPreview =
  | { state: 'loading' }
  /** `version` changes with each new preview; `pages` is how many the page prints on. */
  | { state: 'ready'; version: number; pages: number; pdf: Uint8Array }
  | { state: 'error'; message: string }

/** What a print dialog view shows. */
export interface PrintContent {
  /** Changes with everything the view must show anew. */
  id: number
  /** This dialog: one per time it opens. */
  dialog: number
  /** The page's title. */
  title: string
  settings: PrintSettings
  destinations: PrintDestination[]
  preview: PrintPreview
  /** Printing or saving now. */
  busy: boolean
  /** Why the last try didn't print. */
  error?: string
}

/** One range of pages, counted from 1; `to` undefined runs to the last page. */
export interface PageRange {
  from: number
  to?: number
}

/**
 * Pages as the user types them ("1-5, 8, 11-13"; "9-" to the end): undefined if they can't be
 * read, or a range runs backwards. Spaces anywhere; commas between.
 */
export function parsePageRanges(text: string): PageRange[] | undefined {
  const ranges: PageRange[] = []
  for (const part of text.split(',')) {
    if (part.trim() === '') continue
    const match = /^\s*(\d{1,6})?\s*(-)?\s*(\d{1,6})?\s*$/.exec(part)
    if (!match) return undefined
    const [, a, dash, b] = match
    if (!a && !b) return undefined
    if (!dash && b) return undefined
    const from = a ? Number(a) : 1
    const to = dash ? (b ? Number(b) : undefined) : from
    if (from < 1 || (to !== undefined && to < from)) return undefined
    ranges.push(to === undefined ? { from } : { from, to })
  }
  return ranges.length > 0 ? ranges : undefined
}

/** The pages `ranges` pick of a page of `total` pages, counted from 1, in order and each once. */
export function selectedPages(ranges: PageRange[], total: number): number[] {
  const picked = new Set<number>()
  for (const { from, to } of ranges) for (let n = from; n <= Math.min(to ?? total, total); n++) picked.add(n)
  return [...picked].sort((a, b) => a - b)
}

/**
 * Why the dialog's pages can't be printed, or undefined if they can: ranges that can't be read,
 * or that name no page of the `total` (Chromium's wording).
 */
export function pagesProblem(settings: PrintSettings, total: number): string | undefined {
  if (settings.allPages) return undefined
  const ranges = parsePageRanges(settings.ranges)
  if (!ranges) return 'Invalid page range, use e.g. 1-5, 8, 11-13'
  const beyond = ranges.find((r) => r.from > total || (r.to ?? 0) > total)
  if (beyond) return `Out of bounds page reference, limit is ${total}`
  return selectedPages(ranges, total).length === 0 ? 'Invalid page range, use e.g. 1-5, 8, 11-13' : undefined
}

/** How many pages print: all `total`, or the ones picked. */
export function pageCount(settings: PrintSettings, total: number): number {
  if (settings.allPages) return total
  const ranges = parsePageRanges(settings.ranges)
  return ranges ? selectedPages(ranges, total).length : 0
}

/** What the dialog says it will use: "3 sheets of paper" for a printer, "3 pages" for a PDF. */
export function paperText(settings: PrintSettings, total: number): string {
  const pages = pageCount(settings, total)
  if (settings.destination === SAVE_AS_PDF) return pages === 1 ? '1 page' : `${pages} pages`
  const sheets = pages * settings.copies
  return sheets === 1 ? '1 sheet of paper' : `${sheets} sheets of paper`
}

/** The page ranges a printer gets: counted from 0, both ends in (Electron's `print`); none for all pages. */
export function printerRanges(settings: PrintSettings, total: number): { from: number; to: number }[] | undefined {
  if (settings.allPages) return undefined
  const pages = selectedPages(parsePageRanges(settings.ranges) ?? [], total)
  const ranges: { from: number; to: number }[] = []
  for (const n of pages) {
    const last = ranges[ranges.length - 1]
    if (last && last.to === n - 2) last.to = n - 1
    else ranges.push({ from: n - 1, to: n - 1 })
  }
  return ranges
}

/** The page ranges a PDF gets, as the engine reads them ("1-3,5"); empty for all pages. */
export function pdfRanges(settings: PrintSettings, total: number): string {
  return (printerRanges(settings, total) ?? [])
    .map((r) => (r.from === r.to ? `${r.from + 1}` : `${r.from + 1}-${r.to + 1}`))
    .join(',')
}

/** How many pages a PDF the engine made has (its page objects, read as Latin-1 text). */
export function countPdfPages(pdfText: string): number {
  return pdfText.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0
}

/** A file name for a page's PDF: its title (or "Page"), without characters file systems refuse (as Save Page As). */
export function pdfFileName(title: string): string {
  const printable = Array.from(title, (c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  const name = printable
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return `${name || 'Page'}.pdf`
}

/** Printers from JSON (`[{ id, name }]`), as test runs name theirs; none if it can't be read. */
export function printersFromJson(json: string | undefined): PrintDestination[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is PrintDestination => typeof p?.id === 'string' && typeof p?.name === 'string' && p.id !== SAVE_AS_PDF,
    )
  } catch {
    return []
  }
}

/** Settings sent by a dialog view, kept to what they can be; anything else stays as it was. */
export function cleanSettings(
  next: Partial<Record<keyof PrintSettings, unknown>>,
  was: PrintSettings,
  destinations: PrintDestination[],
): PrintSettings {
  const flag = (key: 'allPages' | 'landscape' | 'color' | 'headerFooter' | 'background') =>
    typeof next[key] === 'boolean' ? (next[key] as boolean) : was[key]
  const copies = Number(next.copies)
  return {
    destination:
      typeof next.destination === 'string' && destinations.some((d) => d.id === next.destination)
        ? next.destination
        : was.destination,
    allPages: flag('allPages'),
    ranges: typeof next.ranges === 'string' ? next.ranges.slice(0, 200) : was.ranges,
    copies:
      next.copies !== undefined && Number.isInteger(copies) && copies >= 1 && copies <= MAX_COPIES
        ? copies
        : was.copies,
    landscape: flag('landscape'),
    color: flag('color'),
    headerFooter: flag('headerFooter'),
    background: flag('background'),
  }
}
