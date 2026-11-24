# Runtime extension contracts

Runtime modules and explicitly registered, trusted in-repository plugins can
use these hooks. A plugin is not a sandbox or an execution permission.
Fastify's composition root accepts an explicit `plugins` list.

```ts
const example = {
  id: "example-observer",
  events: ["turn.finished"] as const,
  observe(event: LarkTurnObservation) {
    if (event.kind === "turn.finished") countOutcome(event.outcome);
  }
} satisfies LarkRuntimePlugin;

createRuntime({ ...runtimeOptions, plugins: [example] });
```

| Hook | Evidence and scope |
| --- | --- |
| `message.route` | A listener-verified group reply can propose an existing broker claim from frozen message/chat/requester/quote identifiers. The broker rechecks registered scope, and its single winning local write commits with admission. A competing claim falls through. The privacy gate runs first. |
| `turn.prepare` | A trusted contributor can return a bounded reference fragment for a new turn. All contributors see the same immutable input. Fragments are ordered by plugin ID, limited to 1,200 characters each within a 3,200-character section budget, and time out at 250 ms. They do not alter policies, tools, or approvals and do not rerun on attach or steering. |
| `turn.dispatched` | A new turn acquires a runtime execution binding. It is not proof of engine input acceptance. |
| `turn.inputAccepted` | Codex acknowledged start/steer, or ACP reported an output/tool event or a completed result for the input. ACP steering must explicitly report injection. A hosted first-input observation is recorded once even if Lark relaunches. Local admission alone is not acceptance. |
| `turn.progress` | A displayable bounded summary. Short tasks can emit none. |
| `turn.finished` | The responder committed a terminal run outcome. Media and text delivery can still be pending. |
| `reply.delivered` | A final text/rich reply for an answered turn has a committed send receipt or exact readback. It does not imply all media delivered. |
| `delivery.confirmed` | A concrete reply, attachment, sticker, or notice has an explicit platform receipt that was committed. The journal assigns a stable `eventId`; unknown sends and successful transport exits without a receipt do not emit this event. |

Observation payloads are frozen flat snapshots. Each subscriber has its own
bounded asynchronous queue, kind filter and abort signal. Completion and
receipts take priority over informational events. Errors and timeouts do not
change core state or block other subscriptions; callbacks must not block the
process event loop. No observation grants authorization.

The progress-card observer only subscribes to progress and completion. A
restart does not replay the in-memory observer queue. Durable delivery
consumers page through `readLarkDeliveryConfirmations(database, after, limit)`
using the last committed `eventId`. They own deduplication and checkpointing.
The journal contains no body or tool parameters and does not resend content.
DONE, sticker and media dependencies stay with their owning delivery modules.
