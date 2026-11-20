# Shared Lark tool MCP

`lark_tools` publishes `lark_approval_status` and named host tools from the
runtime capability registry. For example, `forge.deploy.inspect` is exposed as
`forge__deploy__inspect`. Each tool takes `{context_token, input}`, where
`input` uses that capability's registered schema. Tools blocked by the runtime
are not enabled by changing the MCP client. Bot-only installations without a
host runtime credential still expose current approval status, not host calls.
The old `lark_approval_plan` call remains compatible but is not listed or
required before tool execution.

| Runtime capability | MCP tool | Existing behavior |
| --- | --- | --- |
| Approval outcome | `lark_approval_status` | Reads the current turn's approval outcomes, never grants access |
| `forge.deploy.inspect` | `forge__deploy__inspect` | Read-only deployment inspection |
| `forge.deploy.production` | `forge__deploy__production` | Production deployment; existing approval and target checks |
| `forge.gitea.review-pr` | `forge__gitea__review-pr` | PR review with existing write policy |
| `forge.gitea.triage-issue` | `forge__gitea__triage-issue` | Issue analysis with existing write policy |
| `forge.todo.create` | `forge__todo__create` | Task creation with existing write policy |
| `lark.message.send` | `lark__message__send` | Bot sends to a resolved contact; existing approval or owner fast path |

Trusted direct sessions do not need a Lark approval card for host calls. Host
service checks and live turn identity checks still apply.

The separate `lark_stickers` server provides stickers, attachments, history
images and owner assistance for Codex. External engines get a search/select-only
instance authenticated by the process-local MCP credential, not the runtime
credential. Both paths share the conversation's sticker mode, selection logic,
library and delivery queue. A selection belongs to the live message and turn;
it is queued after a successful final response and sent only after the final
text is delivered. Cancelling, declining to reply or disabling stickers
discards the selection.

## Engine adapters

Codex loads the MCP at App Server launch, so old threads can resume without
updating saved dynamic tool definitions. New threads no longer register the
parallel dynamic tools. Previously stored dynamic calls can still be handled
for compatibility, through the same approval plan and capability services.

Local external adapters may opt in with `supportsLarkMcp` and mount the supplied
stdio descriptors on session creation and resume. Native Claude, DSH, OpenCode
and AGY use this path under their existing execution policies. Engine deadlines and
capabilities are unchanged;
for example an engine can end its turn before the human approval deadline.

The gateway uses a separate process-local credential, loopback HTTP, and a
per-message token. The runtime derives actor, chat, turn and trust policy from
the live execution, not from caller-supplied identity fields. It rejects stale
tokens and invalidates tool access on turn completion. Host calls retain the
existing approval, idempotency, cancellation and delivery checks; metadata such
as internal execution receipts is not forwarded to the model.

For a Codex-native `lark_tools` tool confirmation, the runtime first checks
the live origin and exact arguments from Codex's approval event. The same
capability policy decides authorization; approval only opens a short-lived
handoff. The downstream operation starts only when the matching MCP call
actually arrives, after checking that the turn and plan are still current.
Missing, altered, expired or unrelated confirmations do not grant access.

The migration tests use actual MCP stdio with a simulated resumed Codex thread,
mock host operations and approval cards, plus isolated external engine ACP
fixtures. They do not send live messages or deploy real services.
