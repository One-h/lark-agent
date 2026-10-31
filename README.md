# Lark Agent

Standalone local runtime for Feishu conversations, Codex turns, approvals, delivery, and recovery.

Requires Node.js 24, `codex`, `lark-cli`, and a configured Feishu bot identity.

## Relationship to Agent Forge

Lark Agent is the standalone bot runtime; **[Agent Forge](https://github.com/One-h/agent-forge)**
is its optional web management console and a host for Todo and Git/Gitea workflows.
You can run either project alone. For both, install them in sibling directories,
configure shared runtime/host tokens, start Lark Agent on `4780`, then start Forge
on `4731/4732/4734`. Each has its own dependencies, process and SQLite database;
Forge's `npm run dev` does not install or launch this runtime.

**Full-suite installation:** follow the
[Agent Forge complete installation walkthrough](https://github.com/One-h/agent-forge/blob/main/docs/INSTALL.md#full-suite).
It covers protected configuration, bot events/card callbacks, both shared tokens,
activation and real-message acceptance. For bot-only use, continue below and
leave `host_url` unset; Forge and its deployment adapter are not required.

## Start

```bash
npm install
cp examples/standalone/lark-agent.toml ./lark-agent.toml
npx tsx apps/cli/src/index.ts doctor --config ./lark-agent.toml
npx tsx apps/cli/src/index.ts serve --config ./lark-agent.toml
```

`shadow` is the default. It records inbound messages without replying or invoking host capabilities. Change `mode` to `active` only after the Feishu listener and approval recipient pass `doctor`.

The runtime binds only to `127.0.0.1`. Its SQLite database, attachments, replies, approvals, and Codex thread state stay on the deploying user's computer. Host writes follow the configured trust and approval policy and retain execution/authorization records; owner exemptions or automatic turn approval may avoid an interactive approval card. Trusted senders, approval recipient, prompts, and message settings are persisted in SQLite after their initial deployment defaults are applied.

Keep the control plane local; it is not a multi-user or internet-facing server.
Host capability registration and invocation require a nonempty runtime token
(`runtime_token` in TOML or `LARK_AGENT_RUNTIME_TOKEN`) and its Bearer header.
The host and SDK must use the same token. Built-in `lark.*` capability IDs are
reserved and cannot be replaced by a host to change their approval risk.
The default database is `./lark-agent.sqlite`; an explicitly configured database
path takes precedence. Keep using the same path across upgrades.

The Feishu Codex model is persisted as `codexModel` in runtime settings. It is
passed only to `thread/start`; `thread/resume`, `turn/start`, and `turn/steer`
preserve the model already attached to an existing thread. Changing the setting
therefore affects only conversations that create a new Codex thread.

## Testing

Run automated tests with `npm test`. Every test store must use a newly created SQLite file under the operating system temporary directory. `SqliteAgentStore` detects Node test processes and refuses to open the persistent `data/lark-agent.sqlite`, any configured runtime database, or an arbitrary non-temporary path.

Do not run individual `*.test.ts` files directly or set `LARK_AGENT_DATABASE` for tests. Real App Server verification scripts also use isolated temporary directories; they must never point their writable database argument at an existing runtime database.

## Forge Host Integration

Run Forge with `LARK_AGENT_URL=http://127.0.0.1:4780` and the shared runtime/host tokens. Forge registers PR review, issue triage and todo capabilities; deployment tools are optional and require the host's local adapter configuration. Its message page and listener switch proxy the standalone runtime; it does not start the legacy listener while this URL is configured.

Registered host capabilities are exposed to each Codex thread through App Server Dynamic Tools. The tool callback carries the current thread and turn, so the runtime can bind the call to the exact Feishu message and trust scope before invoking the host. Text and media deliveries are durable and idempotent; failed media remains in `lark_delivery_outbox` for bounded retry.

Spontaneous group replies also require an exact chat ID in `groupSpontaneousChatIds`
(GET/PATCH `/v1/settings`). The default empty list permits no spontaneous replies.
The global switch, sampling and cooldown still apply; direct mentions and private
messages are not restricted by this allowlist.

`GET /v1/contact-conversations?chat_type=group` lists stored group conversations;
the default remains `p2p`. Group timelines use
`/v1/contact-conversations/<oc_chat_id>/messages` with the existing cursor pagination.
Conversation summaries include `chatType`, `chatId` and `codexSessionIds`.

Conversation personas are stored per Feishu `chat_id` in the runtime database.
GET/PUT `/v1/chats/:chatId/persona` reads/saves a default or custom persona;
POST `/v1/chats/:chatId/persona/preview` previews without saving. These routes use
runtime-token authentication when a token is configured. A custom persona replaces the entire global default
persona in the model input; the two style prompts are never injected together.
Factuality, complete answers, progress privacy, permissions, approvals and tool
protocols remain independent of persona selection. New turns capture the current
persona and global prompt; steers retain their active turn's snapshot. The used
persona version and global-prompt hash are recorded in `resume-session.json`.
Sticker search and selection use a process-local stdio MCP server. Existing
threads can use it after resume, including threads created before the sticker
tools existed. Selection does not send: the outbox waits for the current final
text's delivery receipt before sending one sticker. See
[the sticker tool contract](docs/sticker-prompt-contract.md),
`npm run test:sticker-tools`, and `npm run test:sticker-mcp-resume`
(real Codex, simulated Feishu delivery).
Current and directly quoted images, including multiple images in a rich-text
message, are downloaded for the current turn without depending on old Codex
context. The same MCP process also offers read-only history image search/open:
only the current chat and topic, before the current message, and only candidates
returned by the latest search. Group history lookup is limited to trusted
senders; private chats stay within that chat. At most four historical images
can be opened per turn. Download failures are recorded rather than presented
as images the model has seen.
Generated images and documents use the same MCP service's `attach_files` tool.
It validates and snapshots files under the current message's `output/` directory;
registration does not send. On normal turn completion, the existing durable
outbox delivers image groups and individual documents after the final text
receipt, or as an attachment-only reply. Failed/cancelled turns do not send staged
files. Valid legacy media tags remain compatible; malformed tags are reported
rather than forwarded as reply text. See [the attachment tool contract](docs/attachment-tools.md)
for scope, limits, retries and completion signals.

Final replies use [Markdown posts and data cards](docs/rich-replies.md).
Optional [native topic conversations](docs/native-topics.md) continue an explicitly
joined topic without repeated mentions, using compact incremental input. This
mode is off by default; disabling it retains the existing group behavior.
Large results retain their complete Markdown as a reliably delivered attachment;
history keeps readable original text rather than card JSON.
The hash tracks the captured default prompt, even when custom mode omits its text.
Existing saved prompt overrides are preserved and used only in default mode;
do not store authorization requirements in the editable persona field.

Optional [owner-mention assistance](docs/owner-mention-assist.md) lets the bot help
when another group member mentions a configured person. It is off by default,
with global and per-group inherit/on/off settings. The same turn decides whether
to help, prepare a private draft or stay quiet. New replies from that person are
fed back for supplementation, not treated as an unconditional cancellation.
Draft review publishes as the bot and never grants execution authority.

The authenticated host API also exposes `POST /v1/internal/outbound` for delayed workflow notifications. A host may send to a configured contact or reply to a stored source-message ID; group replies automatically mention the original sender. The runtime token and loopback binding protect this endpoint, and callers must provide a stable idempotency key.

Write-risk capabilities and observed mutating App Server commands produce a
separate Feishu execution receipt. A receipt distinguishes `executed` from
`verified`; only explicit host verification metadata can produce `verified`.

In active mode, the existing receipt reaction is kept. After a native Codex
turn completes normally and its final text/attachments have been delivered,
the bot also adds a `DONE` reaction to every original message handled by that
turn, including messages merged through steer. Intentional no-reply completion
also gets this signal. Failed, interrupted or approval-rejected turns do not.
`DONE` means this processing turn ended, not independent business verification.
Completion reactions use the durable outbox with at most eight send attempts;
reaction failures never change a successful text reply into a failed task.
Only newly completed turns are marked; historical tasks are not backfilled.

## Layout

- `packages/core`: conversation, trust, and capability contracts.
- `packages/adapter-sqlite`: default durable state and outbox model.
- `packages/adapter-lark-cli`: Feishu event parsing, replies, media, reactions, and approval cards.
- `packages/adapter-codex-app-server`: the shared App Server client and executable resolution.
- `packages/conversation-runtime`: sessions, context, worker policy, approvals, contacts, stickers, and Codex turn orchestration.
- `apps/runtime`: local HTTP runtime on port `4780`.
- `apps/cli`: `lark-agent serve --config` and `lark-agent doctor --config`.

The completed Forge migration is preserved in Git history and
`docs/forge-parity-matrix.md`; no migration-only package participates in the runtime.

Agent Forge is intentionally not a dependency. Its private capability adapter lives in the Forge repository and is registered through the SDK during host integration.

The optional local supervisor discovers Forge in a sibling `agent-forge` or
`autofix-console` directory. Set `LARK_AGENT_FORGE_ROOT` for another location;
without Forge and its local launcher it supervises only Lark Agent. `tmux` is
resolved from PATH, or `TMUX_EXECUTABLE`. Operator credentials and local config
remain outside the tracked source.

See [repository synchronization](docs/repository-sync.md) for one-main/two-remote
updates without repeatedly rewriting publication history.
