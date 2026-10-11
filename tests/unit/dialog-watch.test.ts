import type { BrowserWindow } from 'electron'
import { describe, expect, it } from 'vitest'
import { onDialogsChanged, windowsWithDialogs, withDialog } from '../../src/main/media/dialog-watch'

/** Just what dialog-watch asks of a window. */
function fakeWindow(): BrowserWindow & { destroyed: boolean } {
  const win = { destroyed: false, isDestroyed: () => win.destroyed }
  return win as unknown as BrowserWindow & { destroyed: boolean }
}

describe('file pickers Orbit opens over its windows (MD-06)', () => {
  it('[MD-06] a window shows a dialog until the last one over it answers, or fails', async () => {
    const win = fakeWindow()
    let changes = 0
    const off = onDialogsChanged(() => changes++)
    let answer: (path: string) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const first = withDialog(
      win,
      new Promise<string>((resolve) => {
        answer = resolve
      }),
    )
    const second = withDialog(
      win,
      new Promise<string>((_resolve, reject) => {
        fail = reject
      }),
    )
    expect(windowsWithDialogs()).toEqual([win])
    answer('/tmp/a.txt')
    expect(await first).toBe('/tmp/a.txt')
    expect(windowsWithDialogs()).toEqual([win])
    fail(new Error('gone'))
    await expect(second).rejects.toThrow('gone')
    expect(windowsWithDialogs()).toEqual([])
    expect(changes).toBe(4)
    off()
  })

  it('[MD-06] a closed window is never listed, and no window means nothing to note', async () => {
    const win = fakeWindow()
    const shown = withDialog(win, new Promise<void>(() => {}))
    expect(windowsWithDialogs()).toEqual([win])
    win.destroyed = true
    expect(windowsWithDialogs()).toEqual([])
    void shown
    const nobody = withDialog(undefined, Promise.resolve(1))
    expect(await nobody).toBe(1)
    const gone = fakeWindow()
    gone.destroyed = true
    await withDialog(gone, Promise.resolve(2))
    expect(windowsWithDialogs()).toEqual([])
  })
})
