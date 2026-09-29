---
description: "agent_hint session hints and lifecycle control for MindIE-Motor coordinators."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-agent-hint

[English](README.md) | 中文

## 概述

注册 `deepseek-agent-hint` 提供方路由：面向 MindIE-Motor coordinator 的 [Messages 传输](../llm-deepseek/README.zh.md)，其普通请求携带 coordinator 的 `agent_hint` 字段，并由 harness 会话生命周期事件驱动独立的 `session_control` 管理请求。本包为可选（opt-in）——它拥有自己的路由，绝不触碰 `deepseek-official`。

一个插件承载两个平面。**数据面**是路由级的 `prepareExtensions`：`buildAgentHint` 逐请求判定 wire 请求体是否携带 `session_id`（外加 fork 谱系与静态缓存策略），以及新会话的首个普通请求是否声明 `session_control: start`；`start` 记账仅在端点接受该请求后提交。**控制面**是生命周期桥：带历史会话的首个普通请求（或编辑器草稿）请求 `resume` 预取；成功的 `compaction/end` 请求 `compact`；`session/disposed` 与 `workspace/session-archived` 请求 `stop`；前台会话切走时，待前一个会话进入空闲后请求 `pause`。管理请求是建议性的并失败开放（fail-open）：失败仅记录警告，绝不拒绝触发它的 harness 工作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

<a id="use-this-package"></a>
## 使用本包

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

`apiKeyEnv` 默认 `MOTOR_API_KEY` 并逐请求解析；缺失凭据以 `MISSING_CREDENTIAL` 失败。其余传输字段（`thinking`、`reasoningEffort`、`maxTokens`、`defaultContextWindow`、`streamIdleTimeoutMs`、`retryPolicy`、图像与 Files 预算）与 `llm-deepseek` 完全一致，经同一套 volatile 配置机制逐请求解析。该路由以 `DeepSeek (agent-hint)` 出现在 `ctx.llm.listConfigurableProviders()`；`models` 发布建议性目录，未列出的模型 id 仍原样透传。

数据面规则由 `buildAgentHint` 按序拥有：带定义 `purpose` 的调用（`compaction`、`session-title`）保持无前缀；匿名请求保持无前缀；`parent_session_id` 与 `cache_control` 在已知时随时附加，包括携带动词的请求；`session_control: start` 只搭在新会话首个被接受的普通请求上，带历史会话（创建时已有模型可见 surface 历史）永不声明 `start`。空白持久化会话没有 surface 历史，仍为新鲜会话并声明 `start`。

控制面路由：

| harness 事件 | 动词 | coordinator 翻译 |
|---|---|---|
| 首个普通请求（带历史会话） | `resume` | 预取该会话的 KV cache |
| 输入框草稿变为非空 | `resume` | 在下次提示前预取已暂停会话的 KV cache |
| 前台会话切换离开 | `pause` | 上一个会话进入空闲后卸载其 KV cache |
| `compaction/end`（成功） | `compact` | 在新身份下驱逐并重建 |
| `session/disposed` | `stop` | 驱逐 |
| `workspace/session-archived` | `stop` | 驱逐已归档会话 |
| 首个普通请求（新会话） | `start` | 声明存活（仅随请求捎带，绝不独立发送） |

管理请求是空 messages、非流式的 chat-completions 请求，其 `agent_hint.session_control` 指明动词，POST 到 `sessionControl.endpoint`。`resume` 携带触发请求的模型 id；`compact` 与 `stop` 携带会话最近观测到的模型 id，缺省回退到目录首项。`stop` 与 `pause` 为发后即忘；`resume` 与 `compact` 额外武装 pendingOp 屏障：同一会话的普通请求在序列化前等待在途动词——上限 `pendingOpAwaitMs`——随后照常继续（失败开放）。

<a id="understand-the-implementation"></a>
## 理解实现

数据面通过 `DeepSeekAdapterOptions.prepareExtensions` 与共享传输组合：路由实现链接全局扩展注册表、注入 `agent_hint`，并搭乘扩展的 `accept` 事务，使只有被端点接受的请求才推进 `start` 记账与前台会话跟踪。注册与监听随插件释放；共享 Host 接线提供附件、匿名身份与原子化重试策略更新。本包不发布 invariant 伴生包：桥接跟踪的状态源自权威的会话、代理与工作区事件流，不存在独立副本。

<a id="further-exploration"></a>
## 延伸阅读

[Messages](../llm-deepseek/README.zh.md) · [DeepSeek LLM API 扩展](../deepseek-llm-api-extensions/README.zh.md)

<a id="model-experience"></a>
## 模型体验

无：本插件把模型不可见的传输元数据加盖到已组装完成的请求上，不注册任何自己的提示词、schema 或消息。

#### KV 缓存影响

注入的 `agent_hint` 位于模型可见内容之外，未变化的会话前缀与底层 Messages 传输所报告的完全一致地保持 coordinator KV 缓存复用资格。会话身份变更（fork、压缩续接）或控制动词会选择不同的服务端缓存域；coordinator 侧的逐出与 TTL 不在本包范围内。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- 在 coordinator 的 V1 设计下，管理请求仍有一次极小的生成开销——空 messages 请求会走聊天管线；以 `max_tokens: 1` 封顶在 coordinator 侧成本问题显现前暂缓。
- 基于定时器的空闲 `pause` 暂缓——`pause` 现在于前台会话从已运行过轮次的会话切走、且该会话进入空闲后触发；空闲定时器策略尚未定义。
- `session/disposed` 可能与进程退出竞争——终态 `stop` 是尽力而为；coordinator 的 KV TTL 与动词幂等性是兜底。
- 控制面的模型 id 是部署事实——id 不匹配时以警告失败开放，无缓存效果。

<a id="dev-note"></a>
## 开发说明

单元测试覆盖 hint 纳入规则、生命周期路由、控制面 wire 与扩展缝（屏障时序、注入、accept 时记账）；共享传输行为由 `llm-deepseek` 的测试覆盖。
