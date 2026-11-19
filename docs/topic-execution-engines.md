# Lark execution engines

Codex remains the default. An operator can select a registered engine and model
for an existing direct chat or group. A topic override takes precedence over
its group; it can also explicitly select Codex. Changing the engine does not
enroll a topic in automatic reply mode. Use the normal topic join flow for that.
External routing applies to human direct messages, group mentions of the agent,
and enrolled topic follow-ups. Owner assistance, bot mentions, spontaneous
replies, and the enforced group privacy workflow retain the existing path.

## Enable the native Claude adapter

By default no external engine is registered. To opt in on a local runtime:

- `LARK_AGENT_CLAUDE_ACP_NATIVE_LAUNCHER`: absolute path to an operator-owned executable
  that starts a pinned `claude-agent-acp` over stdin/stdout, without installing
  or signing in at startup. It must use the working directory provided by the
  runtime. The previous pilot launcher and workspace settings are not used.
- `LARK_AGENT_CLAUDE_ACP_MODELS`: comma-separated native model IDs that the
  operator allows. Omit to offer only the engine default.

The configured Codex workspace and sender trust settings also govern Claude.
The stock native Claude adapter is supported only for senders authorized for
Codex full access without additional approval. For an ordinary read-only
request it refuses before the launcher starts: ACP requests alone cannot enforce
the Codex sandbox or the existing turn-scoped Feishu approval process.
There is no silent fallback to Codex and no new trusted-sender list.

For a trusted active turn, a request from that exact Claude session can grant
the offered single-use option. There are no persistent grants, or grants before
the turn, after it ends, or after cancellation. The operator launcher supplies
Claude authentication and persistent native sessions. A small environment
allowlist retains the local profile and executable search paths without
forwarding Lark or Forge API tokens. The host does not expose filesystem,
terminal or an unrestricted ACP tool relay. The trusted Claude adapter passes the
fixed [`lark_tools` stdio MCP](shared-tool-mcp.md) on session creation and load.
Only that subprocess receives the limited MCP transport credential. Its calls
still need a live turn token and the normal Lark runtime approvals.

Same-turn steering requires a stable Claude ACP release with prompt-lifecycle
fixes (0.81.1 or later in the 0.x series) and an advertised steering extension.
Other versions queue follow-up messages instead of attempting an untracked turn.

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

Only new text is sent; no previous Codex thread, quotes, attachments, or host
tool access are carried over. Conversation-level routes include the configured
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
