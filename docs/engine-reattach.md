# Engine reattachment components

These components do not change how a running Lark Agent owns turns or handles
startup. Do not enable a different engine launch mode based on this document.

- The Codex adapter can connect to an operator-owned App Server over its Unix
  WebSocket instead of spawning a stdio child. Closing the socket client does
  not stop the App Server. Both the configured and resolved socket directories
  must be private and owned by the runtime user. This is not a public server.
- The ACP host library retains the existing adapter's session, prompt and
  permission callbacks while its client is disconnected. The private Unix
  socket also requires an independent control token. Never pass it to an
  engine, its environment, or an MCP server. Workspace, launchers and MCP
  entries are operator configuration, not RPC input.
- The host assigns a generation; clients address a saved turn by generation
  and caller-assigned turn ID. Attach does not submit a prompt. Older cursors
  can report an event gap; callers should use the terminal snapshot rather
  than infer missing text. A permission response must match a currently
  pending opaque request ID in that turn. A terminal receipt can be acknowledged
  repeatedly without reopening the turn.
- These records live in the independent ACP host process. A new host generation
  is not evidence that a previous turn never ran. Do not automatically replay
  against a replacement host, including when the start response was lost.

## Required before enabling in Lark

Persist the Lark source message, trust policy, engine generation, native
session/turn or host turn ID, approval correlation and event cursor. Record the
submission boundary before calling an engine. During startup, attach to the
original turn before existing orphan cleanup can invalidate its card. Apply the
same requester, approver, expiry and in-flight policy checks to any reattached
approval. Do not infer authority from a host request ID alone. Commit the final
result and current delivery intent before acknowledging it to the engine host.
If terminal delivery is uncertain, use the existing readback rules rather than
resending.

Exercise end-to-end recovery against a disposable database and Lark sender:
original card after runtime restart, rejection and expiration, cancellation,
event cursor gaps, lost submit response, ambiguous reply delivery, and
independent host death. The test should assert that no second native prompt is
started for an uncertain original turn.

## Existing verification

The adapter suite covers Codex socket reconnect and a local ACP protocol
fixture through each of the Claude, DSH, OpenCode and AGY adapters. The ACP
tests stop the first socket client, reconnect with another process, verify
the exact permission ID, reject duplicate and mismatched decisions, and read
one final result. OpenCode uses the ACP path in these tests; its separate
native HTTP API is not covered.
