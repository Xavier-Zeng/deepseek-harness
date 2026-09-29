# Agent Note: 为归档的 agent-hint 会话发送 stop

Status: implemented

[English](2026-08-29-archive-stop-agent-hint-session.md) | 中文

## Problem

归档会话会把它从工作区分组界面隐藏，但 `llm-agent-hint` 此前没有通知 coordinator 驱逐该会话的 KV cache。被归档的会话可能一直保留到服务端自行驱逐。

## Decision

`WorkspaceRegistry.archiveSession` 在持久化归档写入成功后发出 `workspace/session-archived` 事件。`LifecycleBridge` 监听该事件，并对归档会话发送 fire-and-forget 的 `stop` 管理请求，使用该会话最近观测到的模型 id。会话可能仍存活并稍后被取消归档，因此桥接状态会保留。

## Alternatives considered

- **从 API 代理的 workspace handler 发出事件**——信号会更靠近 wire 层。否决：持久化 registry 是生命周期事实的自然所有者，并且对所有归档调用方有效，而不只是 web RPC。
- **复用 `session/disposed`**——归档不是处置；会话稍后可能被取消归档。否决：混用二者会丢弃桥接状态，并暗示错误的生命周期。

## Consequences

- 归档会话现在会发送一条建议性的 `stop`。
- 发送 `stop` 失败绝不影响归档操作。
- 稍后取消归档可以复用相同状态；再次归档可以再次发送 `stop`。
