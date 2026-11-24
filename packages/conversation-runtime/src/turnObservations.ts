type TurnIdentity = { runId: string; turnId: string; threadId: string; sourceMessageId: number };
export type LarkTurnObservation = Readonly<TurnIdentity & (
  | { kind: "turn.dispatched"; engineId: string }
  | { kind: "turn.inputAccepted"; engineId: string; input: "first" | "steered" }
  | { kind: "turn.progress"; progressKey: string; summary: string }
  | { kind: "turn.finished"; outcome: "completed" | "failed" | "cancelled" | "interrupted" }
  | { kind: "reply.delivered"; confirmation: "send" | "readback" }
  | { kind: "delivery.confirmed"; deliveryKind: "reply" | "attachment" | "sticker" | "notice";
      eventId: number; confirmation: "send" | "readback"; confirmedAt: string }
)>;

type Observer = { enqueue(event: LarkTurnObservation): void };
type Handler = (event: LarkTurnObservation, signal: AbortSignal) => void | Promise<void>;
const observers = new WeakMap<object, Set<Observer>>();
const queueLimit = 64;
const isInformational = (event: LarkTurnObservation) =>
  event.kind === "turn.progress" || event.kind === "turn.dispatched" || event.kind === "turn.inputAccepted";

export function onLarkTurnObservation(scope: object, handler: Handler,
  { timeoutMs = 2_000, kinds }: { timeoutMs?: number; kinds?: readonly LarkTurnObservation["kind"][] } = {}) {
  const selected = kinds && new Set(kinds);
  let members = observers.get(scope);
  if (!members) { members = new Set(); observers.set(scope, members); }
  const queue: LarkTurnObservation[] = [];
  let pump: Promise<void> | undefined;
  let current: AbortController | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    members.delete(observer);
    queue.length = 0;
    current?.abort();
  };
  const run = async () => {
    while (!closed && queue.length) {
      const event = queue.shift()!;
      const controller = current = new AbortController();
      const timer = setTimeout(() => {
        console.warn("lark_turn_observer_timeout");
        close();
      }, timeoutMs);
      const aborted = new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      try {
        await Promise.race([handler(event, controller.signal), aborted]);
      } catch {
        console.warn("lark_turn_observer_failed");
      } finally {
        clearTimeout(timer);
        current = undefined;
      }
    }
  };
  const schedule = () => {
    if (!pump && !closed && queue.length) pump = Promise.resolve().then(run).finally(() => {
      pump = undefined;
      schedule();
    });
  };
  const observer: Observer = {
    enqueue(event) {
      if (closed || selected && !selected.has(event.kind)) return;
      if (queue.length === queueLimit) {
        if (isInformational(event)) return;
        const discard = queue.findIndex(isInformational);
        if (discard === -1) {
          console.warn("lark_turn_observer_overflow");
          close();
          return;
        }
        queue.splice(discard, 1);
      }
      queue.push(event);
      schedule();
    },
  };
  members.add(observer);
  return { close, async drain() { while (pump) await pump; } };
}

export function publishLarkTurnObservation(scope: object, event: LarkTurnObservation): void {
  const members = observers.get(scope);
  if (!members?.size) return;
  // The payload is flat and contains no message row, tool arguments or capabilities.
  const snapshot = Object.freeze({ ...event });
  for (const member of members) member.enqueue(snapshot);
}
