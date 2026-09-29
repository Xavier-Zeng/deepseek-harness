---
description: "agent_hint session hints and lifecycle control for MindIE-Motor coordinators."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-agent-hint

English | [中文](README.zh.md)

## Summary

Register the `deepseek-agent-hint` provider route: the [Messages transport](../llm-deepseek/README.md) aimed at a MindIE-Motor coordinator, whose ordinary requests carry the coordinator's `agent_hint` field and whose harness session lifecycle events drive standalone `session_control` manage requests. The package is opt-in — it owns its own route and never touches `deepseek-official`.

Two planes ship in one plugin. The **data plane** is a route-scoped `prepareExtensions`: `buildAgentHint` decides per request whether the wire body carries `session_id` (plus fork lineage and a static cache policy) and whether the first ordinary request of a fresh session declares `session_control: start`; the `start` bookkeeping commits only after the endpoint accepts the request. The **control plane** is a lifecycle bridge: a seeded session's first ordinary request (or composer draft) requests a `resume` prefetch, a successful `compaction/end` requests a `compact`, `session/disposed` and `workspace/session-archived` request a `stop`, and moving the foreground session away requests a `pause` once the previous session reaches idle. Control requests are advisory and fail open: a failure logs a warning and never rejects the harness work that triggered it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

```yaml
- id: llm-agent-hint
  name: '@deepseek-ai/dsh-llm-agent-hint'
  config:
    provider: deepseek-agent-hint   # route id; changing it requires a reload
    apiKeyEnv: MOTOR_API_KEY        # default; resolved per request via the credentials service, then the environment
    baseURL: http://127.0.0.1:1025  # default local coordinator Messages root; the transport appends /v1/messages
    models:                         # optional; advisory catalog mirroring the coordinator's served models
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
    agentHint:
      enabled: true                 # master switch; false degrades to plain Messages transport
      cacheControl:                 # optional static policy copied verbatim into every hint
        type: default
      sessionControl:
        enabled: true               # false disables manage requests; the data plane keeps working
        endpoint: http://127.0.0.1:1025/v1/chat/completions # optional; defaults to <baseURL>/v1/chat/completions
        pendingOpAwaitMs: 2000      # how long an ordinary request waits for an in-flight verb
        controlTimeoutMs: 5000      # per-attempt control-request timeout
        retries: 1                  # transport-level retries after the first failed attempt
```

`apiKeyEnv` defaults to `MOTOR_API_KEY` and resolves per request; missing credentials fail with `MISSING_CREDENTIAL`. The remaining transport fields (`thinking`, `reasoningEffort`, `maxTokens`, `defaultContextWindow`, `streamIdleTimeoutMs`, `retryPolicy`, image and Files budgets) mirror `llm-deepseek` exactly and resolve per request through the same volatile-configuration machinery. The route appears in `ctx.llm.listConfigurableProviders()` as `DeepSeek (agent-hint)`; `models` advertises an advisory catalog and unlisted model ids still pass through unchanged.

Data plane rules, owned by `buildAgentHint` in order: defined `purpose` calls (`compaction`, `session-title`) stay unprefixed; anonymous requests stay unprefixed; `parent_session_id` and `cache_control` attach whenever known, including on verb-carrying requests; `session_control: start` rides only the first accepted ordinary request of a fresh session, and a seeded session (one created with model-visible surface history) never declares `start`. A blank persisted session has no surface history, stays fresh, and declares `start`.

Control plane routing:

| Harness event | Verb | Coordinator translation |
|---|---|---|
| first ordinary request (seeded) | `resume` | prefetch the session's KV cache |
| composer draft becomes non-empty | `resume` | prefetch a paused session before the next prompt |
| foreground session changes away | `pause` | offload the previous session's KV cache once idle |
| `compaction/end` (success) | `compact` | evict and rebuild under the new identity |
| `session/disposed` | `stop` | evict |
| `workspace/session-archived` | `stop` | evict the archived session |
| first ordinary request (fresh) | `start` | declare liveness (piggybacked, never standalone) |

Manage requests are empty-messages, non-streaming chat-completions requests whose `agent_hint.session_control` names the verb, posted to `sessionControl.endpoint`. `resume` carries the triggering request's model id; `compact` and `stop` carry the session's last observed model id, falling back to the first catalog entry. `stop` and `pause` are fire-and-forget; `resume` and `compact` additionally arm a pendingOp barrier: an ordinary request for the same session waits — up to `pendingOpAwaitMs` — for the in-flight verb before serializing, then proceeds anyway (fail-open).

<a id="understand-the-implementation"></a>
## Understand the implementation

The data plane composes with the shared transport through `DeepSeekAdapterOptions.prepareExtensions`: the route's implementation chains the global extension registry, injects `agent_hint`, and rides the extension `accept` transaction so only an endpoint-accepted request advances the `start` bookkeeping and foreground-session tracking. Registrations and listeners dispose with the plugin; shared Host wiring supplies attachments, anonymous identity, and atomic retry-policy updates. No invariant companion is published: the bridge's tracked state derives from authoritative session, agent, and workspace event streams without an independent copy.

<a id="further-exploration"></a>
## Further Exploration

[Messages](../llm-deepseek/README.md) · [DeepSeek LLM API extensions](../deepseek-llm-api-extensions/README.md)

<a id="model-experience"></a>
## Model Experience

None: the plugin stamps model-hidden transport metadata onto already-assembled requests and registers no prompt, schema, or message of its own.

#### KV Cache effect

The injected `agent_hint` rides outside model-visible content, and an unchanged session prefix stays eligible for the coordinator's KV-cache reuse exactly as the underlying Messages transport reports it. A session-identity change (fork, compaction continuation) or a control verb selects a different server-side cache domain; coordinator-side eviction and TTL remain outside this package.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Manage requests still cost a tiny generation under the coordinator's V1 design — the empty-messages request runs the chat pipeline; capping with `max_tokens: 1` is deferred until a coordinator-side cost concern materializes.
- Timer-based idle `pause` is deferred — `pause` fires when the foreground session changes away from a session that already ran a turn, after that session reaches idle; an idle-timer policy is not defined yet.
- `session/disposed` can race process teardown — the terminal `stop` is best-effort; the coordinator's KV TTL and verb idempotency are the backstop.
- Control-plane model ids are deployment facts — a mismatched id fails open with a warning and no cache effect.

<a id="dev-note"></a>
## Dev Note

Unit specs cover the hint inclusion rules, the lifecycle routing, the control wire, and the extension seam (barrier ordering, injection, accept-time bookkeeping); shared transport behavior is covered by the `llm-deepseek` specs.
