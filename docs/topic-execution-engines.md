# Topic execution engines

Codex remains the default. An operator can opt an existing group topic into an
external engine; this does not enroll the topic in automatic reply mode.
Use the normal topic join flow separately when automatic follow-up is desired.
Only human messages that directly mention the agent or qualify for native topic
continuation use this route. Other topics, single chats, owner assist, bot
mentions and spontaneous replies retain the existing behavior.

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
forwarding Lark or Forge API tokens. The host does not advertise filesystem,
terminal, or MCP capabilities through ACP.

Same-turn steering requires a stable Claude ACP release with prompt-lifecycle
fixes (0.81.1 or later in the 0.x series) and an advertised steering extension.
Other versions queue follow-up messages instead of attempting an untracked turn.

## Configure and verify

`GET` and `PUT /v1/chats/:chatId/topics/:threadId/execution` use the runtime
token. A PUT accepts `{"override":{"engineId":"claude","model":null}}` or an
allowlisted model ID in place of null. `{"override":null}` returns the topic to
its existing Codex policy. Changes to a topic with queued or running work are
rejected. `POST .../execution/cancel` requests cancellation; a 202 response
reports admission, not proof that the agent stopped.

Only new text is sent; no previous Codex thread, quotes, attachments, or host
tool access are carried over. External sessions are tracked separately by
topic binding, trust scope and workspace. Explicit model replacements are
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
