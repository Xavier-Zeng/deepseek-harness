/**
 * `LifecycleBridge`: the seam between harness session lifecycle events and
 * coordinator session-control verbs. `session/created` on a seeded session
 * requests a KV-cache `resume` (prefetch), a successful `compaction/end`
 * requests a `compact` (evict-and-rebuild), and `session/disposed` requests
 * a terminal `stop` (evict). The bridge also tracks, per session, whether
 * the first ordinary request already carried the `start` declaration, and
 * exposes a bounded fail-open barrier (`awaitPendingOp`) so a request that
 * races an in-flight manage verb waits for it — up to a configured cap —
 * before serialization.
 *
 * @module dsh-llm-agent-hint/lifecycle-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: merges 'compaction/start'/'compaction/end' into SessionEventMap.
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { SessionControlClient } from './control-client.ts'

/** Warning sink shared with the control client. */
export interface BridgeWarnSink {
  /** Report one degraded bridge behavior (barrier timeout, send failure). */
  (message: string, error?: unknown): void
}

/** Validated facts for the bridge; resolved once per plugin load. */
export interface LifecycleBridgeOptions {
  /** Best-effort manage-request transport. */
  client: SessionControlClient
  /** Cap on how long a data-plane request waits for an in-flight verb. */
  pendingOpAwaitMs: number
  /** Warning sink; defaults to silent. */
  warn?: BridgeWarnSink
}

/** Default cap for the pre-serialization manage-verb barrier. */
export const DEFAULT_PENDING_OP_AWAIT_MS = 2_000

interface SessionState {
  seeded: boolean
  firstOrdinarySent: boolean
  parentSessionId: SessionId | undefined
  lastModel: string | undefined
  pendingOp: Promise<void> | undefined
}

/**
 * Event-to-verb routing with per-session bookkeeping. One instance serves
 * the whole plugin lifetime; all Cordis listeners are registered through
 * {@link subscribe} so their disposers follow the plugin's own scope.
 */
export class LifecycleBridge {
  private readonly states = new Map<string, SessionState>()

  constructor(private readonly options: LifecycleBridgeOptions) {}

  /**
   * Register the three lifecycle listeners on one context.
   * @param ctx - context whose scope owns the listener disposers.
   */
  subscribe(ctx: Context): void {
    ctx.on('session/created', (session) => { this.onSessionCreated(session) }, { global: true })
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }, { global: true })
    ctx.on('session/disposed', (session) => { this.onSessionDisposed(session) }, { global: true })
  }

  /** Drop all tracked state (plugin teardown). */
  dispose(): void {
    this.states.clear()
  }

  /**
   * The `agent_hint` facts of one session for the next ordinary request.
   * @param sessionId - session identity, when the request carries one.
   * @returns `seeded`, `firstOrdinarySent`, and fork-parent identity for
   * {@link buildAgentHint}.
   */
  facts(sessionId: SessionId | undefined): {
    seeded: boolean
    firstOrdinarySent: boolean
    parentSessionId: SessionId | undefined
  } {
    const state = sessionId === undefined ? undefined : this.states.get(String(sessionId))
    return {
      seeded: state?.seeded ?? false,
      firstOrdinarySent: state?.firstOrdinarySent ?? false,
      parentSessionId: state?.parentSessionId,
    }
  }

  /**
   * Wait — up to the configured cap — for the session's in-flight manage
   * verb to settle. Fails open: a timeout resolves anyway with a warning,
   * because a slow control plane must never block an ordinary request.
   * @param sessionId - session identity, when the request carries one.
   */
  async awaitPendingOp(sessionId: SessionId | undefined): Promise<void> {
    const pending = sessionId === undefined ? undefined : this.states.get(String(sessionId))?.pendingOp
    if (pending === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.pendingOpAwaitMs)
    })
    try {
      await Promise.race([pending, expiry])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Record one ordinary request: flips `firstOrdinarySent` (so the next
   * request never re-declares `start`) and remembers the model id for
   * later manage requests.
   * @param sessionId - session identity; `undefined` requests are ignored.
   * @param model - model id reused by later manage requests.
   */
  noteOrdinaryRequest(sessionId: SessionId | undefined, model: string): void {
    if (sessionId === undefined) return
    const state = this.state(String(sessionId))
    state.firstOrdinarySent = true
    state.lastModel = model
  }

  /**
   * `session/created`: a seeded session asks the coordinator to prefetch.
   * @param session - the freshly created session.
   */
  onSessionCreated(session: Session): void {
    const id = String(session.id)
    const seeded = session.firstLiveSeq > 0
    const state = this.state(id)
    state.seeded = seeded
    state.parentSessionId = session.header.parentSession
    if (!seeded) return
    this.track(id, this.options.client.send('resume', id, state.lastModel))
  }

  /**
   * `session/event`: a successful compaction asks the coordinator to evict and rebuild.
   * @param _session - the session that emitted the event.
   * @param event - the lifecycle event; only `compaction/end` is acted on.
   */
  onSessionEvent(_session: Session, event: SessionEvent): void {
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const id = String(_session.id)
    const state = this.states.get(id)
    this.track(id, this.options.client.send('compact', id, state?.lastModel))
  }

  /**
   * `session/disposed`: terminal evict; fire-and-forget with no barrier.
   * @param session - the session being disposed.
   */
  onSessionDisposed(session: Session): void {
    const id = String(session.id)
    const state = this.states.get(id)
    void this.options.client.send('stop', id, state?.lastModel)
      .then(() => this.states.delete(id))
  }

  private state(id: string): SessionState {
    let state = this.states.get(id)
    if (state === undefined) {
      state = { seeded: false, firstOrdinarySent: false, parentSessionId: undefined, lastModel: undefined, pendingOp: undefined }
      this.states.set(id, state)
    }
    return state
  }

  private track(id: string, promise: Promise<void>): void {
    const state = this.state(id)
    state.pendingOp = promise.finally(() => {
      if (state.pendingOp === promise) state.pendingOp = undefined
    })
  }
}
