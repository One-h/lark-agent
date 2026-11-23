# Lark Agent crash recovery

This version supports one runtime per SQLite database. It does not require
a rolling deployment, move a live engine connection, or replay messages
that never reached local storage.

## Execution

| Durable state | Startup decision |
| --- | --- |
| Input admitted, or preparation started without crossing the submission boundary | Resume the queue, after rechecking source, message, workspace, route, actor and current reply policy. |
| About to submit or submitted to Codex/ACP; no committed finalization | Check the original engine turn and recover only from positive evidence. Block a manual replay while the outcome is uncertain. |
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
readback records the exact engine status and retrieves a complete item page
before doing anything with a terminal result. A matching single-input turn
with no tools, approvals, or staged media can deliver its confirmed final
text without starting the engine again. A failed or interrupted turn that
also has a recorded read-only policy can requeue the same input once, with
fresh authorizations. Partial pages, newer work, or tool activity prevent
automatic replay. Terminal engine status alone does not prove a business
write. An active turn is polled, not attached: current stdio-owned Codex/ACP
sessions and permission callbacks cannot be rebound after worker loss.

## Delivery

Codex and ACP commit final states and their existing text/media delivery
plans before network sends. The existing IDs, privacy checks, snapshots,
attachment integrity checks and in-process retries continue to apply.
Recovery reuses committed pending delivery intents with no send attempt
or with explicit proof that the CLI never started, and preserves confirmed
local receipts. A later non-send does not clear an earlier uncertain attempt.
For attempted text/post/card replies, the runtime uses read-only Feishu
history to look for one exact match by destination, quoted parent, bot,
attempt time and payload. A positive match repairs the receipt without
sending. Missing history, partial pages or mismatched content do not prove
non-delivery. Unresolved attempts (including attempted attachments and
legacy rows without attempt evidence) remain held. The design does not assume
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
