import type Database from "better-sqlite3";
import {
  drainLarkProgressCards,
  observeLarkProgressCards,
  retryPendingLarkCompletionReactions,
  retryPendingLarkProgressCards
} from "@lark-agent/conversation-runtime";

export function mountProgressCardsPlugin(database: Database.Database) {
  const stop = observeLarkProgressCards(database);
  return {
    stop,
    drain: () => drainLarkProgressCards(database),
    tick: () => retryPendingLarkProgressCards(database)
  };
}

export function mountCompletionReactionsPlugin() {
  return { tick: () => retryPendingLarkCompletionReactions() };
}
