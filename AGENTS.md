# Lark Agent Repository Rules

These rules apply to the entire repository.

## Development Framework

- Use Node 24, TypeScript workspaces, Fastify for HTTP, and the SQLite adapter
  for durable state. Run `npm run build` and `npm test` before handoff.
- `apps/runtime` is the composition root: it wires the listener, trusted
  plugins, policies, routes and managed shutdown. Keep execution-agnostic
  conversation flow in `packages/conversation-runtime` and provider details
  in the appropriately scoped engine or Lark adapter. Keep engine selection
  and session ownership out of business plugins.
- SQLite is the source of truth for admission, acceptance, pending approval,
  delivery and reconciliation. Commit before publishing observations. Keep
  Feishu transport and MCP behind the existing core capabilities and
  authorization checks. Recover an original operation by identity and
  evidence; do not reissue an uncertain call based on an observer event.

## Hooks And Plugins

- Plugins are trusted, in-repository code. Declare a unique ID and pass
  explicit `plugins` to `createRuntime`. Use `registerLarkRuntimePlugin`
  for an internal consumer that owns its registration lifetime. There is no
  external module discovery, runtime downloader, plugin sandbox or hot loader.
- Built-in plugin composition lives under `apps/runtime/src/plugins`. The
  runtime validates declared IDs and dependencies before starting background
  services. A disabled plugin must not register feature routes, advertise or
  execute its capabilities, or dispatch persisted work. Do not delete history
  or stored feature settings to implement a pause. Test both default
  compatibility and disablement; keep authorization in core.
- Operators can set `LARK_AGENT_DISABLED_PLUGINS` to a comma-separated list
  before starting Lark. Never use a plugin setting to bypass the group privacy
  gate, native approval, trusted sender checks or the shared delivery outbox.
  See [the built-in plugin guide](docs/builtin-plugins.md).
- `message.route` proposals see a frozen, verified group-reply identity.
  They cannot consume a message. Only a core-registered route broker can
  verify its claimed scope and save both the claim's work and inbound row in
  one SQLite transaction. Competing valid claims fall through to the ordinary
  trusted route. Keep the privacy gate ahead of any plugin routing. Never
  send a message or start a model in a proposal or broker commit.
- `turn.prepare` contributors receive the same bounded source input and
  return reference fragments. The runtime applies timeouts, deterministic
  ordering and one aggregate budget. Do not mutate shared prompts, read
  another plugin's fragment, or add identity, tool grants or approvals.
- Use the observation API for dispatch, input acceptance, progress, terminal
  state and delivery. Select only the required events. Keep payloads small
  and immutable; never expose raw events, transcripts, commands or tokens.
  Decide based on the recorded fact, not hook ordering. A terminal turn is
  not a delivery receipt, and a local queue entry is not accepted input.
- For a reliable delivery consumer, read the receipt journal with
  `readLarkDeliveryConfirmations` and checkpoint by `eventId` in the
  owning module. Do not start business side effects from a best-effort
  observation alone; use the authorized core capability and its dedupe key.
- Before adding a hook, state its producer, ownership, evidence, replay
  semantics and failure behavior. Test Codex and ACP where relevant, plus
  a conflict, timeout or restart case appropriate to the new boundary.
  See [the extension contract](docs/turn-observations.md).

## Shared Public Main

- Internal and public repositories share one sanitized main. Publish with `npm run sync:main`; both remote main refs must read back the same commit before reporting success.
- Run `npm run publication:check` before publishing. The private denylist is stored in the local Git common directory as `publication-policy.json`, never in tracked source. See `docs/repository-sync.md`.
- Do not merge pre-sanitization history or publish internal archive refs, all refs, or tags. Keep private endpoints, identities, data sources and credentials in local configuration. Preserve historical contributor attribution only in the internal archive when anonymization is required.

## Database Safety

- Treat `data/lark-agent.sqlite`, any configured `LARK_AGENT_DATABASE`, and their `-wal` / `-shm` files as persistent user data. Never delete, replace, truncate, reset, or use them as test fixtures.
- Run automated tests through `npm test`. Test databases must be newly created beneath the operating system temporary directory and must never reuse a database that existed before the test began.
- Do not point tests, verification scripts, migrations, imports, or ad hoc cleanup commands at the configured runtime database. Read-only inspection must open the database explicitly as read-only.
- `SqliteAgentStore` performs migrations during construction, including legacy-table cleanup. Resolve and validate the database path before constructing it.
- Any test that needs seeded state must create and later remove its own temporary directory. A filename containing `test`, `fixture`, or `sqlite` is not sufficient proof that the database is disposable.
- Destructive recovery, history import into an existing target, or database replacement requires an explicit user request naming the exact database and a verified backup.

## Service Lifecycle

- Use one managed tmux session for this checkout on loopback port `4780`; reuse an existing checkout session, or use `lark-agent-runtime` / `LARK_AGENT_TMUX_SESSION` for a new install.
- Do not start additional runtime instances against the same database. Before restarting, wait for active turns to finish and verify the session, port, and `/v1/health` afterward.
- Also wait for `/v1/health` `activeOwnerAssists` to reach zero before a restart; private notifications and draft confirmation may still be in flight after a native turn ends.
