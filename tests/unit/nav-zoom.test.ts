import { describe, expect, it } from 'vitest'
import { findTextFromSelection, sameZoom, ZOOM_STEPS, zoomPercent, zoomStep } from '../../src/shared/nav'

describe('page zoom steps (NV-06)', () => {
  it('lists Chromium’s steps from 25% to 500%', () => {
    expect(ZOOM_STEPS.map(zoomPercent)).toEqual([
      25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
    ])
  })

  it('steps in and out from 100%', () => {
    expect(zoomStep(1, 1)).toBe(1.1)
    expect(zoomStep(1.1, 1)).toBe(1.25)
    expect(zoomStep(1, -1)).toBe(0.9)
    expect(zoomStep(0.9, -1)).toBe(0.8)
  })

  it('stays put at either end', () => {
    expect(zoomStep(5, 1)).toBe(5)
    expect(zoomStep(0.25, -1)).toBe(0.25)
  })

  it('snaps a factor between steps to the next one in that direction', () => {
    expect(zoomStep(1.2, 1)).toBe(1.25)
    expect(zoomStep(1.2, -1)).toBe(1.1)
    // A factor read back through Chromium's zoom levels is a hair off the step.
    expect(zoomStep(1.25 + 1e-9, 1)).toBe(1.5)
    expect(zoomStep(1.25 - 1e-9, -1)).toBe(1.1)
  })

  it('compares factors with a little slack', () => {
    expect(sameZoom(1.1, 1.1000000001)).toBe(true)
    expect(sameZoom(1.1, 1.25)).toBe(false)
  })
})

describe('find text from a selection (NV-05)', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(findTextFromSelection('  orbit  ')).toBe('orbit')
    expect(findTextFromSelection('\n\n  first line \nsecond')).toBe('first line')
    expect(findTextFromSelection('')).toBe('')
  })

  it('caps long selections', () => {
    expect(findTextFromSelection('x'.repeat(500))).toHaveLength(200)
  })
})
