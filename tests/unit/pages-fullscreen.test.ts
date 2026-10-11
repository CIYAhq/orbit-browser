import { describe, expect, it } from 'vitest'
import { type EscapeMemory, escapeInFullScreen } from '../../src/main/pages/fullscreen'
import type { ShortcutPriority } from '../../src/shared/commands/keys'

/** Presses in order through the rule, as one page gets them; returns each verdict. */
function presses(
  list: { type?: 'down' | 'up'; repeat?: boolean; at: number; fullScreen?: boolean }[],
  priority: ShortcutPriority = 'websites',
  start: EscapeMemory = {},
) {
  let memory = start
  return list.map((p) => {
    const next = escapeInFullScreen(
      memory,
      { type: p.type ?? 'down', repeat: p.repeat ?? false, now: p.at, fullScreen: p.fullScreen ?? true },
      priority,
    )
    memory = next.memory
    return next.verdict
  })
}

/** A press and its release at `at`. */
const tap = (at: number, fullScreen = true) => [
  { at, fullScreen },
  { type: 'up' as const, at: at + 50, fullScreen },
]

describe('[NV-20][KS-02] Esc in a page of a window in full screen', () => {
  it('prefers websites: the page gets one press, and full screen stays', () => {
    expect(presses(tap(0))).toEqual(['page', 'page'])
  })

  it('a second press within about a second leaves, and the page gets neither it nor its release', () => {
    expect(presses([...tap(0), ...tap(900)])).toEqual(['page', 'page', 'exit', 'swallow'])
    expect(presses([...tap(0), ...tap(1_000)])).toEqual(['page', 'page', 'exit', 'swallow'])
  })

  it('presses more than a second apart each go to the page', () => {
    expect(presses([...tap(0), ...tap(1_100), ...tap(2_300)])).toEqual(['page', 'page', 'page', 'page', 'page', 'page'])
  })

  it('a held press leaves at its first repeat: the page keeps the press and its release, not the repeats', () => {
    expect(
      presses([
        { at: 0 },
        { at: 500, repeat: true },
        { at: 530, repeat: true },
        { at: 560, repeat: true },
        { type: 'up', at: 600 },
      ]),
    ).toEqual(['page', 'exit', 'swallow', 'swallow', 'page'])
  })

  it('prefers Orbit when set so: one press leaves, and the page gets nothing of it', () => {
    expect(
      presses([{ at: 0 }, { at: 500, repeat: true }, { at: 530, repeat: true }, { type: 'up', at: 600 }], 'orbit'),
    ).toEqual(['exit', 'swallow', 'swallow', 'swallow'])
  })

  it('once full screen has ended, Esc is the page’s alone', () => {
    // Left by the second press; the next ones, out of full screen, all go to the page.
    expect(
      presses([
        ...tap(0),
        ...tap(300),
        ...tap(600, false),
        ...tap(700, false),
        { at: 800, fullScreen: false },
        { at: 830, repeat: true, fullScreen: false },
      ]),
    ).toEqual(['page', 'page', 'exit', 'swallow', 'page', 'page', 'page', 'page', 'page', 'page'])
  })

  it('a press the page didn’t get (the engine took it to end a video’s full screen) is no first press, and its repeats leave nothing', () => {
    // Only its release and repeats are seen; then a quick press goes to the page.
    expect(presses([{ at: 0, repeat: true }, { type: 'up', at: 50 }, ...tap(200)])).toEqual([
      'page',
      'page',
      'page',
      'page',
    ])
  })

  it('a press out of full screen is no first press for one in it', () => {
    expect(presses([...tap(0, false), ...tap(300)])).toEqual(['page', 'page', 'page', 'page'])
  })
})
