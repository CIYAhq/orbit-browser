import { type CSSProperties, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type PrintContent, type PrintSettings, pagesProblem, paperText, SAVE_AS_PDF } from '../../../shared/print'
import { invoke } from '../api'
import { useWindow } from '../store'
import { paletteVars, usePalette } from '../theme'
import './print.css'

/**
 * The print dialog (NV-07), in a transparent view main keeps over the page being printed: the page
 * as it prints (the engine's PDF of it, in the PDF viewer, without its toolbar) beside the settings,
 * and Print (Save, for Save as PDF) and Cancel. Main closes it on Esc wherever its keyboard is, the
 * preview included (KS-19); Enter prints; Tab stays inside it. Main gives the keyboard back to the
 * page when it goes (KS-16).
 */
export function PrintApp() {
  const win = useWindow()
  const palette = usePalette(win?.spaceId)
  const [content, setContent] = useState<PrintContent | null>(null)
  /** The preview's PDF as a blob URL, kept while the next one is made. */
  const [pdf, setPdf] = useState<{ version: number; url: string } | null>(null)

  useEffect(() => {
    let heard = false
    const take = (next: PrintContent | null) => {
      setContent(next)
      const preview = next?.preview
      if (preview?.state !== 'ready') return
      setPdf((was) => {
        if (was?.version === preview.version) return was
        if (was) URL.revokeObjectURL(was.url)
        const url = URL.createObjectURL(new Blob([preview.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }))
        return { version: preview.version, url }
      })
    }
    const off = window.orbit.on('print:content', (payload) => {
      heard = true
      take(payload as PrintContent)
    })
    // What main sent before this page listened is lost: ask for the dialog now.
    void invoke('pages.printContent', {}).then((first) => {
      if (!heard) take(first)
    })
    return off
  }, [])

  return (
    <div className="page-print-view" style={paletteVars(palette) as CSSProperties} data-testid="print-view">
      {content && <PrintDialog key={content.dialog} content={content} pdfUrl={pdf?.url} />}
    </div>
  )
}

function PrintDialog({ content, pdfUrl }: { content: PrintContent; pdfUrl?: string }) {
  const form = useRef<HTMLFormElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  // The dialog's own copy, so typing isn't held up by main's answer; main's comes back the same.
  const [settings, setSettings] = useState<PrintSettings>(content.settings)
  const [copies, setCopies] = useState(String(content.settings.copies))
  const { preview, busy } = content
  const total = preview.state === 'ready' ? preview.pages : undefined
  const problem = total === undefined ? undefined : pagesProblem(settings, total)
  const pdfDestination = settings.destination === SAVE_AS_PDF
  const ready = total !== undefined && !problem && !busy

  // Main may have changed what the dialog shows: a printer gone, the destination back to the PDF.
  useEffect(() => {
    setSettings((was) =>
      was.destination === content.settings.destination ? was : { ...was, destination: content.settings.destination },
    )
  }, [content.settings.destination])

  const change = (next: Partial<PrintSettings>) => {
    setSettings((was) => ({ ...was, ...next }))
    void invoke('pages.printChange', { dialog: content.dialog, settings: next })
  }
  const answer = (ok: boolean) => void invoke('pages.printAnswer', { dialog: content.dialog, ok })

  // The keyboard starts on Print, once there is something to print; till then on the dialog.
  useLayoutEffect(() => {
    if (ready && (document.activeElement === document.body || document.activeElement === form.current)) {
      primary.current?.focus()
    } else if (!form.current?.contains(document.activeElement)) form.current?.focus()
  }, [ready])
  // The view can get the keyboard after the dialog shows (main focuses it when the page is current).
  useEffect(() => {
    const onFocus = () => {
      if (form.current?.contains(document.activeElement) && document.activeElement !== form.current) return
      if (primary.current && !primary.current.disabled) primary.current.focus()
      else form.current?.focus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !form.current) return
    // Tab goes round the dialog's own controls.
    const controls = [...form.current.querySelectorAll<HTMLElement>('select, input, button')].filter(
      (el) => !(el as HTMLButtonElement).disabled,
    )
    if (controls.length === 0) return
    const at = controls.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey
      ? at <= 0
        ? controls.length - 1
        : at - 1
      : at < 0 || at >= controls.length - 1
        ? 0
        : at + 1
    e.preventDefault()
    controls[next]?.focus()
  }

  return (
    <form
      ref={form}
      className="page-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="page-print-title"
      tabIndex={-1}
      data-testid="print-dialog"
      data-dialog-id={content.dialog}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) answer(true)
      }}
      autoComplete="off"
    >
      <div
        className="page-print__preview"
        data-testid="print-preview"
        data-state={preview.state}
        data-pages={total ?? ''}
      >
        {pdfUrl && preview.state !== 'error' && (
          <iframe
            className={`page-print__frame${!pdfDestination && !settings.color ? ' is-gray' : ''}`}
            title="Preview"
            src={`${pdfUrl}#toolbar=0&navpanes=0`}
            tabIndex={-1}
            data-testid="print-preview-frame"
          />
        )}
        {preview.state === 'loading' && (
          <div className="page-print__status" data-testid="print-preview-loading">
            Loading preview…
          </div>
        )}
        {preview.state === 'error' && (
          <div className="page-print__status" data-testid="print-preview-error">
            {preview.message}
          </div>
        )}
      </div>
      <div className="page-print__side">
        <div className="page-print__head">
          <h2 id="page-print-title" className="page-print__title">
            Print
          </h2>
          <span className="page-print__paper" data-testid="print-paper">
            {total === undefined || problem ? '' : paperText(settings, total)}
          </span>
        </div>
        <div className="page-print__fields">
          <label className="page-print__row">
            <span>Destination</span>
            <select
              value={settings.destination}
              data-testid="print-destination"
              onChange={(e) => change({ destination: e.target.value })}
            >
              {content.destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="page-print__row">
            <span>Pages</span>
            <select
              value={settings.allPages ? 'all' : 'custom'}
              data-testid="print-pages"
              onChange={(e) => change({ allPages: e.target.value === 'all' })}
            >
              <option value="all">All</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {!settings.allPages && (
            <input
              className="page-print__field"
              value={settings.ranges}
              placeholder="e.g. 1-5, 8, 11-13"
              aria-label="Pages to print"
              aria-invalid={problem ? true : undefined}
              spellCheck={false}
              data-testid="print-ranges"
              onChange={(e) => change({ ranges: e.target.value })}
            />
          )}
          {problem && (
            <p className="page-print__problem" data-testid="print-problem">
              {problem}
            </p>
          )}
          {!pdfDestination && (
            <label className="page-print__row">
              <span>Copies</span>
              <input
                className="page-print__field is-short"
                type="number"
                min={1}
                max={999}
                value={copies}
                data-testid="print-copies"
                onChange={(e) => {
                  setCopies(e.target.value)
                  const n = Number(e.target.value)
                  if (Number.isInteger(n) && n >= 1 && n <= 999) change({ copies: n })
                }}
              />
            </label>
          )}
          <label className="page-print__row">
            <span>Layout</span>
            <select
              value={settings.landscape ? 'landscape' : 'portrait'}
              data-testid="print-layout"
              onChange={(e) => change({ landscape: e.target.value === 'landscape' })}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          {!pdfDestination && (
            <label className="page-print__row">
              <span>Color</span>
              <select
                value={settings.color ? 'color' : 'gray'}
                data-testid="print-color"
                onChange={(e) => change({ color: e.target.value === 'color' })}
              >
                <option value="color">Color</option>
                <option value="gray">Black and white</option>
              </select>
            </label>
          )}
          <div className="page-print__options" role="group" aria-label="Options">
            <label className="page-print__check">
              <input
                type="checkbox"
                checked={settings.headerFooter}
                data-testid="print-header-footer"
                onChange={(e) => change({ headerFooter: e.target.checked })}
              />
              <span>Headers and footers</span>
            </label>
            <label className="page-print__check">
              <input
                type="checkbox"
                checked={settings.background}
                data-testid="print-background"
                onChange={(e) => change({ background: e.target.checked })}
              />
              <span>Background graphics</span>
            </label>
          </div>
        </div>
        {content.error && (
          <p className="page-print__problem" data-testid="print-error">
            {content.error}
          </p>
        )}
        <div className="page-print__actions">
          <button type="button" className="page-print__button" data-testid="print-cancel" onClick={() => answer(false)}>
            Cancel
          </button>
          <button
            ref={primary}
            type="submit"
            className="page-print__button is-primary"
            disabled={!ready}
            data-testid="print-ok"
          >
            {pdfDestination ? (busy ? 'Saving…' : 'Save') : busy ? 'Printing…' : 'Print'}
          </button>
        </div>
      </div>
    </form>
  )
}
