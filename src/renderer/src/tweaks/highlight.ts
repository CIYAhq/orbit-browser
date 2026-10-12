/**
 * Syntax colouring for the Tweak code editor (BO-11): a small tokenizer for CSS and one for
 * JavaScript. Tokens are plain text that the editor renders as text (never as HTML), so code from
 * anywhere, an imported Tweak's included, can only ever show as itself.
 */

export type CodeLanguage = 'css' | 'js'

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'atrule'
  | 'selector'
  | 'property'
  | 'value'
  | 'color'
  | 'important'
  | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

/** Tokens of `code`, in order; joined, their text is `code` again. */
export function highlight(code: string, language: CodeLanguage): Token[] {
  return language === 'css' ? cssTokens(code) : jsTokens(code)
}

/** Appends a token, merging it into the last one when they are of the same kind. */
function push(out: Token[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

/** Where a quoted string from `i` ends (past its closing quote, or at a line break or the end). */
function quotedEnd(code: string, i: number, stopAtLine: boolean): number {
  const quote = code[i]
  let j = i + 1
  while (j < code.length) {
    const c = code[j]
    if (c === '\\') j += 2
    else if (c === quote) return j + 1
    else if (stopAtLine && c === '\n') return j
    else j++
  }
  return code.length
}

function blockCommentEnd(code: string, i: number): number {
  const stop = code.indexOf('*/', i + 2)
  return stop < 0 ? code.length : stop + 2
}

// ---- CSS ----

/** In a declaration block: before a `:` is a property, after it a value. */
type CssPlace = 'rules' | 'property' | 'value'

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([a-z%]+)?/i
const HEX_COLOR = /^#[\da-f]{3,8}\b/i

function cssTokens(code: string): Token[] {
  const out: Token[] = []
  /** For each open block: whether it holds declarations (a style rule) or rules (`@media`…). */
  const blocks: boolean[] = []
  let place: CssPlace = 'rules'
  let prelude = ''
  let i = 0
  while (i < code.length) {
    const c = code[i] as string
    const rest = code.slice(i, i + 40)
    if (c === '/' && code[i + 1] === '*') {
      const end = blockCommentEnd(code, i)
      push(out, 'comment', code.slice(i, end))
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      const end = quotedEnd(code, i, true)
      push(out, 'string', code.slice(i, end))
      if (place === 'rules') prelude += code.slice(i, end)
      i = end
      continue
    }
    if (c === '{') {
      const declarations = !/^\s*@(?!page\b|font-face\b)/i.test(prelude)
      blocks.push(declarations)
      place = declarations ? 'property' : 'rules'
      prelude = ''
      push(out, 'punct', c)
      i++
      continue
    }
    if (c === '}') {
      blocks.pop()
      const inside = blocks[blocks.length - 1]
      place = inside ? 'property' : 'rules'
      prelude = ''
      push(out, 'punct', c)
      i++
      continue
    }
    if (place === 'rules') {
      if (c === '@') {
        const name = /^@[\w-]+/.exec(rest)?.[0] ?? '@'
        push(out, 'atrule', name)
        prelude += name
        i += name.length
        continue
      }
      if (c === ';') {
        prelude = ''
        push(out, 'punct', c)
        i++
        continue
      }
      prelude += c
      push(out, /\s/.test(c) ? 'plain' : prelude.trimStart().startsWith('@') ? 'value' : 'selector', c)
      i++
      continue
    }
    if (place === 'property') {
      if (c === ':') {
        place = 'value'
        push(out, 'punct', c)
        i++
        continue
      }
      if (c === ';') {
        push(out, 'punct', c)
        i++
        continue
      }
      push(out, /\s/.test(c) ? 'plain' : 'property', c)
      i++
      continue
    }
    // A value.
    if (c === ';') {
      place = 'property'
      push(out, 'punct', c)
      i++
      continue
    }
    if (c === '!') {
      const important = /^!\s*important\b/i.exec(rest)?.[0]
      if (important) {
        push(out, 'important', important)
        i += important.length
        continue
      }
    }
    if (c === '#') {
      const hex = HEX_COLOR.exec(rest)?.[0]
      if (hex) {
        push(out, 'color', hex)
        i += hex.length
        continue
      }
    }
    if (/[\d.-]/.test(c) && !/[\w-]/.test(code[i - 1] ?? ' ')) {
      const num = NUMBER.exec(rest)?.[0]
      if (num) {
        push(out, 'number', num)
        i += num.length
        continue
      }
    }
    push(out, /\s/.test(c) ? 'plain' : /[(),/]/.test(c) ? 'punct' : 'value', c)
    i++
  }
  return out
}

// ---- JavaScript ----

const JS_KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'new',
  'null',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

function jsTokens(code: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < code.length) {
    const c = code[i] as string
    if (c === '/' && code[i + 1] === '/') {
      const stop = code.indexOf('\n', i)
      const end = stop < 0 ? code.length : stop
      push(out, 'comment', code.slice(i, end))
      i = end
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = blockCommentEnd(code, i)
      push(out, 'comment', code.slice(i, end))
      i = end
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const end = quotedEnd(code, i, c !== '`')
      push(out, 'string', code.slice(i, end))
      i = end
      continue
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(code[i + 1] ?? ''))) {
      const num =
        /^(0[xob][\da-f_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(e[+-]?\d+)?)n?/i.exec(code.slice(i, i + 40))?.[0] ?? c
      push(out, 'number', num)
      i += num.length
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const word = /^[\w$]+/.exec(code.slice(i, i + 80))?.[0] ?? c
      // A property name after a dot is never a keyword (`el.default`).
      const afterDot = /\.\s*$/.test(code.slice(Math.max(0, i - 4), i))
      push(out, !afterDot && JS_KEYWORDS.has(word) ? 'keyword' : 'plain', word)
      i += word.length
      continue
    }
    push(out, /[{}()[\];,.=<>!+\-*/%&|^~?:]/.test(c) ? 'punct' : 'plain', c)
    i++
  }
  return out
}
