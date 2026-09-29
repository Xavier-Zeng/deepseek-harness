# Agent Note: Pause a switched-away agent-hint session after it idles

Status: implemented

English | [中文](2026-08-29-pause-switched-away-agent-hint-session.zh.md)

## Problem

When a user moves from one historical session to another, the coordinator should offload the previous session's KV cache once that session's in-flight inference has finished. `llm-agent-hint` already supports the `pause` control verb, but nothing emitted it when the foreground session changed.

## Decision

`LifecycleBridge` tracks the last session that sent an ordinary request. When an ordinary request arrives for a different session, the bridge marks the previous session for `pause`. If that session is already `idle`, it sends `pause` immediately; otherwise it waits for the session's `agent/status` transition to `idle`. Reactivating a session cancels its pending pause, and disposal or archiving clears the pending marker.

The trigger is the new session's first ordinary request, not the UI selection change. Background-purpose requests (`compaction`, `session-title`) never move the foreground and never trigger a pause. The `pause` request is fire-and-forget and does not arm the pending-op barrier.

## Alternatives considered

- **Send the selection change from the web client to the host** — a new RPC or event would make clicking B the trigger. Rejected for this change: it spans client runtime, API proxy, and the plugin, while the requested option is intentionally limited to `llm-agent-hint` and triggers on B's first message.
- **Send `pause` immediately when another session starts** — the previous session may still be running, and the coordinator would offload a live cache. Rejected: the idle wait is the requested semantics.
- **Reuse `agent/session-start` to infer the switch** — startup restoration and explicit opens both emit the same source. Rejected: it cannot reliably distinguish them.

## Consequences

- Switching from A to B emits no `pause` until B receives its first ordinary request.
- If A is running at that point, `pause` waits for A's `running` → `idle` transition.
- Returning to A before the pause clears its pending marker, so no premature offload occurs.
- A repeated switch away can pause A again after it becomes active again.
- `pause` uses the session's last observed model id and fails open like every other control request.
