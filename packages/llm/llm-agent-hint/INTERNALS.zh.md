# llm-agent-hint：构建、安装、使用与数据流详解

本文面向需要接入或调试 MindIE-Motor coordinator 的开发者，完整说明 `@deepseek-ai/dsh-llm-agent-hint`（下称 llm-agent-hint）的构建方式、安装挂载、配置使用，以及 `agent_hint` 字段的填充流程与请求转发流程。所有行为描述均以当前源码为准，文末给出源码索引。

## 1. 包定位

llm-agent-hint 是一个**可选（opt-in）的 Cordis 函数插件**，面向 MindIE-Motor coordinator（协调器）提供 DeepSeek 兼容传输。它在 `llm-deepseek` 管线（直接 `fetch` + SSE、同一套协议序列化 / 转换 / 错误码）之上叠加两层能力：

- **数据面（data plane）**：普通生成请求携带 `agent_hint` 字段（会话身份、fork 谱系、缓存策略），供 coordinator 做按会话路由与 KV-cache 复用。
- **控制面（control plane）**：harness 会话生命周期与首个普通请求驱动独立的 `session_control` 管理请求（`resume` / `compact` / `stop`）。

插件拥有自己的提供方路由 `deepseek-agent-hint`，绝不触碰 `deepseek-official` 路由；不挂载本包时，系统退化为普通的 `llm-deepseek`。

```
┌──────────────┐   session/created(record) + 首个普通请求(resume) / compaction/end(compact) / session/disposed(stop)
│ harness 会话 │ ─────────────────────────────────────────────────────────┐
│   生命周期   │                                                          ▼
└──────────────┘                                        LifecycleBridge（事件→动词）
        │ 普通生成请求（GenerateOptions）                            │ 空消息管理请求
        ▼                                                    ▼
  AgentHintAdapter（继承 DeepSeekAdapter）            SessionControlClient
        │ ① pendingOp 屏障  ② buildAgentHint 注入              │
        ▼                                                    ▼
  POST ${baseURL}/chat/completions  +  agent_hint 字段 ──► MindIE-Motor coordinator
        ▲                                                    │
        └────────────── SSE 流式响应 ◄────────────────────────┘
```

## 2. 构建

### 2.1 前置条件

- Node `^22.19.0 || >=24.0.0`，pnpm `11.7.0`（仓根 `packageManager` 固定）。
- 本包是 pnpm workspace 成员（`packages/llm/llm-agent-hint`），**没有独立的构建脚本**，构建由仓根统一驱动。

### 2.2 构建命令（仓根执行）

```bash
pnpm install                  # 链接 workspace 依赖
npm run build:lib:host        # tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host
npm run build                 # 全量：host + client + web（本包只参与 host 面）
```

本包只注册在聚合工程 `tsconfig.host.json`（host face），不参与 client 面。

### 2.3 构建产物

构建分两步，产物都落在包内 `lib/`：

| 步骤 | 工具 | 输入 | 输出 |
|---|---|---|---|
| 类型构建 | `tsc -b tsconfig.host.json`（项目引用） | `src/*.ts` | `lib/types/*.js` + `lib/types/**/*.d.ts` |
| 入口打包 | `tsdown --env.DSH_BUILD_FACE host`（仓根 `tsdown.config.ts`） | `lib/types/{index,invariant}.js` | `lib/index.js`、`lib/invariant.js`（ESM / node / es2024，不生成 d.ts） |

包的 [tsconfig.json](tsconfig.json) 继承 `tsconfig.base.json`，`rootDir: src`、`outDir: lib/types`，并通过 project references 声明对 12 个 workspace 依赖（cordis、llm、llm-deepseek、session、compaction、credentials、launch-environment、settings、invariants、timeout、anonymous-user-id 及 vendor）的构建顺序。

`package.json` 的导出映射决定了消费方式：

| 子路径 | 指向 | 用途 |
|---|---|---|
| `.` | `lib/index.js`（类型 `lib/types/index.d.ts`） | 插件主入口（Loader 挂载用） |
| `./invariant` | `lib/invariant.js` | 包级 invariant 伴生插件 |
| `./src/*` | 原始 TS 源码 | 仓内测试 / 源码级导入 |
| `./package.json` | `package.json` | 元数据 |

发布清单（`files`）只含 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.d.ts`。

### 2.4 辅助命令

```bash
npm run typecheck             # 含 build:lib:host，再跑 client 契约检查
npm run lint                  # oxlint（contracts-ready 前置）
npx vitest run packages/llm/llm-agent-hint   # 本包单测（见 §7）
```

## 3. 安装与挂载

### 3.1 仓内安装

`pnpm install` 即完成。本包对 harness 各服务包的依赖全部是 `workspace:^` peer 依赖（compaction、credentials、invariants、launch-environment、llm、llm-deepseek、session、settings、timeout、anonymous-user-id、cordis），唯一运行时依赖是 `@deepseek-ai/schemastery`（Config schema 校验）。

### 3.2 挂载为插件（opt-in）

本包**不在任何默认组合里**，需要在 harness 的插件配置（cordis.yml 形式的插件列表）中显式挂载：

```yaml
- id: llm-agent-hint
  name: '@deepseek-ai/dsh-llm-agent-hint'
  config:
    provider: deepseek-agent-hint   # 路由 id，仅加载期读取（改它需要重载插件）
    apiKeyEnv: MOTOR_API_KEY        # 默认值；逐请求经 ctx.credentials 解析，其次启动环境
    baseURL: http://127.0.0.1:1025/v1  # 本地 coordinator 默认值；/v1 前缀必填
    models:                         # 可选；镜像 coordinator 的 /v1/models（建议性目录）
      - id: deepseek-v4-flash
        name: DeepSeek-V4-Flash
    agentHint:
      enabled: true                 # 主开关（语义见 §5.4 注意事项）
      cacheControl:                 # 可选静态策略，逐字复制进每个 hint
        type: default
      sessionControl:
        enabled: true               # 关闭则不发管理请求
        pendingOpAwaitMs: 2000      # 普通请求等待在途动词的上限
        controlTimeoutMs: 5000      # 单次管理请求超时
        retries: 1                  # 首次失败后的传输级重试次数
```

插件声明 `inject: ['llm']`，必须存在 `llm` 服务才能加载。挂载成功后：

- 在 `ctx.llm` 上注册提供方路由 `deepseek-agent-hint`（适配器为 `AgentHintAdapter`）；若已有其他适配器占用该路由，注册抛 `LlmError('DUPLICATE_ADAPTER')`。
- 该路由出现在 `ctx.llm.listConfigurableProviders()`，显示名 `DeepSeek (agent-hint)`，settings 命名空间 `llm-agent-hint`。

### 3.3 凭据准备

API 密钥按 `apiKeyEnv`（默认 `MOTOR_API_KEY`）**逐请求**解析，顺序为：

1. credentials 服务（`ctx.get('credentials').resolve(ref)`，Web 端 Models 页面写入的值）；
2. 启动环境变量（launch environment）中的同名变量；
3. 两者皆无 → 抛 `LlmError('MISSING_CREDENTIAL')`。

## 4. 使用

### 4.1 配置项总览

传输字段与 `llm-deepseek` 完全一致，经由同一套 settings / credentials 机制逐请求解析：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `provider` | `deepseek-agent-hint` | 提供方路由 id；注册期捕获，改动需重载 |
| `apiKeyEnv` | `MOTOR_API_KEY` | 凭据引用（环境变量名） |
| `baseURL` | `http://127.0.0.1:1025/v1` | coordinator 端点，**必须含 `/v1`**（适配器追加 `/chat/completions`） |
| `thinking` | — | 部署级思考策略；`disabled` 把所有会话请求限制为 `off` |
| `reasoningEffort` | `high` | 默认思考力度（`off` / `high` / `max`） |
| `maxTokens` | `256000` | 默认单请求输出上限 |
| `defaultContextWindow` | `1000000` | 模型无精确值时的上下文容量 |
| `models` | `[]` | 建议性模型目录；未列出的模型 id 仍原样放行 |
| `streamIdleTimeoutMs` | `300000` | 单次流读挂起时的空闲超时 |
| `retryPolicy` | 常规默认 | 提供方模型请求重试策略 |
| `agentHint.enabled` | `true` | 主开关（当前实际语义见 §5.4） |
| `agentHint.cacheControl` | — | 静态缓存策略，逐字进入每个 hint |
| `agentHint.sessionControl.enabled` | `true` | 控制面开关；`false` 停发管理请求 |
| `agentHint.sessionControl.pendingOpAwaitMs` | `2000` | pendingOp 屏障等待上限 |
| `agentHint.sessionControl.controlTimeoutMs` | `5000` | 单次管理请求超时 |
| `agentHint.sessionControl.retries` | `1` | 管理请求传输级重试（0–10） |

### 4.2 运行时语义

- **settings 热更新**：插件把自身 Config 注册为 `llm-agent-hint` settings 区段；传输字段（模型目录、超时、重试等）可在线调整，逐请求重新解析。解析失败时保留**上一份可用配置**并记录 error。
- **注册期捕获**：`provider` 与 `baseURL` 在插件加载时读取一次，settings 中改动它们需要重载插件。重试策略变化时通过 `registration.replace()` 同步注册表。
- **`/v1` 前缀校验**：加载时若 `baseURL` 不以 `/v1` 结尾，记录警告——缺失前缀会把普通请求与控制请求都发到 404。
- **选择路由**：业务侧在 provider 选择处使用 `deepseek-agent-hint` 路由（与选择 `deepseek-official` 的方式一致），模型 id 原样传给 coordinator。

### 4.3 降级与互斥

- 不挂载本包 → 无 `deepseek-agent-hint` 路由，`llm-deepseek` 行为不变。
- `sessionControl.enabled: false` → 不创建 LifecycleBridge，只发普通请求（注意 §5.4）。
- 客户端从不同时发出 `session_control` 与 `context_management`：单动词枚举在结构上保证互斥。
- 旧 coordinator 不支持 `session_control`：随请求捎带的 `start` 落入 `raw_extra`（无害）；管理动词返回 HTTP 400，fail-open 只记警告。

## 5. agent_hint 字段填充流程（数据面）

### 5.1 总体流程

每个生成请求进入 [AgentHintAdapter.stream()](src/adapter.ts)，注入发生在**序列化与上线之间**：

```
GenerateOptions
  │
  ├─① bridge.ensureResume(sessionId, model) 种子会话首次普通请求前，补发一次
  │                                          resume 管理请求（每个会话仅一次）
  ├─② bridge.awaitPendingOp(sessionId)      控制面屏障：同一会话若有在途管理动词，
  │                                          最多等 pendingOpAwaitMs，超时放行（fail-open）
  ├─③ bridge.facts(sessionId)               读取会话状态：seeded / firstOrdinarySent /
  │                                          parentSessionId（来自 LifecycleBridge 内存表）
  ├─④ buildAgentHint({...})                 纯函数决策：产出 wire 对象或 undefined
  ├─⑤ bridge.noteOrdinaryRequest(sid, model) hint 非空时：翻转 firstOrdinarySent、
  │                                          记录 lastModel（供控制面复用）
  ├─⑥ serializeRequest(options, defaults)   llm-deepseek 原生序列化（不含 hint）
  ├─⑦ body.agent_hint = hint                ←—— 唯一的注入点
  └─⑧ POST ${baseURL}/chat/completions      进入 §6.1 转发
```

### 5.2 buildAgentHint 判定规则

[buildAgentHint](src/agent-hint.ts) 是唯一拥有全部纳入规则的纯函数（可脱离 coordinator 单测）：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `purpose` 已定义（`compaction`、`session-title` 等后台调用） | 返回 `undefined`——后台调用不得扰动活跃会话的 KV-cache 身份 |
| 2 | `sessionId` 未定义 | 返回 `undefined`——匿名请求完全不携带 `agent_hint` |
| 3 | — | 必含 `session_id` |
| 4 | `parentSessionId` 存在 | 附加 `parent_session_id`（fork / 压缩接续谱系） |
| 5 | 配置了 `cacheControl` | 附加 `cache_control`（逐字复制） |
| 6a | 调用方显式捎带动词 | 附加 `session_control: {type: <动词>}`（当前仅测试路径使用） |
| 6b | 否则，会话**非种子**且**首个**普通请求 | 附加 `session_control: {type: 'start'}` |
| 6c | 否则（种子会话，或已发过普通请求） | 不附加 `session_control` |

关键状态由 LifecycleBridge 维护：

- `seeded`：`session/created` 时，`firstLiveSeq` 之前至少存在一个 `turn/start`，即会话带着真实对话历史创建（resume / fork / replay）。**种子会话绝不声明 `start`**——它会在首个普通请求前由 `ensureResume` 补发一次 `resume` 管理请求。日志里只有 `session/end-seed` 标记的空白持久化会话仍算新会话。
- `firstOrdinarySent`：hint 非空的普通请求发出后翻转；后台调用（purpose 非空）与匿名请求**不消耗**该名额。

### 5.3 产出示例

```jsonc
// 新会话首个普通请求（未配置 cacheControl）
{ "session_id": "s-1", "session_control": { "type": "start" } }

// 同一会话第二个普通请求
{ "session_id": "s-1" }

// fork 出的种子会话（配置了 cacheControl）
{ "session_id": "s-2", "parent_session_id": "s-1", "cache_control": { "type": "default" } }
```

### 5.4 注意事项（以代码为准）

`agentHint.enabled: false`（或 `sessionControl.enabled: false`）在当前实现中**只关闭控制面**：LifecycleBridge 不创建，管理请求停发；但适配器仍会注入 `agent_hint`。且由于没有 bridge 翻转 `firstOrdinarySent`，此时同一会话的**每个**普通请求都会重复携带 `session_control: {type: 'start'}`。README 中"false 退化为普通 DeepSeek 传输"的表述与当前代码存在出入，接入前请以本节为准（或先修复该开关的数据面语义）。

## 6. 转发流程

### 6.1 数据面：普通请求的组装与转发

[requestWithHint](src/adapter.ts) 复用 `llm-deepseek` 的 wire 层（`serializeRequest` / `parseSse` / `translate` / `httpErrorCode`），只多盖一个字段：

1. **请求体**：`serializeRequest(options, connection.defaults)` 产出标准 chat-completions body，随后 `body.agent_hint = hint`（可能为 undefined，即不携带），整体 `JSON.stringify`。
2. **请求头**：
   - `authorization: Bearer <apiKey>`（逐请求解析，见 §3.3）
   - `content-type: application/json`、`accept: text/event-stream`
   - `attributionHeaders()`（归因头）
   - `x-deepseek-harness-user-id`（匿名用户 id，首次解析后缓存）
   - `x-deepseek-harness-session-id`（携带会话的请求）
   - `x-deepseek-harness-compact: 1`（仅 `purpose: 'compaction'` 的后台请求）
3. **发送**：`fetch POST ${baseURL}/chat/completions`，信号为调用方 `options.signal` 与内部消费控制器取并集；空闲看门狗（`streamIdleTimeoutMs`）在每个 SSE 注释处续期。
4. **响应处理**：
   - 非 2xx：解析错误 body 中的 `error.message`，映射 `httpErrorCode(status, providerError)`，透传 `retry-after` 与 `x-request-id`，抛 `LlmError`。
   - 2xx：`parseSse` 逐事件解析 → `translate` 转成 `StreamChunk` 流式产出。
   - 空闲超时 → `LlmError('TIMEOUT')`；调用方中止 → `ABORTED`；传输失败 → `TRANSPORT`。

### 6.2 控制面：生命周期事件到管理请求

[LifecycleBridge](src/lifecycle-bridge.ts) 通过 `subscribe(ctx)` 注册三个 **global** 监听器（随插件作用域自动销毁）：

| harness 事件 | 触发条件 | 动词 | coordinator 翻译 | 屏障 |
|---|---|---|---|---|
| `session/created` | `firstLiveSeq > 0`（种子会话） | 仅记录 `seeded` | — | 不发送请求 |
| 首个普通请求 | 会话为种子且尚未 `resume` | `resume` | 预取该会话 KV cache | 记入 pendingOp |
| 输入框草稿变为非空 | 会话已暂停且尚未 `resume` | `resume` | 预取该会话 KV cache | 记入 pendingOp |
| 前台会话切换离开 | 上一个会话已发过普通请求且进入 idle | `pause` | 卸载上一个会话 KV cache | fire-and-forget |
| `session/event` | `compaction/end` 且无 error | `compact` | 新身份下驱逐并重建 | 记入 pendingOp |
| `session/disposed` | — | `stop` | 驱逐 | fire-and-forget |
| `workspace/session-archived` | 归档会话成功 | `stop` | 驱逐 | fire-and-forget |

[SessionControlClient.send](src/control-client.ts) 把动词转成一条独立请求：

1. **`start` 拒发**：`start` 只随数据面首个普通请求捎带；空 messages 的 `start` 在 coordinator 侧无效果，独立发送只会记警告。
2. **请求体**：`{ model, messages: [], stream: false, agent_hint: { session_id, session_control: { type: verb } } }`——复用数据面端点与凭据的空 messages 非流式 chat-completions 请求。
   - `resume` 的 `model` 取触发它的那条普通请求的模型 id；`compact`／`stop` 的 `model` 取该会话**最近一次普通请求的模型 id**（bridge 记录的 `lastModel`），无记录回退到目录首个条目（再无则 `'default'`）。该 id 必须与 coordinator AIGW 实际服务的模型 id 匹配，否则无缓存效果（fail-open 记警告）。
3. **重试与超时**：单次尝试超时 `controlTimeoutMs`（`AbortSignal.timeout`）；失败后固定间隔 200ms 重试至多 `retries` 次。一次有界重试覆盖 coordinator 重启的连接抖动窗口，其余失败对该动词终结。
4. **fail-open**：任何失败（传输 / 超时 / 非 2xx）只通过 warn sink 记录警告，**绝不 reject**——控制请求是建议性的，不得把 harness 生命周期事件变成用户可见错误。

**pendingOp 屏障**：`resume` / `compact` 发出期间，同一会话的普通请求在序列化前 `awaitPendingOp` 等待（上限 `pendingOpAwaitMs`），超时放行并记警告；`stop` 与 `pause` 不设屏障（处置或切换离开不得阻塞前台会话）；无在途操作时屏障是零开销 no-op。

## 7. 本地验证与测试

本包测试全部走仓根 vitest（`vite-tsconfig-paths` 把 workspace 源码映射到内置 `lib/` 之上，测试直接导入 `../src/*.ts`）：

```bash
npx vitest run packages/llm/llm-agent-hint
```

| 测试文件 | 覆盖 |
|---|---|
| [tests/agent-hint.spec.ts](tests/agent-hint.spec.ts) | `buildAgentHint` 全部纳入规则（纯函数） |
| [tests/adapter.spec.ts](tests/adapter.spec.ts) | 适配器对 mock server 的 wire 断言（start 声明、后台豁免、cache_control 透传、seeded 不重声明、会话头） |
| [tests/control-client.spec.ts](tests/control-client.spec.ts) | 管理请求的动词 / 重试 / 超时 / fail-open |
| [tests/lifecycle-bridge.spec.ts](tests/lifecycle-bridge.spec.ts) | 事件→动词路由、屏障、状态翻转 |
| [tests/mock-server.ts](tests/mock-server.ts) | 本地 chat-completions 替身：按脚本回放 SSE / HTTP 错误 / 提前断连 |

端到端联调时，将 `baseURL` 指向真实 coordinator（记住 `/v1` 前缀），凭据放入 `MOTOR_API_KEY`，即可观察请求体中的 `agent_hint` 与生命周期触发的管理请求。

## 8. 源码索引

| 文件 | 职责 |
|---|---|
| [src/index.ts](src/index.ts) | 插件入口：Config schema、settings 区段、路由注册、bridge / client 装配 |
| [src/adapter.ts](src/adapter.ts) | `AgentHintAdapter`：继承 DeepSeekAdapter，屏障 + hint 注入 + 转发 |
| [src/agent-hint.ts](src/agent-hint.ts) | `buildAgentHint`：hint 字段的唯一决策点（纯函数） |
| [src/lifecycle-bridge.ts](src/lifecycle-bridge.ts) | `LifecycleBridge`：会话事件→控制动词路由 + 每会话状态 + pendingOp 屏障 |
| [src/control-client.ts](src/control-client.ts) | `SessionControlClient`：管理请求传输（fail-open、有界重试） |
| [src/types.ts](src/types.ts) | wire 类型：`AgentHintWire`、`SessionControlVerb` |
| [src/invariant.ts](src/invariant.ts) | 包级 invariant 伴生插件（无运行时不变量声明） |
