# Topic execution engine pilot

Codex remains the default. An operator can opt an existing group topic into an
external engine; this does not enroll the topic in automatic reply mode.
Use the normal topic join flow separately when automatic follow-up is desired.
Only human messages that directly mention the agent or qualify for native topic
continuation use this route. Other topics, single chats, owner assist, bot
mentions and spontaneous replies retain the existing behavior.

## Enable the Claude adapter

By default no external engine is registered. Set these deployment settings
only on an isolated pilot runtime:

- `LARK_AGENT_CLAUDE_ACP_LAUNCHER`: absolute path to an operator-owned executable
  that starts a pinned `claude-agent-acp` over stdin/stdout, without installing
  or signing in at startup.
- `LARK_AGENT_CLAUDE_ACP_WORKSPACE`: absolute path to the isolated pilot
  workspace. The launcher must make the same path available to the ACP agent.
- `LARK_AGENT_CLAUDE_ACP_MODELS`: comma-separated native model IDs that the
  operator allows. Omit to offer only the engine default.

The child does not inherit the runtime environment. The launcher must provide
a dedicated provider credential/profile, session storage that survives
reconnections, an isolated filesystem and an appropriate network policy.
Do not start a stock adapter with access to the server user's home directory,
live repositories, keychain or production credentials. ACP permission denial
is not an OS sandbox. The pilot denies ACP permission requests and grants no
filesystem, terminal, or MCP capabilities from the host.

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

Only new text is sent; no previous Codex thread, quotes, attachments, workspace
credentials or tool access are carried over. External sessions are tracked
separately by topic binding and trust scope. Explicit model replacements are
verified on the next turn. Switching a model to or from the engine default
opens a separate external session. Resume or admission failures do not replay
work or fall back to Codex. The legacy manual retry endpoint does not resend
messages from an external engine run.

Add another adapter by implementing `ExecutionEngine` and registering its
descriptor and session factory at bootstrap. The optional `steer` method only
reports `idle` when the engine explicitly says the input was not consumed; a
transport error is never inferred to be safe to resend. Engines without steer
receive the input in a subsequent turn.
