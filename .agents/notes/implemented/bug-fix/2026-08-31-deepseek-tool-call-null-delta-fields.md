# Agent Note: DeepSeek tool-call deltas treat wire null as absence

Status: implemented

English | [中文](2026-08-31-deepseek-tool-call-null-delta-fields.zh.md)

## Problem

The `llm-deepseek` stream translator accumulated each tool call's `id` and `name` from wire deltas, but only guarded against absent fields (`!== undefined`). OpenAI-compatible engines carry those fields only on a call's first delta and send JSON `null` on every continuation delta. Observed live against the MindIE-Motor coordinator serving DeepSeek-V4 with the `deepseek_v4` tool parser, every continuation null overwrote the accumulated value, so each assembled tool-call block finished with `id: ''` and `name: ''` while its arguments were complete. The agent loop rejected the call as `unknown tool ""`, and the model re-issued the same call in a loop because the tool never executed.

## Decision

The translator stores a value only when the wire field is a non-null string: `typeof call.id === 'string'` and `typeof call.function?.name === 'string'`. `WireToolCallDelta` now declares `id?: string | null` and `name?: string | null`, matching what servers send, and both JSDoc entries state that continuation deltas carry null. A regression test in `translate.spec.ts` replays the live engine shape — first delta with `id`/`name`, continuations with explicit null — and pins the assembled block to the first delta's `id` and `name`.

## Alternatives considered

**Normalizing null to undefined at the SSE boundary** — rejected: the wire really emits JSON null, and sibling fields (`content`, `reasoning_content`, `finish_reason`, `usage`) already declare it; keeping the wire types faithful and deciding per field in the translator is the established pattern.

**A looser guard that still accepts null (`call.id != null`)** — rejected: an engine could send an empty string on a continuation and overwrite a real accumulated id; requiring a non-null string makes missing, null, and empty uniformly "no change".

## Consequences

Tool calls assembled from streams that null out `id`/`name` after the first delta keep their identity, so the harness executes the intended tool instead of rejecting `unknown tool ""`. The wire types now document the null-continuation behavior. Providers that never send null are unaffected: absent fields still fall back to `''` exactly as before.
