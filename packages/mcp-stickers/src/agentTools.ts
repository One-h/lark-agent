import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { postHostJson } from "../../conversation-runtime/src/hostHttp.js";

const runtime = new URL(process.env.LARK_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4780");
const token = process.env.LARK_AGENT_MCP_TOKEN?.trim();
if (runtime.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(runtime.hostname)
  || runtime.username || runtime.password || !token) throw new Error("Lark tools MCP requires an authenticated loopback runtime");
const headers = { authorization: `Bearer ${token}` };
const server = new Server({ name: "lark-tools", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const response = await fetch(new URL("/v1/internal/mcp/tools", runtime), { headers, signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) { await response.body?.cancel(); throw new Error("Lark tool catalog unavailable"); }
  return { tools: (await response.json() as { tools: Tool[] }).tools };
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
  const args = params.arguments ?? {};
  if (typeof args.context_token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(args.context_token) || !("input" in args)
    || Object.keys(args).some(key => key !== "context_token" && key !== "input")) return fail("请使用当前回合的 context_token 和工具定义中的 input 参数。");
  try {
    const result = await postHostJson(new URL("/v1/internal/mcp/tools/call", runtime).href,
      { tool: params.name, contextToken: args.context_token, input: args.input }, headers,
      AbortSignal.any([signal, AbortSignal.timeout(1_200_000)]));
    const body = JSON.parse(result.body) as { success?: boolean; text?: string; error?: string };
    return result.ok && body.success && typeof body.text === "string"
      ? { content: [{ type: "text" as const, text: body.text }] } : fail(body.error ?? "Lark tool did not complete");
  } catch {
    return fail("Lark tool connection ended before a result was confirmed; do not replay an external operation.");
  }
});

await server.connect(new StdioServerTransport());
