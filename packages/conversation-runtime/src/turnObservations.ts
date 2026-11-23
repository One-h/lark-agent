type TurnIdentity = { runId: string; turnId: string; threadId: string; sourceMessageId: number };
export type LarkTurnObservation = Readonly<TurnIdentity & (
  | { kind: "turn.progress"; progressKey: string; summary: string }
  | { kind: "turn.finished"; outcome: "completed" | "failed" | "cancelled" | "interrupted" }
)>;

type Observer = { enqueue(event: LarkTurnObservation): void };
type Handler = (event: LarkTurnObservation, signal: AbortSignal) => void | Promise<void>;
const observers = new WeakMap<object, Set<Observer>>();
const queueLimit = 64;

export function onLarkTurnObservation(scope: object, handler: Handler, { timeoutMs = 2_000 }: { timeoutMs?: number } = {}) {
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
      if (closed) return;
      if (queue.length === queueLimit) {
        if (event.kind === "turn.progress") return;
        const discard = queue.findIndex(item => item.kind === "turn.progress");
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
