# Agent Note: 在切换离开的 agent-hint 会话空闲后发送 pause

Status: implemented

[English](2026-08-29-pause-switched-away-agent-hint-session.md) | 中文

## Problem

当用户从一个历史会话切到另一个历史会话时，coordinator 应在原会话的在途推理结束后卸载原会话的 KV cache。`llm-agent-hint` 已经支持 `pause` 控制动词，但此前没有任何逻辑在前台会话变化时发送它。

## Decision

`LifecycleBridge` 记录最后一个发送普通请求的会话。当另一个会话的普通请求到来时，桥接器把上一个会话标记为待 `pause`。如果该会话已经是 `idle`，就立即发送 `pause`；否则等待它的 `agent/status` 转为 `idle` 后再发送。会话重新活跃会取消待发送的 pause；处置或归档会清除待发送标记。

触发点是新会话的首个普通请求，而不是 UI 选择变化。后台用途请求（`compaction`、`session-title`）不会移动前台会话，也不会触发 pause。`pause` 请求是 fire-and-forget，不设 pending-op 屏障。

## Alternatives considered

- **由 web 客户端把选择变化发给 host**——新增 RPC 或事件会让“点击 B”成为触发点。本次否决：它跨越客户端运行时、API 代理与插件，而当前需求明确限定在 `llm-agent-hint`，且以 B 的首条消息为触发点。
- **在另一个会话开始时立即发送 `pause`**——原会话可能仍在运行，coordinator 会卸载仍活跃的缓存。否决：等待 idle 正是需求的语义。
- **复用 `agent/session-start` 推断切换**——启动恢复与显式打开都发出相同 source。否决：无法可靠区分二者。

## Consequences

- 从 A 切到 B 后，只有 B 发出首个普通请求，才会触发对 A 的 `pause`。
- 若此刻 A 仍在运行，`pause` 会等待 A 的 `running` → `idle` 转换。
- 在 pause 发出前回到 A，会清除待发送标记，避免过早卸载。
- A 再次活跃后，再次切换离开可以再次 pause A。
- `pause` 使用该会话最近观测到的模型 id，并像其他控制请求一样 fail-open。
