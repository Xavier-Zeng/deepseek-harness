import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { AgentHintAdapter } from '../src/adapter.ts'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { SessionControlVerb } from '../src/types.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const TEST_USER_ID = '00000000-0000-4000-8000-000000000001' as AnonymousUserId
const SID = SessionId('session-1')

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-agent-hint-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

function adapter(serverUrl: string, options: {
  cacheControl?: { type: string }
  bridge?: LifecycleBridge
} = {}): AgentHintAdapter {
  return new AgentHintAdapter({
    options: () => resolveAdapterOptions({ apiKeyEnv: 'MOTOR_API_KEY', baseURL: serverUrl }),
    resolveApiKey: () => Promise.resolve('k'),
    resolveUserId: () => TEST_USER_ID,
  }, options)
}

/** One resident bridge backed by a recording control client. */
function recordingBridge(): { bridge: LifecycleBridge; verbs: SessionControlVerb[] } {
  const verbs: SessionControlVerb[] = []
  const client = {
    send: (verb: SessionControlVerb) => {
      verbs.push(verb)
      return Promise.resolve()
    },
  } as unknown as SessionControlClient
  return { bridge: new LifecycleBridge({ client, pendingOpAwaitMs: 20 }), verbs }
}

async function generate(adapter: AgentHintAdapter, overrides: Partial<GenerateOptions> = {}): Promise<Message> {
  const assembler = new BlockAssembler()
  const request: GenerateOptions = {
    provider: 'deepseek-agent-hint',
    model: 'deepseek-v4-flash',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
    ...overrides,
  }
  for await (const chunk of adapter.stream(request)) assembler.push(chunk)
  return assembler.message({ kind: 'model', provider: request.provider, model: request.model })
}

describe('AgentHintAdapter against a mock server', () => {
  it('leaves anonymous requests unprefixed', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const message = await generate(adapter(server.url))
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests[0]).not.toHaveProperty('agent_hint')
  })

  it('declares start on the first ordinary request of a session', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const { bridge } = recordingBridge()
    const adapterInstance = adapter(server.url, { bridge })

    await generate(adapterInstance, { sessionId: SID })
    expect(server.requests[0]).toMatchObject({
      agent_hint: { session_id: 'session-1', session_control: { type: 'start' } },
    })

    // Second ordinary request of the same session: identity only, no verb.
    await generate(adapterInstance, { sessionId: SID })
    expect(server.requests[1]).toMatchObject({
      agent_hint: { session_id: 'session-1' },
    })
    expect(server.requests[1]).not.toMatchObject({ agent_hint: { session_control: {} } })
  })

  it('keeps background-purpose requests unprefixed even with a session', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    await generate(adapter(server.url), { sessionId: SID, purpose: 'compaction' })
    expect(server.requests[0]).not.toHaveProperty('agent_hint')
    // Background calls do not consume the first-ordinary slot.
    expect(server.requests[0]).not.toHaveProperty('x-deepseek-harness-session-id')
  })

  it('forwards the configured cache policy verbatim', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    await generate(adapter(server.url, { cacheControl: { type: 'kv' } }), { sessionId: SID })
    expect(server.requests[0]).toMatchObject({
      agent_hint: { session_id: 'session-1', session_control: { type: 'start' }, cache_control: { type: 'kv' } },
    })
  })

  it('never re-declares start for a seeded session', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { bridge, verbs } = recordingBridge()
    // Seed the bridge as if the session were created with prior history.
    bridge.noteOrdinaryRequest(SID, 'deepseek-v4-flash')
    bridge.onSessionCreated({
      id: SID,
      firstLiveSeq: 7,
      header: { parentSession: undefined },
    } as never)
    await generate(adapter(server.url, { bridge }), { sessionId: SID })
    expect(server.requests[0]).toMatchObject({ agent_hint: { session_id: 'session-1' } })
    expect(server.requests[0]).not.toMatchObject({ agent_hint: { session_control: {} } })
    expect(verbs).toEqual(['resume'])
  })

  it('carries the harness session header alongside the hint', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    await generate(adapter(server.url), { sessionId: SID })
    expect(server.headers[0]?.['x-deepseek-harness-session-id']).toBe('session-1')
  })

  it('stamps the hint on the prepared-call dispatch path the runtime uses', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapterInstance = adapter(server.url, { cacheControl: { type: 'default' } })
    // The runtime dispatches via prepareCall(); its closure must not bypass the hint layer.
    const prepared = await adapterInstance.prepareCall('deepseek-agent-hint', 'deepseek-v4-flash')
    expect(prepared.model.id).toBe('deepseek-v4-flash')
    const assembler = new BlockAssembler()
    for await (const chunk of prepared.stream({
      provider: 'deepseek-agent-hint',
      model: 'deepseek-v4-flash',
      sessionId: SID,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) assembler.push(chunk)
    expect(server.requests[0]).toMatchObject({
      agent_hint: {
        session_id: 'session-1',
        session_control: { type: 'start' },
        cache_control: { type: 'default' },
      },
    })
  })
})
