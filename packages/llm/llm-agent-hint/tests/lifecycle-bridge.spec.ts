import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { SessionControlVerb } from '../src/types.ts'

const SID = SessionId('session-1')
const PARENT = SessionId('parent-1')

/** Minimal session shape the bridge reads: identity, seed marker, lineage. */
function sessionOf(overrides: {
  id?: ReturnType<typeof SessionId>
  firstLiveSeq?: number
  parentSession?: ReturnType<typeof SessionId>
} = {}): Session {
  return {
    id: overrides.id ?? SID,
    firstLiveSeq: overrides.firstLiveSeq ?? 0,
    header: { parentSession: overrides.parentSession },
  } as unknown as Session
}

function compactionEnd(error?: string): SessionEvent {
  return {
    type: 'compaction/end',
    data: { compactionId: 'c-1' as never, turn: 1, ...error === undefined ? {} : { error } },
  } as unknown as SessionEvent
}

interface RecordedCall {
  verb: SessionControlVerb
  sessionId: string
  model: string | undefined
}

function makeBridge(): { bridge: LifecycleBridge; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    send: (verb: SessionControlVerb, sessionId: string, model?: string) => {
      calls.push({ verb, sessionId, model })
      return Promise.resolve()
    },
  } as unknown as SessionControlClient
  return { bridge: new LifecycleBridge({ client, pendingOpAwaitMs: 50 }), calls }
}

describe('LifecycleBridge', () => {
  it('requests a resume prefetch for a seeded session on creation', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ firstLiveSeq: 5 }))
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: undefined }])
  })

  it('keeps fork lineage visible to the data plane', () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf({ firstLiveSeq: 5, parentSession: PARENT }))
    expect(bridge.facts(SID)).toEqual({
      seeded: true,
      firstOrdinarySent: false,
      parentSessionId: PARENT,
    })
  })

  it('does nothing on a fresh (unseeded) session creation', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    expect(calls).toEqual([])
    expect(bridge.facts(SID)).toMatchObject({ seeded: false })
  })

  it('requests a compact after a successful compaction', () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'deepseek-v4-flash')
    bridge.onSessionEvent(sessionOf(), compactionEnd())
    expect(calls).toEqual([{ verb: 'compact', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
  })

  it('skips the compact when compaction failed', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionEvent(sessionOf(), compactionEnd('boom'))
    expect(calls).toEqual([])
  })

  it('requests a terminal stop on disposal and drops the state', async () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'deepseek-v4-flash')
    bridge.onSessionDisposed(sessionOf())
    // Disposal is fire-and-forget; the send itself is synchronous bookkeeping.
    expect(calls).toEqual([{ verb: 'stop', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
    await new Promise(resolve => setImmediate(resolve))
    expect(bridge.facts(SID)).toEqual({
      seeded: false,
      firstOrdinarySent: false,
      parentSessionId: undefined,
    })
  })

  it('flips firstOrdinarySent so start is declared once per session', () => {
    const { bridge } = makeBridge()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
    bridge.noteOrdinaryRequest(SID, 'm')
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)
  })

  it('awaits an in-flight manage verb before resolving the barrier', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = {
      send: () => gate,
    } as unknown as SessionControlClient
    const bridge = new LifecycleBridge({ client, pendingOpAwaitMs: 1_000 })
    bridge.onSessionCreated(sessionOf({ firstLiveSeq: 3 }))

    let barrierSettled = false
    const barrier = bridge.awaitPendingOp(SID).then(() => { barrierSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(barrierSettled).toBe(false)
    release?.()
    await barrier
    expect(barrierSettled).toBe(true)
  })

  it('fails open when the barrier cap expires first', async () => {
    const gate = new Promise<void>(() => {})
    const client = { send: () => gate } as unknown as SessionControlClient
    const bridge = new LifecycleBridge({ client, pendingOpAwaitMs: 10 })
    bridge.onSessionCreated(sessionOf({ firstLiveSeq: 3 }))
    await expect(bridge.awaitPendingOp(SID)).resolves.toBeUndefined()
  })

  it('returns unknown-session facts for anonymous requests', () => {
    const { bridge } = makeBridge()
    expect(bridge.facts(undefined)).toEqual({
      seeded: false,
      firstOrdinarySent: false,
      parentSessionId: undefined,
    })
  })
})
