/**
 * `SessionControlClient`: one-way, best-effort session-lifecycle manage
 * requests against a MindIE-Motor coordinator's OpenAI-compatible infer
 * endpoint. The wire contract is the coordinator's own: an empty-messages
 * chat-completions request whose `agent_hint.session_control` verb the
 * coordinator translates into a context-management operation (`pause`→
 * offload, `stop`/`compact`→evict, `resume`→prefetch). Control requests are
 * advisory by design — a failed one logs a warning and never rejects the
 * harness work that triggered it.
 *
 * @module dsh-llm-agent-hint/control-client
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { SessionControlVerb } from './types.ts'

/** Sink for the warnings a best-effort control request may produce. */
export interface ControlWarnSink {
  /** Report one swallowed control-request failure. */
  (message: string, error?: unknown): void
}

/** Validated facts for the control plane; resolved once per plugin load. */
export interface SessionControlClientOptions {
  /** Endpoint base shared with the data plane; `/chat/completions` is appended. */
  baseURL: string
  /** Resolves the bearer token for one manage request. */
  resolveApiKey: () => Promise<string>
  /** Served model id carried on manage requests; any served id is accepted. */
  model: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Transport-level retries after the first failed attempt. */
  retries: number
  /** Warning sink; defaults to silent. */
  warn?: ControlWarnSink
}

/** Default control-request timeout. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000
/** Default transport-level retries for one control request. */
export const DEFAULT_CONTROL_RETRIES = 1

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve() }, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Fire one `agent_hint.session_control` manage request. Never rejects: every
 * failure path — transport, timeout, non-2xx — resolves after logging a
 * warning through the configured sink, because session control must not turn
 * a harness lifecycle event into a user-visible error.
 */
export class SessionControlClient {
  constructor(private readonly options: SessionControlClientOptions) {}

  /**
   * Send one verb for one session.
   * @param verb - the lifecycle verb; `start` is a data-plane piggyback only
   *   and is rejected here because an empty-messages `start` request has no
   *   coordinator-side effect.
   * @param sessionId - the coordinator session identity.
   * @param model - the session's last ordinary-request model, when one was
   *   observed; omitted falls back to the configured default.
   * @param signal - optional caller cancellation for the attempt sequence.
   */
  async send(verb: SessionControlVerb, sessionId: string, model?: string, signal?: AbortSignal): Promise<void> {
    if (verb === 'start') {
      this.options.warn?.('llm-agent-hint: "start" is a data-plane piggyback verb; it is never sent as a manage request')
      return
    }
    const body = JSON.stringify({
      model: model ?? this.options.model,
      messages: [],
      stream: false,
      agent_hint: {
        session_id: sessionId,
        session_control: { type: verb },
      },
    })
    let attempt = 0
    // One bounded retry covers the flapping-connection window a coordinator
    // restart produces; every other failure is terminal for this verb.
    while (attempt <= this.options.retries) {
      attempt += 1
      const outcome = await this.attempt(body, verb, sessionId, signal)
      if (outcome === 'sent' || signal?.aborted) return
      if (attempt > this.options.retries) return
      await sleep(200, signal)
    }
  }

  private async attempt(
    body: string,
    verb: SessionControlVerb,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<'sent' | 'failed'> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    try {
      const response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${await this.options.resolveApiKey()}`,
          'content-type': 'application/json',
          ...attributionHeaders(),
        },
        body,
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (!response.ok) {
        this.options.warn?.(
          `llm-agent-hint: session_control "${verb}" for session ${sessionId} failed with HTTP ${response.status}`,
        )
        return 'failed'
      }
      // Drain the (non-streaming) body so the connection is reusable.
      await response.arrayBuffer().catch(() => undefined)
      return 'sent'
    } catch (error: unknown) {
      this.options.warn?.(
        `llm-agent-hint: session_control "${verb}" for session ${sessionId} failed to reach ${this.options.baseURL}`,
        error,
      )
      return 'failed'
    }
  }
}
