/** Plugin configuration and request-local resolution for the agent-hint route. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepSeekConfigFields, plainOptions as protocolOptions, resolveAdapterOptions as resolveProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Config as ProtocolConfig, DeepSeekConnectionOptions, Options as ProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS } from './control-client.ts'
import { DEFAULT_PENDING_OP_AWAIT_MS } from './lifecycle-bridge.ts'
import type { AgentHintCacheControl } from './types.ts'

/** The provider route this plugin owns; read at plugin load. */
export const DEFAULT_PROVIDER = 'deepseek-agent-hint'
/** Coordinator Messages API root; the adapter appends `/v1/messages`. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:1025'

/** Session lifecycle control plane configuration. */
export interface SessionControlConfig {
  /** `false` disables manage requests; the static data plane keeps working. */
  enabled: boolean
  /** Full manage-request URL; omission derives `<baseURL>/v1/chat/completions`. */
  endpoint?: string | undefined
  /** Cap on how long an ordinary request waits for an in-flight verb. */
  pendingOpAwaitMs: number
  /** Per-attempt control-request timeout in milliseconds. */
  controlTimeoutMs: number
  /** Transport-level retries after the first failed attempt. */
  retries: number
}

/** The two `agent_hint` planes: static hint injection and lifecycle control. */
export interface AgentHintConfig {
  /** Master switch for `agent_hint` injection; `false` degrades to plain Messages transport. */
  enabled: boolean
  /** Static coordinator cache policy copied verbatim into every hint. */
  cacheControl?: AgentHintCacheControl | undefined
  /** Session lifecycle control plane. */
  sessionControl: SessionControlConfig
}

/** Messages configuration for the agent-hint route, with an optional per-request credential reference. */
export interface Config extends ProtocolConfig {
  /**
   * Credential reference resolved per request. `undefined` (the default) leaves
   * the route deliberately unauthenticated: requests carry no `authorization` header.
   */
  apiKeyEnv: Volatile<string | undefined>
  /** Provider route id; read at plugin load (changing it requires a reload). */
  provider: string
  /** The two `agent_hint` planes. */
  agentHint?: AgentHintConfig | undefined
}

export const Config = z.object({
  ...deepSeekConfigFields,
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  models: deepSeekConfigFields.models.default([]),
  apiKeyEnv: z.string().role('credential-ref').volatile(),
  provider: z.string().default(DEFAULT_PROVIDER),
  agentHint: z.object({
    enabled: z.boolean().default(true),
    // `z.object` implicitly defaults to `{}`, which would cascade a missing
    // `cacheControl` into existence and trip the inner required `type`. The
    // explicit `default(undefined)` keeps the whole block optional: absent
    // stays absent (no `cache_control` in any hint); a provided block must
    // still name its `type`.
    cacheControl: z.object({ type: z.string().required() }).default(undefined as never),
    sessionControl: z.object({
      enabled: z.boolean().default(true),
      endpoint: z.string(),
      pendingOpAwaitMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_PENDING_OP_AWAIT_MS),
      controlTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONTROL_TIMEOUT_MS),
      retries: z.number().step(1).min(0).max(10).default(DEFAULT_CONTROL_RETRIES),
    }),
  }),
})

/** Plain deployment inputs for the agent-hint route. */
export type Options = ProtocolOptions & { apiKeyEnv?: string }

/** Endpoint and credential reference captured from the same configuration generation. */
export interface ResolvedAgentHintOptions extends DeepSeekConnectionOptions {
  /** Credential reference used only for this connection snapshot; absent sends unauthenticated requests. */
  apiKeyEnv: CredentialRef | undefined
}

/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  const apiKeyEnv = config.apiKeyEnv.get()
  return { ...protocolOptions(config), ...apiKeyEnv === undefined ? {} : { apiKeyEnv } }
}

/** Resolve route and protocol settings together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @returns validated endpoint facts and the matching credential reference, or `undefined` when the route names none.
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedAgentHintOptions {
  const apiKeyEnv = config.apiKeyEnv
  return {
    ...resolveProtocolOptions(config, environment),
    apiKeyEnv: apiKeyEnv === undefined ? undefined : credentialRef(apiKeyEnv),
  }
}
