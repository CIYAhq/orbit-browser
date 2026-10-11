import { describe, expect, it } from 'vitest'
import {
  cleanSettings,
  countPdfPages,
  DEFAULT_PRINT_SETTINGS,
  type PrintSettings,
  pageCount,
  pagesProblem,
  paperText,
  parsePageRanges,
  pdfFileName,
  pdfRanges,
  printerRanges,
  printersFromJson,
  SAVE_AS_PDF,
  selectedPages,
} from '../../src/shared/print'

const settings = (more: Partial<PrintSettings> = {}): PrintSettings => ({ ...DEFAULT_PRINT_SETTINGS, ...more })
const custom = (ranges: string, more: Partial<PrintSettings> = {}) => settings({ allPages: false, ranges, ...more })

describe('[NV-07] the pages a person types in the print dialog', () => {
  it('reads pages and ranges, with spaces anywhere', () => {
    expect(parsePageRanges('1-5, 8, 11-13')).toEqual([
      { from: 1, to: 5 },
      { from: 8, to: 8 },
      { from: 11, to: 13 },
    ])
    expect(parsePageRanges(' 2 - 4 ')).toEqual([{ from: 2, to: 4 }])
    expect(parsePageRanges('3,,4,')).toEqual([
      { from: 3, to: 3 },
      { from: 4, to: 4 },
    ])
  })

  it('reads open ranges: from the first page, or to the last', () => {
    expect(parsePageRanges('-3')).toEqual([{ from: 1, to: 3 }])
    expect(parsePageRanges('9-')).toEqual([{ from: 9 }])
  })

  it('reads nothing it can’t be sure of', () => {
    for (const text of ['', ' ', ',', '-', 'two', '1 2', '5-3', '0', '1-0', '1-2-3', '1.5', '+2']) {
      expect(parsePageRanges(text), text).toBeUndefined()
    }
  })

  it('picks each page once, in order, and none past the last', () => {
    expect(
      selectedPages(
        [
          { from: 4, to: 6 },
          { from: 1, to: 2 },
          { from: 5, to: 5 },
        ],
        10,
      ),
    ).toEqual([1, 2, 4, 5, 6])
    expect(selectedPages([{ from: 3 }], 5)).toEqual([3, 4, 5])
    expect(selectedPages([{ from: 4, to: 9 }], 5)).toEqual([4, 5])
  })

  it('says why pages can’t be printed, as Chromium does', () => {
    expect(pagesProblem(settings(), 5)).toBeUndefined()
    expect(pagesProblem(custom('2-3'), 5)).toBeUndefined()
    expect(pagesProblem(custom('3-'), 5)).toBeUndefined()
    expect(pagesProblem(custom('6'), 5)).toBe('Out of bounds page reference, limit is 5')
    expect(pagesProblem(custom('4-6'), 5)).toBe('Out of bounds page reference, limit is 5')
    expect(pagesProblem(custom('9-'), 5)).toBe('Out of bounds page reference, limit is 5')
    expect(pagesProblem(custom('two'), 5)).toBe('Invalid page range, use e.g. 1-5, 8, 11-13')
    expect(pagesProblem(custom(''), 5)).toBe('Invalid page range, use e.g. 1-5, 8, 11-13')
  })
})

describe('[NV-07] what the print dialog says it will use', () => {
  it('counts pages for a PDF, and sheets (times the copies) for a printer', () => {
    expect(pageCount(settings(), 5)).toBe(5)
    expect(pageCount(custom('1-2, 4'), 5)).toBe(3)
    expect(pageCount(custom('two'), 5)).toBe(0)
    expect(paperText(settings(), 1)).toBe('1 page')
    expect(paperText(custom('2-3'), 5)).toBe('2 pages')
    expect(paperText(settings({ destination: 'Office' }), 1)).toBe('1 sheet of paper')
    expect(paperText(custom('1-2', { destination: 'Office', copies: 2 }), 5)).toBe('4 sheets of paper')
  })
})

describe('[NV-07] the pages a print job gets', () => {
  it('gives a printer ranges counted from 0, joined where they meet; none for every page', () => {
    expect(printerRanges(settings(), 5)).toBeUndefined()
    expect(printerRanges(custom('1-2, 4, 5'), 6)).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ])
    expect(printerRanges(custom('3-'), 5)).toEqual([{ from: 2, to: 4 }])
    expect(printerRanges(custom('5, 1'), 5)).toEqual([
      { from: 0, to: 0 },
      { from: 4, to: 4 },
    ])
  })

  it('gives a PDF the same pages as the engine reads them', () => {
    expect(pdfRanges(settings(), 5)).toBe('')
    expect(pdfRanges(custom('1-3, 5'), 5)).toBe('1-3,5')
    expect(pdfRanges(custom('2-3'), 5)).toBe('2-3')
  })

  it('counts a PDF’s pages, not its page tree', () => {
    const pdf = '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> << /Type /Page >> <</Type/Page/Parent 2 0 R>>'
    expect(countPdfPages(pdf)).toBe(2)
    expect(countPdfPages('nothing here')).toBe(0)
  })

  it('names a saved PDF after the page, without what file systems refuse', () => {
    expect(pdfFileName('Print')).toBe('Print.pdf')
    expect(pdfFileName('A/B: c? "d" <e>|f*')).toBe('A B c d e f.pdf')
    expect(pdfFileName('line\none\ttab')).toBe('line one tab.pdf')
    expect(pdfFileName('..hidden')).toBe('hidden.pdf')
    expect(pdfFileName('   ')).toBe('Page.pdf')
    expect(pdfFileName('')).toBe('Page.pdf')
    expect(pdfFileName('x'.repeat(300))).toBe(`${'x'.repeat(120)}.pdf`)
  })
})

describe('[NV-07] settings a print dialog view sends', () => {
  const destinations = [
    { id: SAVE_AS_PDF, name: 'Save as PDF' },
    { id: 'Office', name: 'Office Printer' },
  ]

  it('takes what they can be, and keeps the rest as it was', () => {
    const was = settings()
    expect(cleanSettings({ destination: 'Office', copies: 3, landscape: true }, was, destinations)).toEqual({
      ...was,
      destination: 'Office',
      copies: 3,
      landscape: true,
    })
    expect(cleanSettings({}, was, destinations)).toEqual(was)
  })

  it('refuses a printer that isn’t there, copies out of range, and values of the wrong kind', () => {
    const was = settings({ destination: 'Office', copies: 2 })
    const next = cleanSettings(
      { destination: 'Elsewhere', copies: 1000, color: 'no', allPages: 0, ranges: 5, background: null },
      was,
      destinations,
    )
    expect(next).toEqual(was)
    expect(cleanSettings({ copies: 0 }, was, destinations).copies).toBe(2)
    expect(cleanSettings({ copies: 1.5 }, was, destinations).copies).toBe(2)
    expect(cleanSettings({ copies: 999 }, was, destinations).copies).toBe(999)
    expect(cleanSettings({ ranges: '1'.repeat(500) }, was, destinations).ranges).toHaveLength(200)
  })
})

describe('[NV-07] the printers a test run names', () => {
  it('reads them from JSON, and none from anything else', () => {
    expect(printersFromJson('[{"id":"Office","name":"Office Printer"}]')).toEqual([
      { id: 'Office', name: 'Office Printer' },
    ])
    expect(printersFromJson(undefined)).toEqual([])
    expect(printersFromJson('not json')).toEqual([])
    expect(printersFromJson('{"id":"Office"}')).toEqual([])
    // Not the PDF's own id, and only whole entries.
    expect(printersFromJson('[{"id":"pdf","name":"Fake"},{"id":"A"},{"id":"B","name":"B"}]')).toEqual([
      { id: 'B', name: 'B' },
    ])
  })
})
