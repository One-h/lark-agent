import { bindLarkBuiltinPlugins, larkBuiltinPluginEnabled, registerLarkRuntimePlugin,
  type LarkBuiltinPluginId, type LarkRuntimePlugin, type resolveLarkBuiltinPlugins } from "@lark-agent/conversation-runtime";
import type { SqliteAgentStore } from "@lark-agent/adapter-sqlite";

export function createLarkPluginHost(store: SqliteAgentStore, states: ReturnType<typeof resolveLarkBuiltinPlugins>) {
  bindLarkBuiltinPlugins(store.db, states);
  const mounted = new Set<LarkBuiltinPluginId>();
  const cleanups: Array<() => void> = [];
  const starters = new Map<LarkBuiltinPluginId, () => void>();
  const jobs = new Map<LarkBuiltinPluginId, () => void | Promise<void>>();
  const busy = new Set<LarkBuiltinPluginId>();
  let closing = false, closed = false;
  const enabled = (id: LarkBuiltinPluginId) => larkBuiltinPluginEnabled(store.db, id);
  return {
    enabled,
    mount<T>(id: LarkBuiltinPluginId, setup: () => T): T | undefined {
      if (!enabled(id)) return;
      if (closing || mounted.has(id)) throw new Error("Invalid Lark built-in plugin mount: " + id);
      const result = setup();
      mounted.add(id);
      return result;
    },
    own(dispose: () => void) { cleanups.push(dispose); },
    startup(id: LarkBuiltinPluginId, start: () => void) {
      if (mounted.has(id)) starters.set(id, start);
    },
    start() {
      if (closing) return;
      for (const [id, start] of starters) {
        starters.delete(id);
        start();
      }
    },
    register(plugin: LarkRuntimePlugin) {
      if (closing) throw new Error("Lark plugin host is stopping");
      cleanups.push(registerLarkRuntimePlugin(store.db, plugin));
    },
    maintenance(id: LarkBuiltinPluginId, job: () => void | Promise<void>) {
      if (mounted.has(id)) jobs.set(id, job);
    },
    tick() {
      if (closing) return;
      for (const [id, job] of jobs) {
        if (busy.has(id)) continue;
        busy.add(id);
        void Promise.resolve().then(() => { if (!closing) return job(); })
          .catch(() => console.warn("lark_plugin_maintenance_failed", { id }))
          .finally(() => busy.delete(id));
      }
    },
    pause() { closing = true; },
    close() {
      closing = true;
      if (closed) return;
      closed = true;
      starters.clear();
      jobs.clear();
      for (const dispose of cleanups.reverse()) {
        try { dispose(); } catch { console.warn("lark_plugin_dispose_failed"); }
      }
      cleanups.length = 0;
    },
    status: () => states.map(state => ({ ...state, mounted: mounted.has(state.id) }))
  };
}
