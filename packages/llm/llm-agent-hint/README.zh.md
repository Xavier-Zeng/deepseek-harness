# @deepseek-ai/dsh-llm-agent-hint

[English](README.md) | 中文

面向 MindIE-Motor coordinator（协调器）的 DeepSeek 兼容传输：包装 `llm-deepseek` 管线（直接 `fetch` + SSE，同一套协议序列化、转换与错误码），使普通请求携带 coordinator 的 `agent_hint` 字段，并让 harness 会话生命周期事件驱动独立的 `session_control` 管理请求。本包是可选（opt-in）的——它拥有自己的提供方路由，绝不触碰 `deepseek-official` 路由；不挂载本包则退化为普通的 `llm-deepseek`。

一个插件内含两个平面。**数据面（data plane）** 是纯注入：`buildAgentHint` 逐请求决定协议 body 是否携带 `session_id`（连同 fork（分叉）谱系与静态缓存策略），以及新会话的首个普通请求是否声明 `session_control: start`。**控制面（control plane）** 是生命周期桥：种子（seeded）会话的 `session/created` 请求 `resume` 预取，成功的 `compaction/end` 请求 `compact`，`session/disposed` 请求终结性的 `stop`——每个动词都是一条空 messages 的 chat-completions 请求，其 `agent_hint.session_control` 动词由 coordinator 翻译为上下文管理操作。控制请求是建议性的并 fail-open（失败放行）：失败只记录警告，绝不拒绝触发它的 harness 工作。

包根入口导出 Cordis 插件约定、`AgentHintAdapter`、`buildAgentHint`、`SessionControlClient` 与 `LifecycleBridge`；协议类型（`AgentHintWire`、`SessionControlVerb`）供测试与集成使用。

## 配置

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

**`/v1` 注意事项**：继承的 DeepSeek 传输会 POST `${baseURL}/chat/completions`，因此 coordinator 的 `baseURL` 必须包含 `/v1` 前缀。缺失前缀会把普通请求与控制请求都发往 404；插件在加载时检测到缺失会记录警告。传输字段（`thinking`、`reasoningEffort`、`maxTokens`、`defaultContextWindow`、`streamIdleTimeoutMs`、`retryPolicy`）与 `llm-deepseek` 完全一致，并经由同一套 settings／credentials 机制逐请求解析（`settingsNs: llm-agent-hint`；API 密钥逐请求解析，默认从 `MOTOR_API_KEY`）。

提供方路由默认为 `deepseek-agent-hint`，且在注册期捕获：为它注册另一个适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`；settings 中更改 `provider` 或 `baseURL` 需要重载插件。该路由还会出现在 `ctx.llm.listConfigurableProviders()`（显示名 `DeepSeek (agent-hint)`）；`models` 会像 `llm-deepseek` 一样公布建议性 catalog——未列出的模型 id 仍原样传递。

## 数据面规则

`buildAgentHint` 按顺序拥有全部纳入规则：

1. 携带已定义 `purpose`（`compaction`、`session-title` 等）的请求保持无前缀——后台调用不得扰动活跃会话的 KV-cache 身份。
2. 不带 `sessionId` 的请求保持匿名（完全不携带 `agent_hint`）。
3. 只要会话带 fork 谱系创建，就附加 `parent_session_id`；只要配置了 `cache_control` 就附加之。两者也会随携带动词的请求同行。
4. `session_control: {type: 'start'}` 只随**新**（非种子）会话的首个普通请求同行；种子会话（resume／fork／replay）绝不声明 `start`。

客户端从不同时发出 `session_control` 与 `context_management`——单动词枚举使互斥规则在结构上不可能违反。在不支持 `session_control` 的旧 coordinator 上，随请求捎带的 `start` 落入 `raw_extra`（无害），管理动词返回 HTTP 400，fail-open 并记录警告。

## 控制面

| harness 事件 | 动词 | coordinator 翻译 |
|---|---|---|
| `session/created`（种子） | `resume` | 预取该会话的 KV cache |
| `compaction/end`（成功） | `compact` | 在新身份下驱逐并重建 |
| `session/disposed` | `stop` | 驱逐 |
| 首个普通请求（新会话） | `start` | 声明存活（仅随请求捎带，绝不独立发送） |

管理请求复用数据面的端点与凭据：一条空 messages、非流式的 chat-completions 请求，其 `agent_hint.session_control` 指明动词。每个请求携带该会话最近观测到的模型 id（回退到首个 catalog 条目）——它必须与 coordinator 的 AIGW 所服务模型 id 匹配。一次有界重试覆盖 coordinator 重启造成的连接抖动窗口；其余失败对该动词均为终结性。`stop` 是 fire-and-forget（发起即忘；处置不得阻塞 teardown）；`resume` 与 `compact` 另外布防 **pendingOp 屏障**：同一会话的普通请求在序列化前会等待进行中的动词——最多 `pendingOpAwaitMs`——然后照常进行（fail-open）。没有挂起操作时屏障是 no-op，零额外延迟。

## 模型体验

无。该包装层只在已组装的请求上加盖对模型隐藏的传输元数据；它不注册任何属于自己的提示词、schema 或消息。

#### KV Cache 影响

对已组装前缀透传：注入的 `agent_hint` 位于模型可见内容之外，未变化的会话前缀保持可被 coordinator 的 KV-cache 复用，恰如底层 DeepSeek 传输所报告的那样。会话身份变化（fork、压缩接续）或控制动词会选择不同的服务端缓存域；coordinator 侧的驱逐与 TTL 不在本包契约内。

## 已知限制与暂缓事项

- **在 coordinator 的 V1 设计下，管理请求仍会产生一次极小的生成**——空 messages 请求会跑一遍 chat 管线；操作极少（每次生命周期转换一次），在出现 coordinator 侧成本顾虑之前，暂缓用 `max_tokens: 1` 封顶的实验。
- **空闲 `pause` 暂缓**——v1 交付 `start`／`resume`／`compact`／`stop`；`pause` 需要空闲看门狗、pause/resume 状态跟踪，以及 v1 未定义的空闲判定策略。
- **`session/disposed` 可能与进程 teardown 竞态**——终结性 `stop` 是尽力而为；coordinator 的 KV TTL 与动词幂等性是兜底。
- **控制面模型 id 是部署事实**——最近观测到的普通请求模型（或首个 catalog 条目）必须与 AIGW 配置的模型 id 匹配；不匹配的 id 会 fail-open 记录警告，且无缓存效果。
