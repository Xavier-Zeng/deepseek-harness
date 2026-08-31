# Agent Note: DeepSeek tool-call deltas treat wire null as absence

Status: implemented

[English](2026-08-31-deepseek-tool-call-null-delta-fields.md) | 中文

## Problem

`llm-deepseek` 的流式翻译器会从 wire delta 中累积每个工具调用的 `id` 与 `name`，但只防御了字段缺失（`!== undefined`）。OpenAI 兼容引擎只在每个工具调用的第一个 delta 中携带这两个字段，其后的每个 delta 都发送 JSON `null`。在对接 MindIE-Motor 协调器、由 `deepseek_v4` 工具解析器服务的 DeepSeek-V4 上实测：每个后续的 null 都会覆盖已累积的值，最终组装出的工具调用块 `id: ''`、`name: ''`，只有 arguments 完整。agent loop 因此以 `unknown tool ""` 拒绝执行，模型因工具从未真正执行而反复重发同一个调用，陷入循环。

## Decision

翻译器只在 wire 字段为非 null 字符串时才写入累积值：`typeof call.id === 'string'` 与 `typeof call.function?.name === 'string'`。`WireToolCallDelta` 现在声明 `id?: string | null` 与 `name?: string | null`，与服务器实际发送的内容一致，两条 JSDoc 都说明后续 delta 携带 null。`translate.spec.ts` 中新增的回归测试重放实测引擎形态——第一个 delta 携带 `id`/`name`、后续 delta 显式携带 null——并断言组装块保留第一个 delta 的 `id` 与 `name`。

## Alternatives considered

**在 SSE 边界把 null 归一化为 undefined** — 未采用：wire 确实会发送 JSON null，且同层字段（`content`、`reasoning_content`、`finish_reason`、`usage`）已经声明了 null；保持 wire 类型忠实、在翻译器中按字段决策，是既有模式。

**更宽松、但仍接受 null 的守卫（`call.id != null`）** — 未采用：引擎可能在后续 delta 发送空字符串并覆盖真实累积的 id；要求非 null 字符串，使缺失、null、空串统一视为"不变"。

## Consequences

从"首个 delta 之后把 `id`/`name` 置 null"的流中组装出的工具调用保留其身份，harness 得以执行预期工具，而不是以 `unknown tool ""` 拒绝。wire 类型现在记录了 null 延续行为。从不发送 null 的 provider 不受影响：字段缺失时仍与之前一样回退为 `''`。
