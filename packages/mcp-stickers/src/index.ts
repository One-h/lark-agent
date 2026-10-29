import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type RuntimeContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };

const runtimeUrl = new URL(process.env.LARK_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4780");
if (!["127.0.0.1", "localhost", "::1"].includes(runtimeUrl.hostname) || runtimeUrl.protocol !== "http:") {
  throw new Error("Lark sticker MCP requires a loopback HTTP runtime URL");
}
const runtimeToken = process.env.LARK_AGENT_RUNTIME_TOKEN?.trim() ?? "";

function mcpContent(items: RuntimeContentItem[]): CallToolResult["content"] {
  const content: CallToolResult["content"] = [];
  for (const item of items) {
    if (item.type === "inputText") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    const match = item.imageUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
    if (match) content.push({ type: "image", mimeType: match[1], data: match[2] });
  }
  return content;
}

async function callRuntime(route: string, contextToken: string, input: Record<string, unknown>, timeoutMs = 12_000): Promise<CallToolResult> {
  try {
    const response = await fetch(new URL(route, runtimeUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...(runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : {}) },
      body: JSON.stringify({ contextToken, input }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json() as { success?: unknown; contentItems?: unknown };
    const items = Array.isArray(body.contentItems) ? body.contentItems.filter((item): item is RuntimeContentItem => Boolean(item && typeof item === "object" && (item as RuntimeContentItem).type)) : [];
    return { content: mcpContent(items), isError: !response.ok || body.success !== true };
  } catch (error) {
    return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

const server = new McpServer({ name: "lark-stickers", version: "0.1.0" });
server.registerTool("owner_assist_decision", {
  title: "判断群内协同回复及核对本人新增发言",
  description: "仅用于真正 @ 指定对象的当前群消息。先提交 handle/owner_required/ignore；最终草稿准备好后再次提交 handle 和 reply。若返回 owner_context_updated，保留草稿并结合本人发言重新判断，不能直接取消。ready 才能公开；owner_required 仅私下草稿，不批准执行。",
  inputSchema: z.object({ context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    action: z.enum(["handle", "owner_required", "ignore"]), reason: z.string().trim().min(1).max(500),
    reply: z.string().max(6000).optional(), question: z.string().max(500).optional(), owner_context_cursor: z.number().int().positive().optional() }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, async ({ context_token, ...input }) => callRuntime("/v1/internal/owner-assist/decision", context_token, input, 40_000));
server.registerTool("attach_files", {
  title: "为本轮回复添加图片或文件",
  description: "登记当前消息 output 目录中已生成的图片和文档，不立即发送。追加最多八个附件；重复路径更新登记，files=[] 清空。正常结束本轮后由队列投递，最终文字无需媒体标签。",
  inputSchema: z.object({
    context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    files: z.array(z.object({ path: z.string().trim().min(1).max(1024), name: z.string().trim().min(1).max(160).optional() }).strict()).max(8)
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ context_token, files }) => callRuntime("/v1/internal/attachments/register", context_token, { files }, 25_000));
server.registerTool("search", {
  title: "搜索飞书表情包",
  description: "为当前飞书消息搜索最多三张本地表情候选并查看预览，不会发送消息。context_token 必须使用当前提示词提供的值。",
  inputSchema: {
    context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    query: z.string().trim().min(2).max(120)
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ context_token, query }) => callRuntime("/v1/internal/stickers/search", context_token, { query }));

server.registerTool("select", {
  title: "选择飞书表情包",
  description: "暂存当前飞书消息的一张表情选择。只能选择本轮最近一次 search 返回的 ID；传 null 取消。最终文字送达后才发送。",
  inputSchema: {
    context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    sticker_id: z.string().regex(/^stk_[A-Za-z0-9_-]+$/).nullable()
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ context_token, sticker_id }) => callRuntime("/v1/internal/stickers/select", context_token, { sticker_id }));

server.registerTool("history_images_search", {
  title: "查找历史聊天图片",
  description: "列出当前私聊/群聊或原生话题此前的图片元数据，不读取像素。找最近图片时省略 query；关键词只匹配消息文字，不搜索图中文字。可用 before_local_id 翻页；先搜索再打开。context_token 必须来自当前提示词。",
  inputSchema: {
    context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    query: z.string().trim().max(80).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    before_local_id: z.number().int().positive().optional()
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ context_token, query, limit, before_local_id }) => callRuntime("/v1/internal/history-images/search", context_token,
  { query, limit, before_local_id }));

server.registerTool("history_images_open", {
  title: "查看一张历史聊天图片",
  description: "读取当前会话最近一次 history_images_search 返回的指定图片。local_id 和 image_index 必须来自搜索结果；每轮最多查看四张。",
  inputSchema: {
    context_token: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    local_id: z.number().int().positive(),
    image_index: z.number().int().positive()
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}, async ({ context_token, local_id, image_index }) => callRuntime("/v1/internal/history-images/open", context_token,
  { local_id, image_index }, 25_000));

await server.connect(new StdioServerTransport());
