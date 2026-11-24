# Opt-in Lark engine reattachment

This mode is disabled by default. The existing stdio paths are unchanged unless
an operator selects a private independent engine host. Only one Lark runtime
may open the database. Keep the engine host running across Lark restarts.

Send SIGTERM only to the verified Lark runtime process for a graceful handoff.
Its shutdown drains local turns and in-flight submissions, but detaches
already journaled turns owned by an independent engine. Do not restart the
engine hosts or stop the whole process tree during a hot handoff.

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

## Lark recovery

The runtime journals the source message and the submission boundary. ACP
binds to the host generation and turn ID; Codex binds to the socket identity,
accepted thread and turn. A bound card is kept only when it can be correlated
to the original live permission request, source, actor and deadline. If the
host changed or the operation cannot be confirmed, no approval is granted and
the prompt is not resubmitted.

Final answers and pending delivery intents are committed together. The ACP
result is acknowledged only after that commit. An uncertain remote send uses
the existing readback rules rather than an unconditional resend.

### Configure in an isolated trial

- Codex: run a dedicated Codex App Server with `--listen unix://<private-socket>`.
  Set `LARK_AGENT_CODEX_APP_SERVER_SOCKET` on Lark. Do not share the socket
  with the desktop app or another controller. The normal workspace, model,
  and thread approval settings remain in effect; native approvals recover
  through the whole-turn approval path.
- ACP: run `npm run serve:engine-host` independently with the same configured
  ACP launchers, models, and `LARK_AGENT_WORKSPACE_ROOT`. Set
  `LARK_AGENT_ENGINE_HOST_SOCKET` and the same private
  `LARK_AGENT_ENGINE_HOST_TOKEN` in both processes. The socket's parent
  directory must be user-owned with no group or other access. Select hosted
  engine IDs on Lark with `LARK_AGENT_ENGINE_HOST_ENGINES` (comma-separated).
  A hosted engine never falls back to a different launcher to bypass its policy.

This initial mode covers single-input text turns with native permission
callbacks. It serializes inputs rather than steering an in-flight turn. Hosted
ACP does not mount Lark MCP tools. In-flight Lark MCP callbacks, transient
attachment or sticker state, and legacy Codex per-operation cards are not
reattached. The engine host itself cannot be hot restarted.

To return to stdio, drain hosted turns and verify pending replies before
removing the opt-in settings. Never drop the recovery rows to force a replay.

## Existing verification

The adapter suite covers Codex socket reconnect and a local ACP protocol
fixture through each of the Claude, DSH, OpenCode and AGY adapters. The ACP
tests stop the first socket client, reconnect with another process, verify
the exact permission ID, reject duplicate and mismatched decisions, and read
one final result. Runtime tests use a disposable SQLite database and a fake
Feishu transport, exercising the existing Lark card handler for all five
engine routes. The tests do not send live messages, replay real commands or
enable these settings on a running bot. OpenCode uses ACP in this mode.

Hosted ACP turns publish the same progress and terminal observer events as
other turns. Early work is remembered until the progress delay is reached,
and a short turn still does not create a progress card.
