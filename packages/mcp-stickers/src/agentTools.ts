import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { postHostJson } from "../../conversation-runtime/src/hostHttp.js";

const runtime = new URL(process.env.LARK_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4780");
const token = process.env.LARK_AGENT_MCP_TOKEN?.trim();
if (runtime.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(runtime.hostname)
  || runtime.username || runtime.password || !token) throw new Error("Lark tools MCP requires an authenticated loopback runtime");
const headers = { authorization: `Bearer ${token}` };
const server = new Server({ name: "lark-tools", version: "0.1.0" }, { capabilities: { tools: {} } });

async function recoverForgeReceipt(call: { tool: string; contextToken: string; input: unknown }, signal: AbortSignal) {
  if (!call.tool.startsWith("forge__")) return;
  const until = Date.now() + 45_000;
  let observed = false;
  while (!signal.aborted && (observed || Date.now() < until)) {
    try {
      const result = await postHostJson(new URL("/v1/internal/mcp/tools/receipt", runtime).href, call, headers,
        AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
      if (result.status === 404 || result.status === 403 || result.status === 400) return;
      if (result.ok) {
        const item = JSON.parse(result.body) as { status: string; text?: string; error?: string };
        if (item.status === "completed" && typeof item.text === "string") return { isError: false, text: item.text };
        if (item.status === "failed") return { isError: true, text: item.error ?? "无法确认原宿主操作的回执。" };
        if (item.status === "running") observed = true;
      }
    } catch { /* Read again after the local runtime reconnects. Never retry the tool call. */ }
    try { await delay(1_000, undefined, { signal }); } catch { return; }
  }
}

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
  const call = { tool: params.name, contextToken: args.context_token, input: args.input };
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(1_200_000)]);
  let failure = "Lark tool connection ended before a result was confirmed; do not replay an external operation.";
  try {
    const result = await postHostJson(new URL("/v1/internal/mcp/tools/call", runtime).href,
      call, headers, lifetime);
    const body = JSON.parse(result.body) as { success?: boolean; text?: string; error?: string };
    if (result.ok && body.success && typeof body.text === "string") return { content: [{ type: "text" as const, text: body.text }] };
    failure = body.error ?? "Lark tool did not complete";
  } catch { /* The original call may have been admitted. */ }
  const receipt = await recoverForgeReceipt(call, lifetime);
  return receipt && !receipt.isError ? { content: [{ type: "text" as const, text: receipt.text }] } : fail(receipt?.text ?? failure);
});

await server.connect(new StdioServerTransport());
