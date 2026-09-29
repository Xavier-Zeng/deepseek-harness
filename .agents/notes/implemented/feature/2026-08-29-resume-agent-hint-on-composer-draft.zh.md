# Agent Note: 在已暂停 agent-hint 会话的输入框开始输入时发送 resume

Status: implemented

[English](2026-08-29-resume-agent-hint-on-composer-draft.md) | 中文

## Problem

`llm-agent-hint` 暂停了切换离开的会话后，用户再回到该会话时，需要等下一次普通请求才能让 coordinator 预取该会话的 KV cache。web 输入框其实已经知道用户回来了，但该信号只留在浏览器，没有到达 Host。

## Decision

web 输入框会把一次用户编辑把草稿从空变为非空这一信号，通过新的 `session.noteComposing` RPC 上报。Host 发出只读的 `session/composing` 事件，携带会话 id。`LifecycleBridge` 监听该事件并复用现有 `ensureResume` 路径；由于发送 `pause` 现在会清除 `resumeSent`，已暂停且已经跑过 turn 的会话会在草稿开始输入时发送一次新的 `resume`。程序化恢复草稿不会上报输入：只有携带 DOM 编辑形状的编辑才会上报。

## Alternatives considered

- **仅在下一次普通请求时 resume**——无需新的客户端信号，但要等用户提交后才开始预取。否决：需求是在用户仍输入时就预热缓存。
- **转发每次按键**——产生无谓的 RPC 量，且需要客户端状态去重。否决：空到非空这一次转换已经足够。
- **在 api-remotes types 中声明事件**——该包是拆分式项目引用，llm-agent-hint 无法在不 composite 的情况下通过 typecheck。否决：运行时事件放在 `dsh-agent` 上，生产方与消费方都已在其中合并 Cordis 事件。

## Consequences

- `session.noteComposing` 是建议性信号并 fail-open；传输失败绝不影响输入框。
- 已暂停会话每次“回来并开始输入”只发送一次 `resume`，不会每个按键都发送。
- 从未跑过 turn 或尚未被暂停的会话不会重复发送 `resume`。
- 该事件仅存在于运行时，不会写入持久化会话日志。
