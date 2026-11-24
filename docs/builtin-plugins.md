# Built-in plugins

The runtime mounts trusted in-repository plugins explicitly. Built-ins other
than task orchestration are enabled by default. Existing workspace/chat settings and authorization
requirements still apply. Changing the operator list takes effect at the next
Lark startup. This is not an external plugin loader.

```sh
export LARK_AGENT_DISABLED_PLUGINS=progress-cards,completion-reactions
```

Use the authenticated `GET /v1/plugins` endpoint to inspect the configured
availability, mounted state, and blocked dependencies. Unknown IDs fail
startup; no silent fallback changes the intended selection.

| ID | Feature | Effect of disabling |
| --- | --- | --- |
| `managed-chats` | Owner-controlled managed chat create/list | Routes and MCP capabilities unavailable; groups and history retained |
| `agent-outreach` | Agent messaging, reply forwarding and its worker | Routes and worker stop; open requests kept; group-question becomes unavailable |
| `group-question` | Scoped cross-group question and verified quote handling | Ask/read tools and route broker unavailable; registered requests retained |
| `personal-inbox` | Personal inbox, review routes and polling | Worker and routes unavailable; history retained |
| `owner-assist` | Group mention assistance and drafts | No new assist turns, draft notifications or stale-publication bypass |
| `native-topics` | Explicit topic enrollment and automatic continuation | Continuation paused without resetting saved enrollment or engine routing |
| `progress-cards` | Progress observer and card queue | Observer and card retries paused |
| `completion-reactions` | DONE reaction after verified dependencies | No new DONE work or queued reaction sends while disabled |
| `stickers` | Sticker library and optional sticker output | Library routes, new sticker use and queued sticker sends paused; normal media and core MCP routes stay available |
| `task-orchestration` | Optional [delegated tasks](task-orchestration.md) | No task tool or background scheduling; prior tasks retained |

When restored, the owning module applies its original eligibility, expiry and
unknown-outcome rules. Restarting does not grant permissions or replay an
uncertain external mutation. Group privacy, identity, approvals, engine
selection, core delivery and conversation history remain runtime-owned.

Add built-ins at the composition root with feature-owned routes and explicit
startup/maintenance hooks. Existing generic Hook contributors can be passed
as `plugins` to `createRuntime`; reserve `builtin-*` for bundled modules.
See [the lifecycle contracts](turn-observations.md).
# Optional Task Orchestration

The task-orchestration plugin is off by default. See [Delegated Tasks](task-orchestration.md) for opt-in configuration, engine requirements and recovery behavior.
