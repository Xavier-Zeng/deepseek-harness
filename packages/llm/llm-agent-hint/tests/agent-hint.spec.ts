import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildAgentHint } from '../src/agent-hint.ts'
import { Config } from '../src/index.ts'

const SID = SessionId('session-1')

describe('buildAgentHint', () => {
  it('returns undefined for background-purpose calls', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: 'compaction',
      seeded: false,
      firstOrdinarySent: false,
    })).toBeUndefined()
  })

  it('returns undefined for anonymous requests', () => {
    expect(buildAgentHint({
      sessionId: undefined,
      purpose: undefined,
      seeded: false,
      firstOrdinarySent: false,
    })).toBeUndefined()
  })

  it('declares start on the first ordinary request of a fresh session', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: undefined,
      seeded: false,
      firstOrdinarySent: false,
    })).toEqual({ session_id: 'session-1', session_control: { type: 'start' } })
  })

  it('omits the verb once an ordinary request already declared start', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: undefined,
      seeded: false,
      firstOrdinarySent: true,
    })).toEqual({ session_id: 'session-1' })
  })

  it('never re-declares start for a seeded (resume/fork) session', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: undefined,
      seeded: true,
      firstOrdinarySent: false,
    })).toEqual({ session_id: 'session-1' })
  })

  it('attaches fork lineage and cache policy verbatim', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: undefined,
      parentSessionId: SessionId('parent-1'),
      cacheControl: { type: 'kv', ttl: 300 },
      seeded: true,
      firstOrdinarySent: true,
    })).toEqual({
      session_id: 'session-1',
      parent_session_id: 'parent-1',
      cache_control: { type: 'kv', ttl: 300 },
    })
  })

  it('keeps an explicit piggyback verb ahead of the start rule', () => {
    expect(buildAgentHint({
      sessionId: SID,
      purpose: undefined,
      sessionControl: 'pause',
      seeded: false,
      firstOrdinarySent: false,
    })).toEqual({ session_id: 'session-1', session_control: { type: 'pause' } })
  })
})

describe('Config schema agentHint.cacheControl', () => {
  it('resolves with cacheControl absent entirely (no cascade to {})', () => {
    const resolved = Config({})
    expect(resolved.agentHint).toBeDefined()
    expect('cacheControl' in (resolved.agentHint ?? {})).toBe(false)
  })

  it('keeps cacheControl absent when agentHint carries only other keys', () => {
    const resolved = Config({ agentHint: { enabled: true } })
    expect('cacheControl' in (resolved.agentHint ?? {})).toBe(false)
  })

  it('preserves a provided cacheControl with extra fields verbatim', () => {
    const resolved = Config({ agentHint: { cacheControl: { type: 'kv', ttl: 300 } } })
    expect(resolved.agentHint?.cacheControl).toEqual({ type: 'kv', ttl: 300 })
  })

  it('rejects a provided cacheControl that names no type', () => {
    // Type-cast: the static type already forbids this; the schema must too.
    expect(() => Config({ agentHint: { cacheControl: {} } } as never)).toThrow(/cacheControl\.type/)
  })
})
