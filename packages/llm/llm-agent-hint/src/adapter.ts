/**
 * `AgentHintAdapter`: a `DeepSeekAdapter` that stamps every ordinary
 * generation request with the `agent_hint` field the coordinator reads for
 * per-session routing, cache-control, and KV-cache lifecycle. The transport
 * (fetch + SSE + translate) is the inherited DeepSeek pipeline; this layer
 * only injects the hint between serialization and the wire, and — when a
 * {@link LifecycleBridge} is attached — waits out in-flight manage verbs
 * before serializing.
 *
 * @module dsh-llm-agent-hint/adapter
 */

import {
  attributionHeaders,
  LlmError,
  ProviderRequestId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
} from '@deepseek-ai/dsh-llm-deepseek'
import {
  httpErrorCode,
  parseSse,
  serializeRequest,
  translate,
} from '@deepseek-ai/dsh-llm-deepseek/wire'
import type {
  DeepSeekAdapterOptions,
  DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type { WireError, WireRequest } from '@deepseek-ai/dsh-llm-deepseek/wire'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { AgentHintWire } from './types.ts'
import { buildAgentHint } from './agent-hint.ts'
import type { LifecycleBridge } from './lifecycle-bridge.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/**
 * Constructor options for the agent-hint layer of the adapter.
 */
export interface AgentHintAdapterOptions {
  /** Static `cache_control` block copied verbatim into every hint. */
  cacheControl?: { type: string; [key: string]: unknown }
  /** Lifecycle bridge; presence enables the control plane (barrier + verbs). */
  bridge?: LifecycleBridge
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * A DeepSeek transport whose ordinary requests carry `agent_hint`. Provider
 * metadata (model catalog, retry policy, capability resolution) is inherited
 * unchanged; only the request body and the pre-serialization barrier differ.
 */
export class AgentHintAdapter extends DeepSeekAdapter {
  /** The parent keeps its config private; the hint layer re-holds the same reference for its own orchestration. */
  private readonly own: DeepSeekAdapterOptions

  constructor(
    config: DeepSeekAdapterOptions,
    private readonly agentHint: AgentHintAdapterOptions,
  ) {
    super(config)
    this.own = config
  }

  /**
   * The runtime dispatches prepared calls through {@link DeepSeekAdapter.prepareCall},
   * whose returned closure binds the parent transport directly and would bypass
   * the hint layer. Rebind it to {@link stream} so every dispatch path — direct
   * or prepared — carries the barrier and the `agent_hint` field.
   */
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return super.prepareCall(provider, model, signal).then(call => ({
      ...call,
      stream: (options: GenerateOptions) => this.stream(options),
    }))
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Control plane: an ordinary request never serializes while a manage
    // verb for the same session is still in flight (bounded, fail-open).
    const bridge = this.agentHint.bridge
    if (bridge !== undefined) {
      if (options.purpose === undefined) {
        bridge.ensureResume(options.sessionId, options.model)
      }
      await bridge.awaitPendingOp(options.sessionId)
    }
    const facts = bridge?.facts(options.sessionId)
    const hint: AgentHintWire | undefined = buildAgentHint({
      sessionId: options.sessionId,
      purpose: options.purpose,
      parentSessionId: facts?.parentSessionId,
      cacheControl: this.agentHint.cacheControl,
      seeded: facts?.seeded ?? false,
      firstOrdinarySent: facts?.firstOrdinarySent ?? false,
    })
    if (bridge !== undefined && hint !== undefined) {
      bridge.noteOrdinaryRequest(options.sessionId, options.model)
    }

    // One resolution per stream call, identical to the parent transport.
    const connection = this.own.options()
    const apiKey = await this.own.resolveApiKey(connection)
    const userId = this.own.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.requestWithHint(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      hint,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  /** The inherited transport with `agent_hint` stamped between serialization and the wire. */
  private async * requestWithHint(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    hint: AgentHintWire | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body: WireRequest & { agent_hint?: AgentHintWire } = serializeRequest(options, connection.defaults)
    if (hint !== undefined) body.agent_hint = hint
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `DeepSeek API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing; the HTTP status still identifies the failure.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}
