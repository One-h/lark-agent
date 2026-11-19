export type ExecutionEngineRoute = { engineId: string; model: string | null };

export type ExecutionEngineDescriptor = {
  id: string;
  label: string;
  models: readonly string[];
};

export type ExecutionTurnResult =
  | { status: "completed"; text: string }
  | { status: "cancelled" };
export type ExecutionEngineEvent = { type: "text-delta"; text: string };

export interface ExecutionEngineSession {
  readonly id: string;
  run(text: string, signal: AbortSignal, onEvent?: (event: ExecutionEngineEvent) => void): Promise<ExecutionTurnResult>;
  // "idle" means the engine explicitly did not consume the input.
  steer?(text: string, signal: AbortSignal): Promise<"injected" | "idle">;
  close(): void;
}

export interface ExecutionEngine {
  readonly descriptor: ExecutionEngineDescriptor;
  open(input: { sessionId: string | null; model: string | null; signal: AbortSignal }): Promise<ExecutionEngineSession>;
}

export class ExecutionEngineRegistry {
  private readonly engines = new Map<string, ExecutionEngine>();

  register(engine: ExecutionEngine): void {
    const id = engine.descriptor.id;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || id === "codex" || this.engines.has(id)) {
      throw new Error("Invalid or duplicate external execution engine ID");
    }
    this.engines.set(id, engine);
  }

  list(): ExecutionEngineDescriptor[] {
    return [...this.engines.values()].map(({ descriptor }) => descriptor);
  }

  resolve(route: ExecutionEngineRoute): ExecutionEngine | undefined {
    const engine = this.engines.get(route.engineId);
    if (!engine || route.model !== null && !engine.descriptor.models.includes(route.model)) return;
    return engine;
  }
}
