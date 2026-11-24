export const larkBuiltinPluginIds = [
  "managed-chats", "agent-outreach", "group-question", "personal-inbox",
  "owner-assist", "native-topics", "progress-cards", "completion-reactions", "stickers"
] as const;
export type LarkBuiltinPluginId = typeof larkBuiltinPluginIds[number];

const dependencies: Partial<Record<LarkBuiltinPluginId, readonly LarkBuiltinPluginId[]>> = {
  "group-question": ["agent-outreach"]
};
type PluginState = Readonly<{ id: LarkBuiltinPluginId; enabled: boolean; blockedBy: readonly LarkBuiltinPluginId[] }>;
const policies = new WeakMap<object, ReadonlyMap<LarkBuiltinPluginId, PluginState>>();
const known = new Set<string>(larkBuiltinPluginIds);
const builtinCapabilities = new Map<string, LarkBuiltinPluginId>([
  ["lark.chat.create","managed-chats"], ["lark.chat.list_managed","managed-chats"],
  ["lark.group.ask","group-question"], ["lark.group.ask_reply","group-question"]
]);

export function resolveLarkBuiltinPlugins(disabled: readonly string[] = []): readonly PluginState[] {
  for (const id of disabled) if (!known.has(id)) throw new Error("Unknown Lark built-in plugin: " + id);
  const excluded = new Set<string>(disabled);
  return larkBuiltinPluginIds.map(id => {
    const blockedBy = (dependencies[id] ?? []).filter(dependency => excluded.has(dependency));
    return Object.freeze({ id, enabled: !excluded.has(id) && blockedBy.length === 0, blockedBy: Object.freeze(blockedBy) });
  });
}

export function bindLarkBuiltinPlugins(scope: object, states: readonly PluginState[]): void {
  policies.set(scope, new Map(states.map(state => [state.id, state])));
}

export function larkBuiltinPluginEnabled(scope: object | null | undefined, id: LarkBuiltinPluginId): boolean {
  return !scope || (policies.get(scope)?.get(id)?.enabled ?? true);
}

export function larkBuiltinCapabilityEnabled(scope: object | null | undefined, capabilityId: string): boolean {
  const owner = builtinCapabilities.get(capabilityId);
  return !owner || larkBuiltinPluginEnabled(scope, owner);
}
