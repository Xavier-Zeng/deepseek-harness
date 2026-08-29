# @deepseek-ai/dsh-llm-agent-hint

English | [中文](README.zh.md)

DeepSeek-compatible transport for a MindIE-Motor coordinator: the `llm-deepseek` pipeline (direct `fetch` + SSE, the same wire serialization, translation, and error codes) wrapped so that ordinary requests carry the coordinator's `agent_hint` field, and harness session lifecycle events drive standalone `session_control` manage requests. The package is opt-in — it owns its own provider route and never touches the `deepseek-official` route; mounting nothing degrades to plain `llm-deepseek`.

Two planes ship in one plugin. The **data plane** is pure injection: `buildAgentHint` decides, per request, whether the wire body carries `session_id` (plus fork lineage and a static cache policy) and whether the first ordinary request of a fresh session declares `session_control: start`. The **control plane** is a lifecycle bridge: `session/created` records seeded history, and the first ordinary request on that session then requests a `resume` prefetch; a successful `compaction/end` requests a `compact`, and `session/disposed` requests a terminal `stop`. Each control verb is an empty-messages chat-completions request whose `agent_hint.session_control` verb the coordinator translates into a context-management operation. Control requests are advisory and fail open: a failure logs a warning and never rejects the harness work that triggered it.

The package root exposes the Cordis plugin contract, `AgentHintAdapter`, `buildAgentHint`, `SessionControlClient`, and `LifecycleBridge`; the wire types (`AgentHintWire`, `SessionControlVerb`) are exported for tests and integrations.

## Config

```yaml
- id: llm-agent-hint
  name: '@deepseek-ai/dsh-llm-agent-hint'
  config:
    provider: deepseek-agent-hint # route id; changing it requires a reload
    apiKeyEnv: MOTOR_API_KEY      # default; resolved per request via ctx.credentials, then the environment
    baseURL: http://127.0.0.1:1025/v1 # default local coordinator; the /v1 prefix is REQUIRED
    models:                       # optional; mirrors the coordinator's /v1/models
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
    agentHint:
      enabled: true               # master switch; false degrades to plain DeepSeek transport
      cacheControl:               # optional static policy copied verbatim into every hint
        type: default
      sessionControl:
        enabled: true             # false disables manage requests; the data plane keeps working
        pendingOpAwaitMs: 2000    # how long an ordinary request waits for an in-flight verb
        controlTimeoutMs: 5000    # per-attempt control-request timeout
        retries: 1                # transport-level retries after the first failed attempt
```

**The `/v1` caveat:** the inherited DeepSeek transport POSTs `${baseURL}/chat/completions`, so the coordinator's `baseURL` must include the `/v1` prefix. A missing prefix sends both ordinary and control requests to a 404; the plugin logs a load-time warning when it detects one. Transport fields (`thinking`, `reasoningEffort`, `maxTokens`, `defaultContextWindow`, `streamIdleTimeoutMs`, `retryPolicy`) mirror `llm-deepseek` exactly and resolve per request through the same settings/credentials machinery (`settingsNs: llm-agent-hint`; the API key resolves per request, from `MOTOR_API_KEY` by default).

The provider route defaults to `deepseek-agent-hint` and is registration-captured: registering another adapter for it throws `LlmError('DUPLICATE_ADAPTER')`, and a settings change to `provider` or `baseURL` requires a plugin reload. The route also appears in `ctx.llm.listConfigurableProviders()` (display name `DeepSeek (agent-hint)`), and `models` advertises an advisory catalog exactly as in `llm-deepseek` — unlisted model ids still pass through unchanged.

## Data plane rules

`buildAgentHint` owns every inclusion rule, in order:

1. Requests with a defined `purpose` (`compaction`, `session-title`, …) stay unprefixed — background calls must not perturb the live session's KV-cache identity.
2. Requests without a `sessionId` stay anonymous (no `agent_hint` at all).
3. `parent_session_id` attaches whenever the session was created with fork lineage; `cache_control` attaches whenever configured. Both ride on verb-carrying requests too.
4. `session_control: {type: 'start'}` rides only the first ordinary request of a **fresh** (non-seeded) session; a seeded session (resume/fork/replay) never declares `start`. A session is seeded when its constructor history contains at least one `turn/start` before `firstLiveSeq`. A blank persisted session whose log holds only its `session/end-seed` marker is still fresh and declares `start`.

The client never emits `session_control` alongside `context_management` — the single-verb enum makes the mutual-exclusion rule structurally impossible. On an old coordinator without `session_control` support, the piggybacked `start` lands in `raw_extra` (harmless) and manage verbs return HTTP 400, which fails open with a warning.

## Control plane

| Harness event | Verb | Coordinator translation |
|---|---|---|
| first ordinary request (seeded) | `resume` | prefetch the session's KV cache |
| composer draft becomes non-empty | `resume` | prefetch a paused session before the next prompt |
| foreground session changes away | `pause` | offload the previous session's KV cache |
| `compaction/end` (success) | `compact` | evict and rebuild under the new identity |
| `session/disposed` | `stop` | evict |
| first ordinary request (fresh) | `start` | declare liveness (piggybacked, never standalone) |

Manage requests reuse the data plane's endpoint and credentials: an empty-messages, non-streaming chat-completions request whose `agent_hint.session_control` names the verb. `resume` carries the model id of the ordinary request that triggered it; `compact` and `stop` carry the session's last observed model id, falling back to the first catalog entry. The id must match a model id the coordinator's AIGW serves. One bounded retry covers the flapping-connection window of a coordinator restart; every other failure is terminal for that verb. `stop` and `pause` are fire-and-forget (a disposal or switch-away must not block the foreground session); `resume` and `compact` additionally arm a **pendingOp barrier**: an ordinary request for the same session waits — up to `pendingOpAwaitMs` — for the in-flight verb before serializing, then proceeds anyway (fail-open). With no pending op the barrier is a no-op and adds zero latency.

## Model Experience

None, as the wrapper stamps model-hidden transport metadata onto already-assembled requests; it registers no prompt, schema, or message of its own.

#### KV Cache effect

Pass-through for the assembled prefix: the injected `agent_hint` rides outside model-visible content, and an unchanged session prefix stays eligible for the coordinator's KV-cache reuse exactly as the underlying DeepSeek transport reports it. A session-identity change (fork, compaction continuation) or a control verb selects a different server-side cache domain; coordinator-side eviction and TTL remain outside this package.

## Known Limitations and Deferred Work

- **Manage requests still cost a tiny generation under the coordinator's V1 design** — the empty-messages request runs the chat pipeline; ops are rare (per lifecycle transition), and capping with `max_tokens: 1` is deferred until a coordinator-side cost concern materializes.
- **Timer-based idle `pause` is deferred** — `pause` now fires when the foreground session changes away from a session that already ran a turn, after that session reaches idle; an idle-timer policy is not defined yet.
- **`session/disposed` can race process teardown** — the terminal `stop` is best-effort; the coordinator's KV TTL and verb idempotency are the backstop.
- **Control-plane model ids are deployment facts** — `resume` uses the triggering ordinary request's model, while `compact`/`stop` use the last observed ordinary-request model (or the first catalog entry). The id must match an AIGW-configured model id; a mismatched id fails open with a warning and no cache effect.
