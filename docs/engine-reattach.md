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

### Foreground Codex MCP

On the dedicated Codex App Server, configure the **`lark_tools` MCP server
once** in addition to the existing sticker server. It reads the current
capability catalog from Lark on each `tools/list`, so new tools do not change
the Codex launch configuration.

Use the same private runtime token (at least 32 bytes) as Lark to derive the
dedicated MCP bearer. The example assumes the Lark repository as the current
directory, Node 24, installed dependencies, and the existing runtime token
and loopback URL already exported by the managed launcher. Capture the derived
value into the process environment; never log it.

```sh
export LARK_AGENT_MCP_TOKEN="$(node --import tsx --input-type=module -e '
  import { codexForegroundMcpBearer } from "./packages/conversation-runtime/src/codexForegroundMcp.ts";
  const token = codexForegroundMcpBearer(process.env.LARK_AGENT_RUNTIME_TOKEN);
  if (!token) process.exit(1);
  process.stdout.write(token);
')"
test -n "$LARK_AGENT_MCP_TOKEN" || exit 1
```

On the existing dedicated `codex app-server` launch command, keep the socket
and other options; add these arguments (capturing repository and Node paths
before changing the process working directory):

```sh
-c "mcp_servers.lark_tools.command=\"$(command -v node)\"" \
-c "mcp_servers.lark_tools.args=[\"$PWD/node_modules/tsx/dist/cli.mjs\",\"$PWD/packages/mcp-stickers/src/agentTools.ts\"]" \
-c 'mcp_servers.lark_tools.env_vars=["LARK_AGENT_RUNTIME_URL","LARK_AGENT_MCP_TOKEN"]' \
-c 'mcp_servers.lark_tools.startup_timeout_sec=10' \
-c 'mcp_servers.lark_tools.tool_timeout_sec=1200'
```

Apply the one-time App Server configuration when its active turns have
drained. A subsequent Lark-only restart keeps the catalog bearer valid as
long as the runtime token is unchanged. Tool calls still need the current
native socket turn's context and the normal approvals. An old turn's token or
an interrupted tool call is not replayed. The bearer cannot call the general
runtime API or submit an approval decision.

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

The Codex socket's default inbound message limit is 128 MiB. Operators can
set `LARK_AGENT_CODEX_SOCKET_MAX_PAYLOAD_MIB` to an integer between 1 and 512
for a different bounded limit. An oversize message or socket disconnection
detaches journaled turns instead of declaring them failed. The runtime checks
the original thread, turn and socket identity before reattaching, and does not
submit the input again. Terminal history is read in bounded pages on a
separate connection; a read that still exceeds the limit is deferred for
that turn. An expired or unverifiable turn remains subject to the existing
uncertain-outcome handling. No change is made to the legacy stdio failure
contract.

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

An attached Codex socket turn accepts same-requester follow-ups through
`turn/steer`. Lark journals each submission before sending it, records
acceptance after an acknowledgement or native input observation, and checks
native input IDs to reconstruct the final reply's target after reconnect.
An ambiguous steer is never resubmitted or turned into a fresh prompt.
Independent requests, detached turns, and hosted ACP still serialize input.
Transient attachment or sticker state, legacy per-operation cards, and Lark MCP
calls without receipt support are not reattached. The engine host itself cannot
be hot restarted.

Forge host operations called through the updated Lark MCP helper can recover
their original result across a Lark runtime restart. Forge claims a request ID
before executing and retains its response; Lark persists that ID before the only
submission. A disconnected helper reads the same receipt instead of submitting
again. An unknown result is not success and will not re-execute the operation.
Upgrade Forge first; versions without the protocol keep the legacy synchronous
path. A running MCP helper must reload its code before it can wait across a
disconnect. If Forge itself is lost, it cannot adopt an already-running child.

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

Turn observers can select event kinds. `turn.dispatched` reports a new turn
bound to an engine session when it is dispatched or first observed, not a
reattachment, steer, or proof of completed work. `reply.delivered` reports
an answered turn's final text/rich reply only after a send receipt or exact
readback is committed. It excludes progress cards, approval notifications,
separate attachments, and uncertain delivery. For a turn completed in the
current runtime, `turn.finished` precedes `reply.delivered`; a confirmed
readback can emit delivery without replaying past lifecycle events.

The hooks are best-effort, process-local observations with bounded subscriber
queues. On overload they prefer completion and delivery over dispatch and
progress. They neither authorize operations nor influence execution.
