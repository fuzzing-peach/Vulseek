# ACP Agent Runtime And Native AgentStream Plan

## Goal

Replace `sandbox-agent` with the official ACP SDK and provider adapters. Support
create, resume, fork, and persistent task queues while rendering native Codex
and Claude Code transcripts in the Vulseek UI. There is no compatibility
fallback to sandbox-agent artifacts or APIs.

## Runtime Architecture

- Install exact container dependencies:
  `@agentclientprotocol/sdk@1.2.1`,
  `@agentclientprotocol/codex-acp@1.1.2`, and
  `@agentclientprotocol/claude-agent-acp@0.59.0`.
- Apply the local JavaScript patch to the Codex adapter to expose ACP fork via
  `thread/fork`. This does not modify or compile Rust.
- Run `vulseek-acp-driver.mjs` inside scan containers. It owns the ACP NDJSON
  connection, capability checks, permission responses, prompt timeout and
  cancellation, and persistent queue processing.
- Create a new ACP session for ordinary tasks, resume by session ID, and fork
  from a copied parent `agent-home`. Do not call `session/load`.
- Atomically maintain `activity.json`, `usage.json`, and `task-state.json`, plus
  lifecycle, stderr, and bootstrap logs. Do not recreate legacy event/text
  JSONL files and do not persist event streams in the database.

## Native Transcript Streaming

- Locate transcripts only from server-derived task/provider/thread metadata:
  Codex under `agent-home/sessions/**/rollout-*<threadId>.jsonl`; Claude Code
  under `agent-home/projects/*/<threadId>.jsonl`.
- Resolve ordinary task, persistent lane, and fork layouts without accepting a
  client-provided path or falling back to `sandbox-agent-event.jsonl`.
- Expose task-level SSE at `/api/scan/tasks/[taskId]/agent-stream` with
  `metadata`, `waiting`, chunked snapshot, `append`, `done`, and `stream_error`
  events. Resend a full snapshot after reconnect or file truncation.
- Expose task and job activity SSE from the atomic activity snapshots. Running
  task badges derive from these snapshots rather than transcript parsing.

## AgentStream UI

- Keep the parser in `vendor/claude-replay` shared by batch and incremental
  parsing, with support for arbitrary JSONL chunk boundaries and reset.
- Export `claude-replay/agent-stream` and consume it through a generic
  `AgentStreamTransport`; use SSE as the first transport.
- Replace the Event modal's legacy JSON-RPC summary and raw text controls with
  the native stream. Use fixed GitHub Light styling.
- Collapse user prompts, thinking, and tool details by default. Show activity
  spinners on active thinking/tool rows, keep the provider label static, and
  constrain long tool results with an inner scrollbar.
- Auto-follow only while the user is at the bottom; otherwise show a jump-to-
  latest control. Keep Event available for running and completed tasks.

## Verification Gates

- Driver tests cover create, resume, fork, and persistent queue execution.
- Locator/API tests cover ordinary, persistent, fork, waiting, snapshot,
  append, truncation, terminal missing source, authentication, and access.
- Parser tests prove incremental and batch parity for Codex and Claude Code.
- React tests cover transport state, collapsed rendering, append, auto-follow,
  waiting, completion, errors, and teardown.
- Run server and app typechecks, the Vulseek Vitest suite, claude-replay tests,
  focused Node/TypeScript runtime tests, Biome, and `git diff --check`.
- Build and smoke-test the scan-tools image, then verify a real temporary ACP
  job and AgentStream modal in the browser. Remove temporary containers after
  verification.
