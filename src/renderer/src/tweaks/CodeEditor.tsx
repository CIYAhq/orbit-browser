import { type KeyboardEvent, useLayoutEffect, useMemo, useRef } from 'react'
import { type CodeLanguage, highlight } from './highlight'

/** One level of indentation. */
const INDENT = '  '
/** Past this many characters code shows without colours: colouring it on each key would slow typing. */
const COLOUR_LIMIT = 30_000

interface Props {
  value: string
  onChange: (value: string) => void
  language: CodeLanguage
  label: string
  testId: string
  placeholder?: string
  maxLength?: number
}

/**
 * A small code editor (BO-11): a plain text field over a coloured copy of its text, with line
 * numbers beside. The field does the editing, so selection, the clipboard, IME input and ⌘Z / Ctrl+Z
 * are the platform's own; Tab and ⇧Tab indent and outdent, Enter keeps the line's indentation.
 * The coloured copy is text only, never markup.
 */
export function CodeEditor({ value, onChange, language, label, testId, placeholder, maxLength }: Props) {
  const input = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const tokens = useMemo(() => (value.length <= COLOUR_LIMIT ? highlight(value, language) : null), [value, language])
  const numbers = useMemo(() => {
    let lines = 1
    for (let i = value.indexOf('\n'); i >= 0; i = value.indexOf('\n', i + 1)) lines++
    return Array.from({ length: lines }, (_, i) => i + 1).join('\n')
  }, [value])

  /** The coloured copy and the line numbers follow the field's scrolling. */
  const follow = () => {
    const el = input.current
    if (!el) return
    if (layer.current) layer.current.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    if (gutter.current) gutter.current.style.transform = `translateY(${-el.scrollTop}px)`
  }
  // Each change of the text may scroll the field.
  useLayoutEffect(follow)

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Tab') {
      e.preventDefault()
      indent(e.currentTarget, e.shiftKey)
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      newLine(e.currentTarget)
    }
  }

  return (
    <div className="code-editor" data-testid={testId}>
      <div className="code-editor__gutter" aria-hidden>
        <div ref={gutter} className="code-editor__numbers">
          {numbers}
        </div>
      </div>
      <div className="code-editor__main">
        {tokens && (
          <pre ref={layer} className="code-editor__layer" aria-hidden>
            {tokens.map((t, i) =>
              t.kind === 'plain' ? (
                t.text
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity but their place
                <span key={i} className={`tok-${t.kind}`}>
                  {t.text}
                </span>
              ),
            )}
            {'\n'}
          </pre>
        )}
        <textarea
          ref={input}
          className={`code-editor__input${tokens ? ' is-coloured' : ''}`}
          data-testid={`${testId}-input`}
          aria-label={label}
          placeholder={placeholder}
          maxLength={maxLength}
          value={value}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          onChange={(e) => onChange(e.currentTarget.value)}
          onScroll={follow}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}

/** Replaces the selection with `text` as typing would: the field's own undo takes it back. */
function insert(el: HTMLTextAreaElement, text: string): void {
  const done = text ? document.execCommand('insertText', false, text) : document.execCommand('delete')
  if (done) return
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Tab: indents at the caret, or every line of a selection; ⇧Tab outdents the lines. */
function indent(el: HTMLTextAreaElement, outdent: boolean): void {
  const { value, selectionStart: start, selectionEnd: end } = el
  if (!outdent && start === end) {
    insert(el, INDENT)
    return
  }
  const first = value.lastIndexOf('\n', start - 1) + 1
  // A selection that ends at the start of a line leaves that line alone.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end
  const stop = value.indexOf('\n', last)
  const lineEnd = stop < 0 ? value.length : stop
  const block = value.slice(first, lineEnd)
  const lines = block.split('\n')
  const changed = lines.map((line) => (outdent ? line.replace(/^( {1,2}|\t)/, '') : line && INDENT + line))
  const next = changed.join('\n')
  if (next === block) return
  el.setSelectionRange(first, lineEnd)
  insert(el, next)
  if (start === end) {
    const removed = (lines[0]?.length ?? 0) - (changed[0]?.length ?? 0)
    const caret = Math.max(first, start - removed)
    el.setSelectionRange(caret, caret)
  } else {
    el.setSelectionRange(first, first + next.length)
  }
}

/** Enter: a new line indented as this one, one level more after an opening bracket. */
function newLine(el: HTMLTextAreaElement): void {
  const { value, selectionStart: start, selectionEnd: end } = el
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const before = value.slice(lineStart, start)
  const lead = /^[ \t]*/.exec(before)?.[0] ?? ''
  const opens = /[{([]\s*$/.test(before)
  if (opens && /^[ \t]*[})\]]/.test(value.slice(end))) {
    // Between brackets: the closing one goes to a line of its own.
    insert(el, `\n${lead}${INDENT}\n${lead}`)
    const caret = start + 1 + lead.length + INDENT.length
    el.setSelectionRange(caret, caret)
    return
  }
  insert(el, `\n${lead}${opens ? INDENT : ''}`)
}
