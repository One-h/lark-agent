import { setTimeout as delay } from "node:timers/promises";
import { larkShutdownBlockingTurnCount, stopLarkMessageWorker } from "@lark-agent/conversation-runtime";

export function registerLarkSignalShutdown(
  runtime: { app: { close(): Promise<void> }; stop(): void },
  stopRecovery: () => void
): void {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRecovery();
    stopLarkMessageWorker();
    // Independently owned, journaled turns are detached by preClose.
    // Local turns and in-flight submissions still have to drain.
    while (larkShutdownBlockingTurnCount() > 0) await delay(250);
    await runtime.app.close();
    runtime.stop();
    process.exit(0);
  };
  const onSignal = () => { void shutdown().catch(() => { console.error("lark_runtime_shutdown_failed"); process.exit(1); }); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
