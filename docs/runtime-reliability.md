# Local runtime reliability

## Keep child processes on the same runtime

The server may stay alive with an already-loaded library while newly spawned
CLI processes fail to load it. A process check is therefore insufficient.

- Install a fixed official Node 24 distribution outside Homebrew's mutable
  dependency tree. Verify its archive against the official SHA-256 manifest.
- Keep a fixed local copy of the validated Lark CLI package. Its wrapper must
  invoke that exact Node executable, rather than rely on a global shebang.
- Prepend both pinned directories to the server PATH. Event consumers use a
  non-login shell so the system profile cannot rewrite that PATH.
- Before starting the server, verify the SQLite native module with an in-memory
  database, CLI startup, and Codex startup. Never use the persistent database as
  a preflight/test fixture. Do not fake compatibility by symlinking one dynamic
  library ABI version to a different version.
- Deployment-specific binaries, wrappers, credentials, snapshots and logs stay
  in ignored `data/local/`; do not commit them or automatically upgrade them.

## Distinguish liveness, local health and authorization

- `/v1/live`: process responds, not proof of message delivery.
- `/v1/health`: a freshly launched CLI and required listeners work. Returns 503
  on dependency/listener failures. Includes pending and historical failed text
  counts; historical failures are not silently cleared or replayed.
- `/v1/readiness`: local health plus a verified, available bot identity. Auth
  output is parsed into a bounded status, never returned verbatim.
- CLI probe: 2-second timeout, 10-second cache. Auth probe: 8-second timeout,
  60-second cache. Concurrent requests share an in-flight probe. Neither probe
  sends messages or calls a model.

Actual delivery acceptance still requires a real incoming message, a completed
turn, a successful outbound receipt, and a platform readback of that receipt.
Do not impersonate the user to manufacture this evidence.

## Managed recovery

`scripts/supervise-local-services.ts` checks the existing managed tmux sessions
every 15 seconds. It refuses duplicate startup on occupied ports and only
restarts a process after three failed local probes, zero active turns, and a
matching process ancestry in the managed pane.

There are at most three automatic starts/restarts per hour, separated by at least
one minute. The budget is atomically persisted in ignored
`data/local/recovery-budget.json` and survives supervisor restart. Invalid budget
state fails closed for manual inspection.

Unreadable health or active turns do not authorize killing a process. Network
or bot-authorization failures are reported as degraded, not treated as reasons
for an unlimited restart loop. Shutdown stops new event consumers and drains
active turns before closing the database.

The service supervisor records state transitions. Keep diagnostic UI access
available while transport readiness is degraded. Do not re-enable the legacy
Forge responder or reset/import persistent conversation data during recovery.

Regression tests use freshly created OS-temporary databases and fake commands.
The listener environment test only resolves an executable and must never
subscribe to real Feishu events. Run `npm test` and `npm run build` with the
deployment's pinned Node version before activation.
