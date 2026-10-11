import { Play, RotateCw, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TweakEditorState } from '../../../shared/commands/tweaks'
import type { Tweak } from '../../../shared/state'
import { TWEAK_LIMITS } from '../../../shared/tweaks'
import { invoke } from '../api'
import { CodeEditor } from './CodeEditor'
import { flushTweakEdits, holdEdits, updateTweak } from './edit'
import type { CodeLanguage } from './highlight'

/** How long typing pauses before the code is sent: CSS shows in the page well within 0.3 s (BO-11). */
const SEND_AFTER_MS = 80

/**
 * The text of one of a Tweak's code fields as typed. Edits go to main a moment after typing
 * pauses; meanwhile, and until main has them, the field keeps what was typed. A change from
 * elsewhere (a reset, the same Tweak in another window) shows once nothing is waiting.
 */
function useCode(id: string, field: 'css' | 'js', saved: string): [string, (value: string) => void] {
  const [text, setText] = useState(saved)
  const latest = useRef(saved)
  const timer = useRef<number | undefined>(undefined)
  const sending = useRef(0)

  const flush = useCallback(() => {
    if (timer.current === undefined) return
    window.clearTimeout(timer.current)
    timer.current = undefined
    sending.current++
    void invoke('tweaks.update', { id, patch: { [field]: latest.current } }).finally(() => {
      sending.current--
    })
  }, [id, field])

  // Sent before the panel closes or runs the code, and as the panel goes.
  useEffect(() => {
    const release = holdEdits(flush)
    return () => {
      release()
      flush()
    }
  }, [flush])

  useEffect(() => {
    if (timer.current !== undefined || sending.current > 0 || saved === latest.current) return
    latest.current = saved
    setText(saved)
  }, [saved])

  const change = (value: string) => {
    latest.current = value
    setText(value)
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, SEND_AFTER_MS)
  }
  return [text, change]
}

/**
 * The code area (BO-11): the Tweak's own CSS, which applies as it is typed, and its JavaScript,
 * which runs in the page each time a page of the site loads, where allowed on this device (BO-17,
 * BO-18). "Run now" tries it at once; "Reload page" loads the page again.
 */
export function CodeArea({ tweak, state }: { tweak: Tweak; state: TweakEditorState }) {
  const [language, setLanguage] = useState<CodeLanguage>(() => (tweak.js.trim() && !tweak.css.trim() ? 'js' : 'css'))
  const [css, setCss] = useCode(tweak.id, 'css', tweak.css)
  const [js, setJs] = useCode(tweak.id, 'js', tweak.js)
  const hasJs = !!js.trim()
  const blockedHere = state.private && !tweak.jsInPrivate
  const runs = hasJs && tweak.jsAllowed && !blockedHere

  const runNow = () => {
    flushTweakEdits()
    if (state.tabId) void invoke('tweaks.runNow', { id: tweak.id, tabId: state.tabId })
  }
  const reload = () => {
    flushTweakEdits()
    if (state.tabId) void invoke('tabs.reload', { tabId: state.tabId })
  }

  return (
    <div className="tweak-code" data-testid="tweak-code">
      <div className="tweak-code__tabs" role="tablist" aria-label="Code">
        {(['css', 'js'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="tweak-code__tab"
            data-testid={`tweak-code-${id}-tab`}
            aria-selected={language === id}
            onClick={() => setLanguage(id)}
          >
            {id === 'css' ? 'CSS' : 'JavaScript'}
            {id === 'js' && hasJs && (
              <span className="tweak-code__badge" data-testid="tweak-js-badge" title="This Tweak runs JavaScript">
                JS
              </span>
            )}
          </button>
        ))}
      </div>
      {language === 'css' ? (
        <CodeEditor
          key="css"
          testId="tweak-css"
          label="CSS"
          language="css"
          value={css}
          onChange={setCss}
          maxLength={TWEAK_LIMITS.code}
          placeholder={'body {\n  background: #fdf6e3;\n}'}
        />
      ) : (
        <>
          <CodeEditor
            key="js"
            testId="tweak-js"
            label="JavaScript"
            language="js"
            value={js}
            onChange={setJs}
            maxLength={TWEAK_LIMITS.code}
            placeholder="// Runs each time a page of this site loads"
          />
          {hasJs && !tweak.jsAllowed && (
            <div className="tweak-code__notice" role="status" data-testid="tweak-js-blocked">
              <ShieldAlert size={14} aria-hidden />
              <span>This JavaScript came from elsewhere. It doesn't run until you allow it on this device.</span>
              <button
                type="button"
                className="tweak-button"
                data-testid="tweak-js-allow"
                onClick={() => updateTweak(tweak.id, { jsAllowed: true })}
              >
                Allow
              </button>
            </div>
          )}
          <div className="tweak-code__bar">
            <button
              type="button"
              className="tweak-button"
              data-testid="tweak-js-run"
              disabled={!runs}
              title={blockedHere ? 'Not allowed in private windows' : 'Run the JavaScript in the page now'}
              onClick={runNow}
            >
              <Play size={12} aria-hidden />
              Run now
            </button>
            <button type="button" className="tweak-button" data-testid="tweak-js-reload" onClick={reload}>
              <RotateCw size={12} aria-hidden />
              Reload page
            </button>
          </div>
          <label className="tweak-check" title="Private windows keep nothing; a script there still sees the page">
            <input
              type="checkbox"
              data-testid="tweak-js-private"
              checked={tweak.jsInPrivate}
              onChange={(e) => updateTweak(tweak.id, { jsInPrivate: e.currentTarget.checked })}
            />
            <span>Also run in private windows</span>
          </label>
        </>
      )}
    </div>
  )
}
