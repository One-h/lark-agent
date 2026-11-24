import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteAgentStore } from "@lark-agent/adapter-sqlite";
import Fastify from "fastify";
import { managedChatCapabilities, managedChats } from "../managedChats.js";
import { disableManagedChatsPlugin, mountManagedChatsPlugin } from "./managedChatsPlugin.js";

const url = "/v1/managed-chats";
const headers = { authorization: "Bearer fixture-token" };

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lark-managed-chats-plugin-"));
  const store = new SqliteAgentStore(path.join(root, "fixture.sqlite"));
  const app = Fastify();
  t.after(async () => {
    try { await app.close(); }
    finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { app, store };
}

test("managed chats mounts the existing HTTP contract and returns the same service for capability calls", async t => {
  const { app, store } = fixture(t);
  let createCalls = 0;
  const service = mountManagedChatsPlugin({ app, store,
    options: {
      owner: () => "ou_owner",
      create: async () => { createCalls++; return { chatId: "oc_fixture", ownerConfirmed: true }; }
    },
    authorized: request => request.ip === "127.0.0.1" && request.headers.authorization === headers.authorization
  });
  assert.deepEqual(store.db.prepare("SELECT id, risk FROM capabilities ORDER BY id").all(), [
    { id: "lark.chat.create", risk: "external-write" },
    { id: "lark.chat.list_managed", risk: "read" }
  ]);

  const payload = { requestId: randomUUID(), name: "Fixture group" };
  for (const method of ["GET", "POST"] as const) {
    const denied = await app.inject({ method, url, ...(method === "POST" ? { payload } : {}) });
    assert.equal(denied.statusCode, 401);
    assert.deepEqual(denied.json(), { error: "local runtime token required" });
  }
  assert.equal((await app.inject({ url, headers, remoteAddress: "192.0.2.1" })).statusCode, 401);
  const invalid = await app.inject({ method: "POST", url, headers, payload: { ...payload, requestId: "invalid" } });
  assert.equal(invalid.statusCode, 400);
  const { message } = invalid.json();
  assert.ok(message);
  assert.deepEqual(invalid.json(), { code: "LARK_MANAGED_CHAT_INVALID", message, error: message });
  assert.equal(createCalls, 0);

  const created = await app.inject({ method: "POST", url, headers, payload });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().item.chatId, "oc_fixture");
  assert.deepEqual(await service.create(payload), created.json());
  assert.equal(createCalls, 1);
  const listed = await app.inject({ url, headers });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), await service.list());
  assert.deepEqual(listed.json().items, [created.json().item]);
});

test("disabled managed chats removes only its registrations and mounts no HTTP routes", async t => {
  const { app, store } = fixture(t);
  const unrelated = { id: "lark.chat.create.other", title: "Other", description: "Fixture", inputSchema: {}, risk: "read" };
  store.registerCapabilities([...managedChatCapabilities, unrelated]);
  const service = managedChats(store.db, {
    owner: () => "ou_owner",
    create: async () => ({ chatId: "oc_history", ownerConfirmed: true })
  });
  const payload = { requestId: randomUUID(), name: "Historical group" };
  await service.create(payload);
  const history = store.db.prepare("SELECT * FROM lark_managed_chats");
  const before = history.all();

  disableManagedChatsPlugin(store);
  disableManagedChatsPlugin(store);

  assert.deepEqual(store.db.prepare("SELECT id FROM capabilities").pluck().all(), [unrelated.id]);
  assert.deepEqual(history.all(), before);
  assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 404);
});
