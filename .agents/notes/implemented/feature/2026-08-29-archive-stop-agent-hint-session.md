# Agent Note: Stop an archived agent-hint session

Status: implemented

English | [中文](2026-08-29-archive-stop-agent-hint-session.zh.md)

## Problem

Archiving a session hides it from workspace grouping surfaces, but `llm-agent-hint` did not tell the coordinator to evict that session's KV cache. The archived session could remain loaded until server-side eviction.

## Decision

`WorkspaceRegistry.archiveSession` emits a `workspace/session-archived` event after the durable archive write succeeds. `LifecycleBridge` listens for that event and sends a fire-and-forget `stop` manage request for the archived session, using its last observed model id. The session may stay live and be unarchived later, so bridge state is retained.

## Alternatives considered

- **Emit the event from the API proxy workspace handler** — it would keep the signal one layer closer to the wire. Rejected: the durable registry is the natural owner of the lifecycle fact and works for every archive caller, not only the web RPC.
- **Reuse `session/disposed`** — archiving is not disposal; the session can be unarchived later. Rejected: conflating them would drop bridge state and imply the wrong lifecycle.

## Consequences

- Archiving a session now sends an advisory `stop`.
- Failure to send `stop` never affects the archive operation.
- Unarchiving later can reuse the same tracked state; a subsequent archive can send another `stop`.
