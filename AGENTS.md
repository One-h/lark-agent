# Lark Agent Repository Rules

These rules apply to the entire repository.

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
