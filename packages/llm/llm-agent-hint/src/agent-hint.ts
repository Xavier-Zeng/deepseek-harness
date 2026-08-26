/**
 * Pure construction of the `agent_hint` wire field. One function owns every
 * inclusion rule, so the adapter stays transport-only and every rule is
 * unit-testable without a coordinator: background-purpose calls stay
 * unprefixed, a session without identity stays anonymous, and the `start`
 * verb rides only the first ordinary request of a fresh session.
 *
 * @module dsh-llm-agent-hint/agent-hint
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AgentHintWire, SessionControlVerb } from './types.ts'

/** Inputs the adapter collects per request; no wire knowledge leaks back out. */
export interface AgentHintInputs {
  /** Session identity of the request; `undefined` requests stay unprefixed. */
  sessionId: SessionId | undefined
  /** Call purpose; every defined non-`undefined` purpose skips injection. */
  purpose: GenerateOptions['purpose']
  /** Identity of the compacted-away parent session, when one is known. */
  parentSessionId?: SessionId | undefined
  /** Coordinator cache policy, when configured. */
  cacheControl?: { type: string; [key: string]: unknown } | undefined
  /** Verb a caller asked to piggyback; only `start` is ever auto-supplied. */
  sessionControl?: SessionControlVerb | undefined
  /** Whether the session was created with prior history (resume/fork/replay). */
  seeded: boolean
  /** Whether an ordinary (non-background) request already carried this session's hint. */
  firstOrdinarySent: boolean
}

/**
 * Build the `agent_hint` field for one request, or `undefined` when the
 * request must stay unprefixed. Rules, in order:
 *
 * 1. Defined purposes (compaction, session-title, …) are background calls
 *    that must not perturb the live session's KV-cache identity.
 * 2. A request without a session identity cannot prefix anything.
 * 3. An explicit piggyback verb wins (the `start` path).
 * 4. Otherwise the first ordinary request of a fresh session declares
 *    `start`; a seeded session never re-declares it.
 * 5. `parent_session_id` and `cache_control` attach whenever their inputs
 *    are present, including on verb-carrying requests.
 *
 * @param inputs - the per-request facts collected by the adapter.
 * @returns the wire object, or `undefined` to omit the field entirely.
 */
export function buildAgentHint(inputs: AgentHintInputs): AgentHintWire | undefined {
  if (inputs.purpose !== undefined) return undefined
  if (inputs.sessionId === undefined) return undefined

  const hint: AgentHintWire = { session_id: String(inputs.sessionId) }
  if (inputs.parentSessionId !== undefined) {
    hint.parent_session_id = String(inputs.parentSessionId)
  }
  if (inputs.cacheControl !== undefined) {
    hint.cache_control = { ...inputs.cacheControl }
  }
  if (inputs.sessionControl !== undefined) {
    hint.session_control = { type: inputs.sessionControl }
  } else if (!inputs.seeded && !inputs.firstOrdinarySent) {
    hint.session_control = { type: 'start' }
  }
  return hint
}
