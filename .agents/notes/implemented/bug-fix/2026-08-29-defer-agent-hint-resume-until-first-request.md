# Agent Note: Defer agent-hint resume until first ordinary request

Status: implemented

English | [中文](2026-08-29-defer-agent-hint-resume-until-first-request.zh.md)

## Problem

`llm-agent-hint` sent a coordinator `resume` manage request from `session/created` whenever a session carried prior history (`firstLiveSeq > 0`). Web startup restores several historical sessions in one burst, so mounting the plugin produced one `resume` request per restored session before any user action. The same broad predicate also classified a blank persisted session — one whose log holds only its `session/end-seed` marker — as history, so a newly reused blank session sent `resume` instead of declaring `start` on its first request. The requests were advisory, but the burst was noise and worked against the prefetch's intent: warming KV cache for a session nobody had opened.

## Decision

`LifecycleBridge.onSessionCreated` records the seeded flag and fork parent. A session is seeded only when its constructor history contains at least one `turn/start` before `firstLiveSeq`; a blank persisted session with only an `session/end-seed` marker remains fresh, and `noteOrdinaryRequest` no longer flips the flag, so `seeded` stays a constructor fact for the session's lifetime. The bridge gains `ensureResume(sessionId, model)`, called by `AgentHintAdapter.stream()` for an ordinary request (no defined `purpose`) before the existing pending-op barrier. The method sends `resume` once per restore cycle — gated on `(seeded || pauseSent) && !resumeSent` — using the triggering request's model id, then marks the session resumed so concurrent or later requests do not duplicate it. The `pauseSent` arm covers a paused session returning to the foreground (its KV was offloaded by `pause`), including a submit without any composer draft; the `seeded` arm covers sessions created with prior history. A live fresh session never triggers it, because neither flag is set between its consecutive ordinary requests. Background-purpose requests still do not trigger a resume, and the ordinary request still waits for the in-flight resume through the existing barrier.

`compact` and `stop` behavior is unchanged. The change is local to `@deepseek-ai/dsh-llm-agent-hint`.

## Alternatives considered

- **Suppress resume during a startup grace window** — a timer would skip the startup burst without distinguishing a user click inside the window. Rejected: it replaces a lifecycle fact with wall-clock timing and would need a deployment-specific tunable.
- **Move resume to `agent/session-start` with `source: 'resume'`** — web startup restores and explicit user opens both reach that event with the same source. Rejected: the event cannot distinguish the two cases.
- **Keep resume on `session/created` and debounce by session** — it still sends one request per restored session at startup. Rejected: it does not remove the startup burst.
- **Treat every `firstLiveSeq > 0` session as seeded** — the original predicate also matched blank persisted sessions. Rejected: a blank session has no conversation to prefetch and must still declare `start`.

## Consequences

- Startup restoration no longer fans out `resume` manage requests; only the first ordinary request of a seeded session does.
- A blank persisted session reuses the fresh-session path: its first ordinary request declares `start` and does not send a `resume`.
- A live fresh session sends no `resume` between its consecutive ordinary requests; `resume` fires only after the session was actually `pause`d or when it was created with prior history.
- A paused session sends one fresh `resume` on its next ordinary request even when the user submits without composing; the composer-draft path remains an earlier trigger of the same verb.
- A resumed conversation's first model request waits briefly for its own `resume` through the unchanged pending-op barrier, then proceeds fail-open.
- The deferred `resume` uses the triggering request's model id rather than the session's last observed model id.
- `compact` and `stop` continue to use the last observed model id.
