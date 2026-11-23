# Lark Agent crash recovery

This version supports one runtime per SQLite database. It does not require
a rolling deployment, move a live engine connection, or replay messages
that never reached local storage.

## Execution

| Durable state | Startup decision |
| --- | --- |
| Input admitted, or preparation started without crossing the submission boundary | Resume the queue, after rechecking source, message, workspace, route, actor and current reply policy. |
| About to submit or submitted to Codex/ACP; no committed finalization | Mark the outcome as needing review. Do not run the message again, even through the normal retry endpoint. |
| Final state and delivery plan committed | Do not call the engine. Process only safe delivery intents. |
| Historical queued/running row without a versioned dispatch record | Mark the outcome as needing review. Do not infer that it was safe to replay. |

Received-message storage and normal reply admission share one SQLite
transaction. For a new or steered turn, the submission marker is written
before crossing into engine IPC. An interrupted tool invocation is not
proof of failure at the downstream service. Pending native and host
approvals are invalidated, never recorded as human rejections.
Owner-assistance input keeps its separate private-review policy and is not
automatically requeued on restart.

For interrupted Codex turns with a saved thread and turn ID, a bounded
readback records the exact engine status when available. It does not
resume or start a turn, reconstruct a reply from engine history, or
infer the outcome of a write. Even an active turn is only evidence: our
stdio-owned Codex/ACP sessions and pending permission callbacks are not
reattachable after worker loss. ACP recovery does not claim readback
support for an adapter that only restores conversation history.

## Delivery

Codex and ACP commit final states and their existing text/media delivery
plans before network sends. The existing IDs, privacy checks, snapshots,
attachment integrity checks and in-process retries continue to apply.
Recovery reuses committed pending delivery intents with no send attempt
or with explicit proof that the CLI never started, and preserves confirmed
local receipts. A later non-send does not clear an earlier uncertain attempt. If an outbound
text, attachment, media notice, or execution receipt might have reached
Feishu but no receipt was recorded, it is held for review and is not
automatically resent on restart. Legacy unresolved delivery records
lacking attempt evidence are also held. The design does not assume
the provider's idempotency window lasts through arbitrary downtime.

Use the message's `codex_dispatch_phase`, `codex_error`,
`codex_recovery_engine_status`, and delivery status to distinguish
execution from delivery in diagnostics. Old approval cards can still be
visible, but can no longer authorize anything.

## Scope and verification

Schema changes are additive. This is recovery after process loss, not
a hot handoff to another owner. No gateway/worker split, engine prompts
replayed from history, or Feishu delivery during downtime is implied.
Previously staged cross-group dispatch and progress/reaction lifecycles
retain their own recovery contracts.

Before rolling back to a build without these guards, drain safe queues and
review unresolved execution and delivery records. Old code does not enforce
the replay prohibition. Do not clear recovery markers to enable a retry.

The crash fixture exits an isolated runtime process immediately before an
engine result and during delivery before the receipt can be recorded,
then reopens the same temporary database. Additional tests cover
transaction rollback at admission, redelivery, source changes, old
approvals, text/media replay and native readback.
