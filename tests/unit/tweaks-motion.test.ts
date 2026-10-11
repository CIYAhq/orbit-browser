import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const TWEAKS = resolve(__dirname, '../../src/renderer/src/tweaks')

/** Each `animation` and `transition` value in the Tweak surfaces' stylesheets, with its file. */
function motionValues(): { file: string; value: string }[] {
  const out: { file: string; value: string }[] = []
  for (const file of readdirSync(TWEAKS).filter((f) => f.endsWith('.css'))) {
    const css = readFileSync(join(TWEAKS, file), 'utf8')
    for (const m of css.matchAll(/\b(?:animation|transition)(?:-duration)?\s*:\s*([^;]+);/g)) {
      out.push({ file, value: (m[1] as string).trim() })
    }
  }
  return out
}

describe('[FL-01] the Tweak surfaces move on the motion tokens (tweaks review F6)', () => {
  it('time every animation and transition with a token, never a number of their own', () => {
    const values = motionValues()
    expect(values.length).toBeGreaterThan(0)
    for (const { file, value } of values) {
      if (value === 'none') continue
      expect(value, `${file}: ${value}`).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/)
      expect(value, `${file}: ${value}`).toMatch(/var\(--(?:motion|dur)[\w-]*\)/)
    }
  })

  it('open the panel and its menus on the snappy token, as FL-01 gives menus', () => {
    const values = motionValues()
    for (const name of ['tweak-panel-in', 'tweak-menu-in']) {
      expect(values.find((v) => v.value.startsWith(`${name} `))?.value).toBe(
        `${name} var(--motion-snappy) var(--ease-snappy)`,
      )
    }
  })
})
