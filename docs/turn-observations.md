# Internal turn observations

Codex and ACP report the same two observations. Registration is internal
code only: this interface neither loads plugins nor grants context or
execution access.

| Event | Meaning |
| --- | --- |
| `turn.progress` | A displayable progress summary at the existing progress eligibility point. Short turns may emit none. |
| `turn.finished` | The responder recorded a terminal run outcome. This is not a Feishu delivery receipt. |

Both provide a logical `runId`, the current engine turn and thread IDs,
and the source message row ID. A native retry can replace the engine
turn ID without starting a new progress card. Progress also carries a
key and bounded summary. Observers receive a frozen flat snapshot, not
the raw event, full message, tool arguments, or tool authorization.

Publishing does not wait for observers. Each subscription has its own
bounded FIFO with priority for terminal observations when dropping
progress. A handler error is logged without affecting other consumers.
A timed-out or saturated subscription stops accepting work; timeouts
abort its signal and do not imply forcible interruption of in-process
code. These trusted internal callbacks must not block the event loop.

The progress-card subscriber hands work off to the existing SQLite
progress queue. Rate limits, pending-card recovery and retry rules
continue to live there. Shutdown drains that subscriber and card queue,
not arbitrary observers. The observation queue is not replayed on
restart. Receipt hooks and durable delivery workflows are out of scope.
