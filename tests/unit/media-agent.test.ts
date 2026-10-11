import { describe, expect, it } from 'vitest'
import { AGENT_SOURCE, frameAgentSource } from '../../src/main/media/agent'

describe("media's page script (MD-01, MD-09)", () => {
  it('[MD-01] the page and frame versions are valid scripts', () => {
    for (const source of [AGENT_SOURCE, frameAgentSource('_a1b2'), frameAgentSource('_a1b2', true)]) {
      expect(() => new Function(`return ${source}`)).not.toThrow()
    }
  })

  it("[MD-01] a frame's script hides on the property it is given, and only where the frame has media unless asked", () => {
    expect(frameAgentSource('_a1b2')).toContain(`Object.defineProperty(w, "_a1b2"`)
    expect(frameAgentSource('_a1b2')).toContain("document.querySelector('video, audio') ?")
    expect(frameAgentSource('_a1b2', true)).not.toContain("document.querySelector('video, audio') ?")
    expect(AGENT_SOURCE).toContain('w.__orbitMedia = api')
  })

  it('[MD-09] its regular expressions survive the template: artwork is chosen from web and data: images', () => {
    expect(AGENT_SOURCE).toContain(String.raw`/^(https?:|data:image\/)/`)
    expect(AGENT_SOURCE).toContain(String.raw`split(/\s+/)`)
  })
})
