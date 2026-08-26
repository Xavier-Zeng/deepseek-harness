import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from '../src/control-client.ts'
import type { ControlWarnSink } from '../src/control-client.ts'

function jsonResponse(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } })
}

describe('SessionControlClient', () => {
  let warnings: [string, unknown?][]
  let warn: ControlWarnSink
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    warnings = []
    warn = (message, error) => { warnings.push([message, error]) }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client(options?: {
    baseURL?: string
    model?: string
    timeoutMs?: number
    retries?: number
  }): SessionControlClient {
    return new SessionControlClient({
      baseURL: 'http://coordinator.test/v1',
      resolveApiKey: () => Promise.resolve('k'),
      model: 'default-model',
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
      retries: DEFAULT_CONTROL_RETRIES,
      warn,
      ...options,
    })
  }

  it('never sends "start": it is a data-plane piggyback verb only', async () => {
    await client().send('start', 'session-1')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnings.map(([message]) => message)[0]).toContain('start')
  })

  it('posts the verb as an empty-messages agent_hint request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client().send('compact', 'session-1', 'last-model')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://coordinator.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'last-model',
      messages: [],
      stream: false,
      agent_hint: { session_id: 'session-1', session_control: { type: 'compact' } },
    })
    expect(warnings).toEqual([])
  })

  it('falls back to the configured default model', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client().send('resume', 'session-1')
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('missing fetch call')
    const init = call[1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'default-model',
    })
  })

  it('fails open on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503))
    await expect(client().send('stop', 'session-1')).resolves.toBeUndefined()
    expect(warnings.map(([message]) => message)[0]).toContain('HTTP 503')
  })

  it('fails open on a transport error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(client().send('pause', 'session-1')).resolves.toBeUndefined()
    expect(warnings.map(([message]) => message)[0]).toContain('failed to reach')
    expect(warnings[0]?.[1]).toBeInstanceOf(Error)
  })

  it('retries once after a failed attempt', async () => {
    fetchMock.mockRejectedValueOnce(new Error('flap'))
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client({ retries: 1 }).send('compact', 'session-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnings.length).toBe(1)
  })

  it('gives up after the configured retries', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    await client({ retries: 0 }).send('compact', 'session-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the bearer token and attribution headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client().send('resume', 'session-1')
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('missing fetch call')
    const init = call[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer k')
    expect(headers['content-type']).toBe('application/json')
  })
})
