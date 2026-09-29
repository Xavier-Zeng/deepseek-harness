import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  DeepSeekLlmApiExtensionRequest,
  PreparedDeepSeekLlmApiExtensions,
} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { agentHintPrepareExtensions } from '../src/extension.ts'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { SessionControlVerb } from '../src/types.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap {
    agent_hint_test_field: { value: string }
  }
}

const SID = SessionId('session-1')

const emptyChain = (): Promise<PreparedDeepSeekLlmApiExtensions> =>
  Promise.resolve({ fields: {}, accept: () => Promise.resolve() })

function request(overrides: {
  sessionId?: string | undefined
  purpose?: DeepSeekLlmApiExtensionRequest['purpose']
} = {}): DeepSeekLlmApiExtensionRequest {
  const sessionId = 'sessionId' in overrides ? overrides.sessionId : 'session-1'
  return {
    body: { model: 'model-a', messages: [] },
    signal: AbortSignal.timeout(5_000),
    ...sessionId === undefined ? {} : { sessionId },
    ...overrides.purpose === undefined ? {} : { purpose: overrides.purpose },
  }
}

function sessionOf(overrides: { seeded?: boolean } = {}): Session {
  const stub: Pick<Session, 'id' | 'header' | 'surface'> = {
    id: SID,
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SID,
      createdAt: 1,
      isSeeded: overrides.seeded === true,
    },
    surface: {
      nodes: overrides.seeded === true ? [SessionSeq(0)] : [],
      replaceGeneration: 0,
      contentGeneration: 0,
    },
  }
  return stub as Session
}

interface RecordedCall {
  verb: SessionControlVerb
  sessionId: string
  model: string | undefined
}

function makeBridge(gate?: Promise<void>, pendingOpAwaitMs = 50): { bridge: LifecycleBridge; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    send: (verb: SessionControlVerb, sessionId: string, model?: string) => {
      calls.push({ verb, sessionId, model })
      return gate ?? Promise.resolve()
    },
  } as SessionControlClient
  return { bridge: new LifecycleBridge({ client, pendingOpAwaitMs }), calls }
}

describe('agentHintPrepareExtensions', () => {
  it('injects start on the first ordinary request of a fresh session and notes it only on accept', async () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    const prepare = agentHintPrepareExtensions({ chained: emptyChain, bridge })

    const prepared = await prepare(request())
    expect(prepared.fields['agent_hint']).toEqual({ session_id: 'session-1', session_control: { type: 'start' } })
    // The `start` bookkeeping waits for confirmed endpoint acceptance.
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
    await prepared.accept()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)

    const second = await prepare(request())
    expect(second.fields['agent_hint']).toEqual({ session_id: 'session-1' })
  })

  it('merges chained fields and settles the chained accept before noting', async () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    const order: string[] = []
    const chained = (): Promise<PreparedDeepSeekLlmApiExtensions> => Promise.resolve({
      fields: { agent_hint_test_field: { value: 'chained' } },
      accept: () => {
        order.push('chained-accept')
        return Promise.resolve()
      },
    })
    const prepare = agentHintPrepareExtensions({ chained, bridge })
    const prepared = await prepare(request())
    expect(prepared.fields).toEqual({
      agent_hint_test_field: { value: 'chained' },
      agent_hint: { session_id: 'session-1', session_control: { type: 'start' } },
    })
    await prepared.accept()
    expect(order).toEqual(['chained-accept'])
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)
  })

  it('skips injection and control-plane work for background purposes', async () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    const prepare = agentHintPrepareExtensions({ chained: emptyChain, bridge })

    const prepared = await prepare(request({ purpose: 'compaction' }))
    expect(prepared.fields).toEqual({})
    // No deferred resume fires for a background call.
    expect(calls).toEqual([])
    await prepared.accept()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
  })

  it('resumes a seeded session and waits for the prefetch before resolving preparation', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { bridge, calls } = makeBridge(gate, 1_000)
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    const prepare = agentHintPrepareExtensions({ chained: emptyChain, bridge })

    let settled = false
    const preparation = prepare(request()).then((prepared) => {
      settled = true
      return prepared
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: 'model-a' }])
    expect(settled).toBe(false)
    release?.()
    const prepared = await preparation
    // A seeded session never declares `start`.
    expect(prepared.fields['agent_hint']).toEqual({ session_id: 'session-1' })
  })

  it('suppresses the automatic start when no bridge tracks ordinary requests', async () => {
    const prepare = agentHintPrepareExtensions({ chained: emptyChain })
    const prepared = await prepare(request())
    expect(prepared.fields['agent_hint']).toEqual({ session_id: 'session-1' })
    await expect(prepared.accept()).resolves.toBeUndefined()
  })

  it('attaches the configured cache policy verbatim', async () => {
    const prepare = agentHintPrepareExtensions({
      chained: emptyChain,
      cacheControl: { type: 'kv', ttl: 300 },
    })
    const prepared = await prepare(request())
    expect(prepared.fields['agent_hint']).toEqual({
      session_id: 'session-1',
      cache_control: { type: 'kv', ttl: 300 },
    })
  })

  it('leaves anonymous requests unprefixed', async () => {
    const { bridge } = makeBridge()
    const prepare = agentHintPrepareExtensions({ chained: emptyChain, bridge })
    const prepared = await prepare(request({ sessionId: undefined }))
    expect(prepared.fields).toEqual({})
    await expect(prepared.accept()).resolves.toBeUndefined()
  })
})
