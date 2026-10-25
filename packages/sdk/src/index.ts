import type { Capability } from "@lark-agent/core";

export class LarkAgentClient {
  constructor(private readonly input: { baseUrl: string; token?: string }) {}
  async health(): Promise<unknown> { return this.request("/v1/health"); }
  async registerCapabilities(capabilities: Array<Pick<Capability, "id" | "title" | "description" | "inputSchema" | "risk">>): Promise<unknown> { return this.request("/v1/capabilities/register", { method: "POST", body: JSON.stringify({ capabilities }) }); }
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.input.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers: { "content-type": "application/json", ...(this.input.token ? { authorization: `Bearer ${this.input.token}` } : {}), ...init.headers } });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
}
