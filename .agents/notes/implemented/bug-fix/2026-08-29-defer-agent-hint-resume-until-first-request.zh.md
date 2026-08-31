# Agent Note: 将 agent-hint resume 延迟到首个普通请求

Status: implemented

[English](2026-08-29-defer-agent-hint-resume-until-first-request.md) | 中文

## Problem

`llm-agent-hint` 原先在 `session/created` 看到会话携带历史（`firstLiveSeq > 0`）时，就向 coordinator 发送一条 `resume` 管理请求。web 启动会在一瞬间恢复多个历史会话，因此挂载本插件后，用户尚未操作，每个被恢复的会话就各发一条 `resume`。这个宽泛判断还把日志里只有 `session/end-seed` 标记的空白持久化会话当成历史，于是被复用的空白新会话发送了 `resume`，而没有在首条请求上声明 `start`。这些请求虽是建议性的，但构成启动噪声，也与预取的本意相悖：为一个还没有被打开的会话预热 KV cache。

## Decision

`LifecycleBridge.onSessionCreated` 记录 seeded 标志与 fork 父会话。只有当构造历史在 `firstLiveSeq` 之前至少含有一个 `turn/start` 时，会话才被视为 seeded；日志里只有 `session/end-seed` 标记的空白持久化会话仍算新会话，且 `noteOrdinaryRequest` 不再翻转该标志，因此 `seeded` 在会话存续期内保持为构造事实。桥接器新增 `ensureResume(sessionId, model)`，由 `AgentHintAdapter.stream()` 在普通请求（`purpose` 未定义）经过既有 pending-op 屏障前调用。该方法按门条件 `(seeded || pauseSent) && !resumeSent` 在每个恢复周期只发送一次 `resume`，模型 id 取触发它的那条普通请求的模型 id，随后标记该会话已 resume，避免并发或后续请求重复发送。`pauseSent` 分支覆盖被暂停后回到前台的会话（其 KV 已被 `pause` offload），包括用户未编辑输入框直接提交的情况；`seeded` 分支覆盖创建时携带历史的会话。活跃的新会话两者皆不满足，因此在连续普通请求之间永不触发。后台用途请求仍不触发 `resume`，且普通请求仍通过既有屏障等待在途的 `resume`。

`compact` 与 `stop` 行为不变。该改动只位于 `@deepseek-ai/dsh-llm-agent-hint`。

## Alternatives considered

- **在启动宽限期内抑制 resume**——用定时器跳过启动突发，却无法区分窗口内用户的真实点击。否决：它把生命周期事实替换成墙上时钟，并需要面向部署的可调参数。
- **把 resume 移到 `agent/session-start` 且要求 `source: 'resume'`**——web 启动恢复与用户显式打开都会以相同 source 到达该事件。否决：该事件无法区分这两种情况。
- **保留 `session/created` 触发，仅按会话去重**——启动时仍会为每个被恢复会话各发一条请求。否决：无法消除启动突发。
- **把每个 `firstLiveSeq > 0` 的会话都视为 seeded**——原判断还会命中空白持久化会话。否决：空白会话没有需要预取的对话，且仍必须声明 `start`。

## Consequences

- 启动恢复不再扇出 `resume` 管理请求；只有 seeded 会话的首个普通请求才会发送。
- 空白持久化会话沿用新会话路径：其首个普通请求声明 `start`，不发送 `resume`。
- 活跃的新会话在连续普通请求之间不发送 `resume`；只有会话确实被 `pause` 过、或创建时携带历史时才发送。
- 被暂停的会话在下一个普通请求前发送一次新的 `resume`，即使用户未编辑输入框直接提交；composer-draft 路径只是同一动词的更早触发点。
- 恢复会话的第一条模型请求会通过未变的 pending-op 屏障短暂等待自己的 `resume`，随后 fail-open 放行。
- 延迟发送的 `resume` 使用触发它的普通请求的模型 id，而非该会话最近观测到的模型 id。
- `compact` 与 `stop` 继续使用最近观测到的模型 id。
