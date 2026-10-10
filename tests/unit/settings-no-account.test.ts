import { describe, expect, it } from 'vitest'
import { ACTIONS } from '../../src/shared/actions'
import { createInitialState } from '../../src/shared/defaults'

/** OB-02: Orbit never asks for an account, e-mail or sign-in, and keeps no account. */
const ACCOUNT_WORDS = /\b(sign[ -]?(in|up|on)|log[ -]?(in|on)|account|e-?mail|password)\b/i

describe('[OB-02] no account, no sign-in', () => {
  it('has no action to sign in, sign up or manage an account', () => {
    const offending = ACTIONS.filter((a) => ACCOUNT_WORDS.test([a.title, ...(a.keywords ?? [])].join(' ')))
    expect(offending.map((a) => a.id)).toEqual([])
  })

  it('keeps no account, user or token in its state', () => {
    const keys = new Set<string>()
    const walk = (value: unknown) => {
      if (typeof value !== 'object' || value === null) return
      for (const [key, child] of Object.entries(value)) {
        keys.add(key)
        walk(child)
      }
    }
    walk(createInitialState(0))
    expect([...keys].filter((k) => /account|user|email|token|login|signin|password/i.test(k))).toEqual([])
  })
})
