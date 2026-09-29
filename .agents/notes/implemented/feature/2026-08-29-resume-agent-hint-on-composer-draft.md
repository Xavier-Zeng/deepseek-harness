# Agent Note: Resume a paused agent-hint session when its composer draft starts

Status: implemented

English | [中文](2026-08-29-resume-agent-hint-on-composer-draft.zh.md)

## Problem

Once `llm-agent-hint` paused a switched-away session, returning to that session needed another ordinary request before the coordinator could prefetch its KV cache. The web composer knows the user has returned before the request is sent, but that signal stayed in the browser and never reached the Host.

## Decision

The web composer reports the first user edit that moves a session's draft from empty to non-empty through a new `session.noteComposing` RPC. The Host emits an advisory `session/composing` event with the session id. `LifecycleBridge` listens for that event and calls its existing `ensureResume` path; because sending `pause` now clears `resumeSent`, a paused session that has already run a turn sends one fresh `resume` when its draft starts. Programmatic draft restoration does not report composing: only edits carrying the DOM edit shape do.

## Alternatives considered

- **Resume on the next ordinary request only** — no new client signal, but prefetch starts only after the user submits. Rejected: the requested behavior is to warm the cache while the user is still typing.
- **Forward every keystroke** — needless RPC volume and duplicate resume suppression would add client-side state. Rejected: the first empty-to-non-empty transition is enough.
- **Emit the event from api-remotes types** — that package is a split project reference and llm-agent-hint cannot typecheck it without composite. Rejected: the runtime event lives on `dsh-agent` where both producer and consumer already merge Cordis events.

## Consequences

- `session.noteComposing` is advisory and fails open; transport failure never affects the composer.
- A paused session resumes once per return-and-type cycle, not on every keystroke.
- A session that has never run a turn or has not been paused does not send a duplicate resume.
- The event is runtime-only and does not enter the durable session log.
