/**
 * Wire types for the `agent_hint` request field consumed by MindIE-Motor
 * coordinators: stable session identity for KV-cache reuse, parent linkage
 * for compaction continuations, cache policy, and the session lifecycle
 * control verbs. The shapes mirror the coordinator's `agent_hint_rfc.md`
 * and `session_control_rfc.md` design notes; the coordinator — not this
 * package — translates control verbs into `context_management` manage
 * requests.
 *
 * @module dsh-llm-agent-hint/types
 */

/**
 * One session lifecycle control verb. Coordinator translation: `pause`→offload,
 * `stop`→evict, `compact`→evict, `resume`→prefetch; `start` only declares liveness.
 */
export type SessionControlVerb = 'start' | 'pause' | 'stop' | 'compact' | 'resume'

/** The `agent_hint` wire object appended to chat-completions requests. */
export interface AgentHintWire {
  /** Stable session identity the coordinator keys KV-cache state on. */
  session_id: string
  /** Identity of the compacted-away session this one continues. */
  parent_session_id?: string
  /** Coordinator-side cache policy hint. */
  cache_control?: { type: string; [key: string]: unknown }
  /** Session lifecycle control request; one verb per request. */
  session_control?: { type: SessionControlVerb }
}
