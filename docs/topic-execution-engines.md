# Lark execution engines

Codex remains the default. An operator can select a registered engine and model
for an existing direct chat or group. A topic override takes precedence over
its group; it can also explicitly select Codex. Changing the engine does not
enroll a topic in automatic reply mode. Use the normal topic join flow for that.
External routing applies to human direct messages, group mentions of the agent,
and enrolled topic follow-ups. Owner assistance, bot mentions, spontaneous
replies, and the enforced group privacy workflow retain the existing path.

## Enable a native ACP engine

By default no external engine is registered. To opt in on a local runtime:

| Engine ID | Launcher variable | Arguments supplied by Lark |
| --- | --- | --- |
| `claude` | `LARK_AGENT_CLAUDE_ACP_NATIVE_LAUNCHER` | None; the executable starts pinned `claude-agent-acp` |
| `dsh` | `LARK_AGENT_DSH_ACP_NATIVE_LAUNCHER` | `--profile acp` |
| `opencode` | `LARK_AGENT_OPENCODE_ACP_NATIVE_LAUNCHER` | `acp` |
| `agy` | `LARK_AGENT_AGY_ACP_NATIVE_LAUNCHER` | `acp --disable-telemetry` |

Use an absolute executable path, not a shell command. The CLI or an
operator-owned wrapper uses the supplied working directory and existing
authentication; the runtime never installs a CLI or signs in at startup. The
previous Claude pilot launcher and workspace settings are not used. An invalid
launcher leaves only that engine unavailable. Each optional
`LARK_AGENT_<ENGINE>_ACP_MODELS` value is a comma-separated allowlist of exact
engine model IDs. Omit it to offer the engine's configured default only.

The configured Codex workspace and sender trust settings also govern these engines.
The ordinary launcher is used only for trusted senders. To admit other senders,
set `LARK_AGENT_<ENGINE>_ACP_RESTRICTED_LAUNCHER` to a **different** absolute
executable that the operator has configured and validated for the workspace's
read, credential, network and write policy. This is an operator trust boundary:
ACP permission callbacks do not sandbox a process, and copying the ordinary
launcher to a different path does not make it restricted. Use separate provider
state and do not import trusted sessions or stored grants. Missing or invalid
restricted launchers leave that engine unavailable to non-trusted senders;
there is no silent fallback to an unrestricted launcher or to Codex.

A restricted launcher can be a small policy wrapper around the same installed
CLI. It does not require a second CLI installation, a container, or a change
to the configured workspace or model. Before registering it, verify that
protected tools are blocked before approval and that saved grants, settings
and provider state cannot weaken that policy.

DSH receives `DSH_PERMISSION_MODE=read-only` on the restricted path. Use a
controlled profile that retains its shell and file sandbox backends and does
not override that setting. This setting alone is a write policy, not a
read/network or credential isolation mechanism. For Claude, OpenCode and AGY
the restricted executable must set the corresponding provider policy itself;
this runtime does not change a provider's managed settings or claim that its
stock launcher enforces read-only operation. Restricted Claude requests also
disable native permission bypass; restricted AGY receives `--sandbox`. Both
must confirm `default` mode on session open or restore, and switching away
from that mode ends the session. These checks do not replace the launcher's
tool policy.

For an active turn, a request from that exact ACP session can grant the offered
single-use option. The first restricted native callback opens the shared Lark
turn approval. With automatic review off it goes straight to a manual turn
card, as with Codex. The task model does not need to register a plan or
organize approval. Each callback must match an observed tool call and its
original parameters; the engine receives only `allow_once`. No grant survives
cancellation or the end of the turn. Trusted sessions keep their ordinary
launcher and selected model, and do not open Lark execution approval cards.
The operator launcher supplies
authentication and persistent native sessions. A small environment
allowlist retains the local profile and executable search paths without
forwarding Lark or Forge API tokens. The host does not expose filesystem,
terminal or an unrestricted ACP tool relay. The trusted adapter passes the
fixed [`lark_tools` stdio MCP](shared-tool-mcp.md) on session creation and resume.
Only that subprocess receives the limited MCP transport credential. Its calls
still need a live turn token and the applicable runtime and host-service checks.

DSH, OpenCode and AGY use the advertised `session/resume` and preserve their
native conversation across processes. A failed resume never starts a new
conversation silently. Claude retains its existing `session/load` behavior.
Same-turn steering still requires Claude ACP 0.81.1 or later in the 0.x series
and its advertised steering extension. Other ACP engines queue follow-ups
until the current turn ends; sending a second prompt is not treated as a
confirmed same-turn injection.

## Progress and replies

ACP notices, assistant-only content, and commentary before tool calls are not
part of the final Feishu reply. The adapter keeps the last foreground answer
and uses ACP message IDs to join its chunks when available. Tool activity
feeds the existing single progress card with short status labels, not tool
arguments, outputs, or raw transcript text. With progress enabled, tool-driven
turns can show a card after 8 seconds (or the configured delay if shorter);
turns without tool activity retain the existing delay. A turn that finishes
before its threshold emits only the final reply.

Successful external-engine replies use the same Markdown delivery as Codex:
rich text for normal replies, data cards for tables and structured lists,
and a Markdown attachment for content that exceeds display limits.

## Configure and verify

`GET` and `PUT /v1/chats/:chatId/topics/:threadId/execution` use the runtime
token, as do `GET` and `PUT /v1/chats/:chatId/execution` for chat settings.
A PUT accepts `{"override":{"engineId":"claude","model":null}}` or an
allowlisted model ID in place of null. A null override inherits the group
selection for a topic, or restores the global Codex model for a chat.
Choosing Codex at chat level updates the existing per-chat Codex model rather
than creating a separate model setting. Selecting an external engine preserves
that Codex preference. Changes of external routing while work is queued or running are
rejected. `POST .../execution/cancel` requests cancellation; a 202 response
on the topic endpoint reports admission, not proof that the agent stopped.

Only new text is sent; no previous Codex thread, quotes, or attachments are
carried over. Conversation-level routes include the configured
assistant persona on each new turn. External sessions are tracked separately by
binding, trust scope and workspace, and an inherited topic never shares the
main group's session. Switching a chat back to an engine can reuse its own
session; Codex and external session histories stay independent. Explicit model replacements are
verified on the next turn. Switching a model to or from the engine default
opens a separate external session. Resume or admission failures do not replay
work or fall back to Codex. The legacy manual retry endpoint does not resend
messages from an external engine run.

Add another adapter by implementing `ExecutionEngine` and registering its
descriptor and session factory at bootstrap. It must explicitly support the
policy it is asked to enforce. The optional `steer` method only
reports `idle` when the engine explicitly says the input was not consumed; a
transport error is never inferred to be safe to resend. Engines without steer
receive the input in a subsequent turn.
