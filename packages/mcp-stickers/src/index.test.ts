import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio sticker MCP exposes bounded search/select tools and authenticates to loopback runtime", async () => {
  const requests: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
  const runtime = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
      response.setHeader("content-type", "application/json");
      const contentItems = request.url?.endsWith("/history-images/search")
        ? [{ type: "inputText", text: JSON.stringify({ images: [{ localId: 12, imageCount: 1 }] }) }]
        : request.url?.endsWith("/history-images/open")
          ? [{ type: "inputText", text: "Historical image" }, { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }]
          : request.url?.endsWith("/search") ? [
        { type: "inputText", text: JSON.stringify({ candidates: [{ id: "stk_one", name: "得意" }], sent: false }) },
        { type: "inputImage", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }
      ] : [{ type: "inputText", text: JSON.stringify({ status: "selected_pending_final_text", sent: false }) }];
      response.end(JSON.stringify({ success: true, contentItems }));
    });
  });
  await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  const address = runtime.address();
  assert(address && typeof address !== "string");
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(sourceRoot, "packages", "mcp-stickers", "src", "index.ts")],
    cwd: sourceRoot,
    env: { ...process.env, LARK_AGENT_RUNTIME_URL: `http://127.0.0.1:${address.port}`, LARK_AGENT_RUNTIME_TOKEN: "secret" } as Record<string, string>
  });
  const client = new Client({ name: "sticker-mcp-test", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["attach_files", "history_images_open", "history_images_search", "owner_assist_decision", "search", "select"]);
    assert.equal(tools.tools.find((tool) => tool.name === "search")?.annotations?.readOnlyHint, true);
    assert.equal(tools.tools.find((tool) => tool.name === "select")?.annotations?.openWorldHint, false);
    const token = "a".repeat(32);
    const search = await client.callTool({ name: "search", arguments: { context_token: token, query: "得意" } });
    assert.equal(search.isError, false);
    assert((search.content as Array<{ type: string }>).some((item) => item.type === "image"));
    const select = await client.callTool({ name: "select", arguments: { context_token: token, sticker_id: "stk_one" } });
    assert.equal(select.isError, false);
    const historySearch = await client.callTool({ name: "history_images_search", arguments: { context_token: token, limit: 5 } });
    assert.equal(historySearch.isError, false);
    assert.equal((historySearch.content as Array<{ type: string }>).some((item) => item.type === "image"), false);
    const historyOpen = await client.callTool({ name: "history_images_open", arguments: { context_token: token, local_id: 12, image_index: 1 } });
    assert.equal(historyOpen.isError, false);
    assert((historyOpen.content as Array<{ type: string }>).some((item) => item.type === "image"));
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((request) => request.url), ["/v1/internal/stickers/search", "/v1/internal/stickers/select", "/v1/internal/history-images/search", "/v1/internal/history-images/open"]);
    assert(requests.every((request) => request.authorization === "Bearer secret"));
    assert.deepEqual(requests[0]?.body, { contextToken: token, input: { query: "得意" } });
    assert.deepEqual(requests[1]?.body, { contextToken: token, input: { sticker_id: "stk_one" } });
    assert.deepEqual(requests[3]?.body, { contextToken: token, input: { local_id: 12, image_index: 1 } });
    const files = [{ path: "report.csv", name: "视频链接.csv" }, { path: "chart.png" }];
    assert.equal((await client.callTool({ name: "attach_files", arguments: { context_token: token, files } })).isError, false);
    assert.deepEqual(requests[4], { url: "/v1/internal/attachments/register", authorization: "Bearer secret", body: { contextToken: token, input: { files } } });
    assert.equal((await client.callTool({ name: "attach_files", arguments: { context_token: token, files: Array.from({ length: 9 }, () => ({ path: "report.csv" })) } })).isError, true);
    assert.equal((await client.callTool({ name: "attach_files", arguments: { context_token: token, files: [{ path: "report.csv", recipient: "ou_other" }] } })).isError, true);
    assert.equal((await client.callTool({ name: "attach_files", arguments: { context_token: token, files, chat_id: "oc_other" } })).isError, true);
    const invalid = await client.callTool({ name: "search", arguments: { context_token: "bad", query: "得意" } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 5);
    const assist = await client.callTool({name:"owner_assist_decision",arguments:{context_token:token,action:"handle",reason:"核对补充",reply:"准备发送的草稿",owner_context_cursor:12}});
    assert.equal(assist.isError,false);
    assert.deepEqual(requests[5],{url:"/v1/internal/owner-assist/decision",authorization:"Bearer secret",body:{contextToken:token,input:{action:"handle",reason:"核对补充",reply:"准备发送的草稿",owner_context_cursor:12}}});
    assert.equal((await client.callTool({name:"owner_assist_decision",arguments:{context_token:token,action:"handle",reason:"bad",owner_id:"ou_other"}})).isError,true);
    assert.equal(requests.length,6);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => runtime.close((error) => error ? reject(error) : resolve()));
  }
});

test("sticker MCP refuses non-loopback runtime URLs", () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const result = spawnSync(process.execPath, [path.join(sourceRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(sourceRoot, "packages", "mcp-stickers", "src", "index.ts")], {
    cwd: sourceRoot,
    env: { ...process.env, LARK_AGENT_RUNTIME_URL: "https://example.com", LARK_AGENT_RUNTIME_TOKEN: "secret" },
    encoding: "utf8",
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a loopback HTTP runtime URL/);
});
