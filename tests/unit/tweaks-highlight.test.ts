import { describe, expect, it } from 'vitest'
import { highlight, type Token } from '../../src/renderer/src/tweaks/highlight'

/** The tokens of one kind, as text. */
const of = (tokens: Token[], kind: Token['kind']) => tokens.filter((t) => t.kind === kind).map((t) => t.text)

describe('[BO-11] the code editor colours code as text', () => {
  const samples = [
    'body { background: #202020 !important; margin: 0 4px }',
    '@media (max-width: 600px) {\n  a:hover, .x > b { color: red }\n}\n/* note',
    'a[title="x}"] { content: "{" }',
    'const n = 0x1f + .5e3; // two\nlet s = `a {b}` + "c\\"d"\n/* open',
    '',
  ]

  it('keeps the code exactly: its tokens, joined, are the code again', () => {
    for (const code of samples) {
      for (const language of ['css', 'js'] as const) {
        expect(
          highlight(code, language)
            .map((t) => t.text)
            .join(''),
        ).toBe(code)
      }
    }
  })

  it('tells CSS selectors, properties, values, colours, numbers and at-rules apart', () => {
    const tokens = highlight(samples[0] as string, 'css')
    expect(of(tokens, 'selector')).toEqual(['body'])
    expect(of(tokens, 'property')).toEqual(['background', 'margin'])
    expect(of(tokens, 'color')).toEqual(['#202020'])
    expect(of(tokens, 'important')).toEqual(['!important'])
    expect(of(tokens, 'number')).toEqual(['0', '4px'])
    const media = highlight(samples[1] as string, 'css')
    expect(of(media, 'atrule')).toEqual(['@media'])
    expect(of(media, 'property')).toEqual(['color'])
    expect(of(media, 'comment')).toEqual(['/* note'])
    // A brace inside a string opens nothing.
    expect(of(highlight(samples[2] as string, 'css'), 'property')).toEqual(['content'])
  })

  it('tells JavaScript keywords, strings, numbers and comments apart; a property is never a keyword', () => {
    const tokens = highlight(samples[3] as string, 'js')
    expect(of(tokens, 'keyword')).toEqual(['const', 'let'])
    expect(of(tokens, 'number')).toEqual(['0x1f', '.5e3'])
    expect(of(tokens, 'comment')).toEqual(['// two', '/* open'])
    expect(of(tokens, 'string')).toEqual(['`a {b}`', '"c\\"d"'])
    expect(of(highlight('el.default = new X()', 'js'), 'keyword')).toEqual(['new'])
  })
})
