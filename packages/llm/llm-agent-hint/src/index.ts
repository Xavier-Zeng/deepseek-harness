/**
 * Register an {@link AgentHintAdapter} for the `deepseek-agent-hint`
 * provider route on `ctx.llm`: a DeepSeek-compatible transport aimed at a
 * MindIE-Motor coordinator, whose ordinary requests carry the `agent_hint`
 * field (session identity, optional fork lineage, optional cache policy)
 * and whose session lifecycle events drive standalone `session_control`
 * manage requests (`resume`/`compact`/`stop`) against the same endpoint.
 * The transport layer is the `llm-deepseek` pipeline, re-exported and
 * wrapped; connection facts resolve per request exactly as in
 * `llm-deepseek`, and every control-plane failure is fail-open (WARN only).
 * @module @deepseek-ai/dsh-llm-agent-hint
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import type {
  Config as DeepSeekConfig,
  DeepSeekCatalogModel,
  DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { AgentHintAdapter } from './adapter.ts'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from './control-client.ts'
import { DEFAULT_PENDING_OP_AWAIT_MS, LifecycleBridge } from './lifecycle-bridge.ts'

export { AgentHintAdapter } from './adapter.ts'
export type { AgentHintAdapterOptions } from './adapter.ts'
export { buildAgentHint } from './agent-hint.ts'
export type { AgentHintInputs } from './agent-hint.ts'
export { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from './control-client.ts'
export type { ControlWarnSink, SessionControlClientOptions } from './control-client.ts'
export { DEFAULT_PENDING_OP_AWAIT_MS, LifecycleBridge } from './lifecycle-bridge.ts'
export type { BridgeWarnSink, LifecycleBridgeOptions } from './lifecycle-bridge.ts'
export type { AgentHintWire, SessionControlVerb } from './types.ts'

export const name = 'llm-agent-hint'
export const inject = ['llm']

const NS = settingsNamespace('llm-agent-hint')
const DEFAULT_API_KEY_ENV = 'MOTOR_API_KEY'
/** The provider route this plugin owns; configurable at load time only. */
const DEFAULT_PROVIDER = 'deepseek-agent-hint'
/** Coordinator inference API default; the `/v1` prefix is required. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:1025/v1'

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-agent-hint` settings-section shape. Transport fields mirror
 * `llm-deepseek`; the `agentHint` section gates the two planes.
 */
export interface Config {
  /** Provider route id; read at plugin load (changing it requires a reload). */
  provider?: string
  /** Credential reference (environment-variable name) resolved per request; defaults to `MOTOR_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Coordinator endpoint base INCLUDING the `/v1` prefix (the adapter
   * appends `/chat/completions`); defaults to the local coordinator port.
   */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Default per-request output cap (default 256,000). */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models mirroring the coordinator's `/v1/models`; requests remain unrestricted. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
  /** The two `agent_hint` planes: static hint injection and lifecycle control. */
  agentHint?: {
    /** Master switch for `agent_hint` injection; `false` degrades to plain DeepSeek transport. */
    enabled?: boolean
    /** Static coordinator cache policy copied verbatim into every hint. */
    cacheControl?: {
      /** Policy type discriminator the coordinator dispatches on (e.g. `default`). */
      type: string
      /** Additional policy fields, passed through verbatim. */
      [key: string]: unknown
    }
    /** Session lifecycle control plane. */
    sessionControl?: {
      /** `false` disables manage requests; the static data plane keeps working. */
      enabled?: boolean
      /** Cap on how long an ordinary request waits for an in-flight verb (default 2000). */
      pendingOpAwaitMs?: number
      /** Per-attempt control-request timeout in milliseconds (default 5000). */
      controlTimeoutMs?: number
      /** Transport-level retries after the first failed attempt (default 1). */
      retries?: number
    }
  }
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  provider: z.string().default(DEFAULT_PROVIDER),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
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
      pendingOpAwaitMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_PENDING_OP_AWAIT_MS),
      controlTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONTROL_TIMEOUT_MS),
      retries: z.number().step(1).min(0).max(10).default(DEFAULT_CONTROL_RETRIES),
    }),
  }),
})

/** One resolution's complete transport facts (the `llm-deepseek` shape). */
export type ResolvedAgentHintOptions = DeepSeekConnectionOptions

/** Warn once when the configured base URL lacks the `/v1` prefix. */
function warnOnMissingV1(ctx: Context, baseURL: string): void {
  if (/\/v1\/?$/.test(baseURL)) return
  ctx.logger.warn(
    `llm-agent-hint: baseURL "${baseURL}" lacks the "/v1" prefix; requests will hit`
    + ` ${baseURL}/chat/completions instead of the coordinator inference API`,
  )
}

export function apply(ctx: Context, config: Config): void {
  // Registration-captured facts: the provider route and the base-URL shape
  // are read once; a settings change to either requires a plugin reload.
  const provider = config.provider ?? DEFAULT_PROVIDER
  warnOnMissingV1(ctx, config.baseURL ?? DEFAULT_BASE_URL)

  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedAgentHintOptions | undefined
  const options = (): ResolvedAgentHintOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const transport: DeepSeekConfig = {
        apiKeyEnv: raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
        baseURL: raw.baseURL ?? DEFAULT_BASE_URL,
        ...raw.thinking === undefined ? {} : { thinking: raw.thinking },
        ...raw.reasoningEffort === undefined ? {} : { reasoningEffort: raw.reasoningEffort },
        ...raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens },
        ...raw.defaultContextWindow === undefined ? {} : { defaultContextWindow: raw.defaultContextWindow },
        ...raw.models === undefined ? {} : { models: raw.models },
        ...raw.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: raw.streamIdleTimeoutMs },
        ...raw.retryPolicy === undefined ? {} : { retryPolicy: raw.retryPolicy },
      }
      const next = resolveAdapterOptions(transport, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-agent-hint: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedAgentHintOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-agent-hint', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-agent-hint', ref)
      }
    }
    throw new LlmError(
      `llm-agent-hint: no API key for provider route "${provider}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()

  const sessionControl = config.agentHint?.sessionControl
  const controlEnabled = config.agentHint?.enabled !== false && sessionControl?.enabled !== false
  const bridge = controlEnabled
    ? new LifecycleBridge({
      client: new SessionControlClient({
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        resolveApiKey: async () => resolveApiKey(options()),
        model: options().models[0]?.id ?? 'default',
        timeoutMs: sessionControl?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        retries: sessionControl?.retries ?? DEFAULT_CONTROL_RETRIES,
        warn: (message, error) => {
          ctx.logger.warn(message)
          if (error !== undefined) ctx.logger.warn(error)
        },
      }),
      pendingOpAwaitMs: sessionControl?.pendingOpAwaitMs ?? DEFAULT_PENDING_OP_AWAIT_MS,
    })
    : undefined
  bridge?.subscribe(ctx)

  // `null` survives schema resolution (the optional-object default only
  // covers the absent case); treat it as absent too so no empty
  // `cache_control` block ever reaches a hint.
  const cacheControl = config.agentHint?.cacheControl ?? undefined
  const adapter = new AgentHintAdapter(
    { options, resolveApiKey, resolveUserId },
    {
      ...cacheControl === undefined ? {} : { cacheControl },
      ...bridge === undefined ? {} : { bridge },
    },
  )
  ctx.llm.registerConfigurableProviders([
    { provider, displayName: 'DeepSeek (agent-hint)', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([provider], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration; `replace`
    // re-reads it in one synchronous registry section (mirroring llm-deepseek).
    registration.replace([provider])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
