import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createRuntime } from "./index.js";
import { retryPendingAutoApprovalNotifications } from "@lark-agent/conversation-runtime";

test("deployment host capability can use automatic turn approval while unrelated external writes stay manual",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"lark-auto-deployment-"));
  const host=Fastify();let deployments=0;let reviews=0;const notifications:string[]=[];const cards:number[]=[];
  host.post("/api/lark-agent/capabilities/forge.deploy.production",async()=>({deployments:++deployments}));
  await host.listen({host:"127.0.0.1",port:0});const address=host.server.address();assert(address&&typeof address!=="string");
  const runtime=createRuntime({databasePath:path.join(root,"test.sqlite"),mode:"shadow",trustedSenderIds:[],approverId:"ou_owner",runtimeToken:"secret",hostBaseUrl:`http://127.0.0.1:${address.port}`,
    turnApprovalReviewer:async()=>{reviews++;return {decision:"approve_turn",reason:"范围明确的部署"};},
    autoApprovalNotificationSender:async recipient=>{notifications.push(recipient);return {ok:true,messageId:"om_notice",chatId:null,messageAt:null,messageType:"interactive"};},
    approvalCardSender:(_recipient,card)=>{cards.push(card.approvalId);return {ok:true,messageId:"om_card"};}});
  try {
    const now=new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages(id,chat_id,sender_id,content,codex_turn_id,raw_json,received_at,created_at) VALUES (1,'oc_test','ou_sender','部署生产 demo-api','deployment-turn','{}',?,?)").run(now,now);
    await runtime.app.inject({ headers: { authorization: "Bearer secret" },method:"POST",url:"/v1/capabilities/register",payload:{capabilities:[{id:"forge.deploy.production",title:"部署",description:"部署指定服务",inputSchema:{},risk:"external-write"},{id:"external.send",title:"外发",description:"外发信息",inputSchema:{},risk:"external-write"}]}});
    await runtime.app.inject({method:"PATCH",url:"/v1/settings",payload:{turnAutoApprovalEnabled:true}});
    const invoke=(id:string,input:unknown)=>runtime.app.inject({method:"POST",url:`/v1/internal/capabilities/${id}/execute`,headers:{authorization:"Bearer secret"},payload:{input,context:{larkMessageId:1,chatId:"oc_test",trustScope:"untrusted",turnId:"deployment-turn"}}});
    assert.equal((await invoke("forge.deploy.production",{repo:"demo-api",apps:["demo-api"],expectedRevision:"aaaaaaa"})).statusCode,200);
    assert.equal((await invoke("forge.deploy.production",{repo:"demo-api",apps:["demo-api"],expectedRevision:"bbbbbbb"})).statusCode,200);
    assert.equal(reviews,1);assert.equal(deployments,2);assert.equal(cards.length,0);
    await retryPendingAutoApprovalNotifications();assert.deepEqual(notifications,["ou_owner"]);
    const wrongTarget=invoke("forge.deploy.production",{repo:"demo-worker",apps:["demo-worker"],expectedRevision:"aaaaaaa"});
    for(let i=0;!cards.length&&i<30;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(cards.length,1);await runtime.app.inject({method:"POST",url:`/v1/approvals/${cards[0]}/reject`});
    assert.equal((await wrongTarget).statusCode,409);assert.equal(deployments,2);cards.length=0;
    const pending=invoke("external.send",{});
    for(let i=0;!cards.length&&i<30;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(cards.length,1);await runtime.app.inject({method:"POST",url:`/v1/approvals/${cards[0]}/reject`});
    assert.equal((await pending).statusCode,409);
  } finally {await runtime.app.close();runtime.stop();await host.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("turn approval switch defaults off, validates input and survives reopening", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-auto-setting-"));
  const options = { databasePath: path.join(root, "test.sqlite"), mode: "shadow" as const, trustedSenderIds: [] };
  let runtime = createRuntime(options);
  try {
    const defaults = (await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json();
    assert.equal(defaults.turnAutoApprovalEnabled, false); assert.equal(defaults.turnAutoApprovalModel, "gpt-6.1-sol");
    assert.equal(defaults.turnAutoApprovalModelConfigurable, true);
    for (const invalid of ["", "bad model", "x".repeat(121), 1, null]) {
      assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalModel: invalid, turnAutoApprovalEnabled: true } })).statusCode, 400);
    }
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().turnAutoApprovalEnabled, false);
    const selected = await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalModel: " gpt-5.6-terra " } });
    assert.equal(selected.json().turnAutoApprovalModel, "gpt-5.6-terra");
    assert.equal(selected.json().turnAutoApprovalEnabled, false);
    for (const invalid of ["true", 1, null]) assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: invalid } })).statusCode, 400);
    assert.equal((await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true } })).json().turnAutoApprovalEnabled, true);
    await runtime.app.close(); runtime.stop(); runtime = createRuntime(options);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().turnAutoApprovalEnabled, true);
    assert.equal((await runtime.app.inject({ method: "GET", url: "/v1/settings" })).json().turnAutoApprovalModel, "gpt-5.6-terra");
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("host review tools reuse one model decision per sender and turn, and external writes still ask", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-auto-host-"));
  const host = Fastify(); let calls = 0; let reviews = 0; const cards: number[] = [];
  host.post("/api/lark-agent/capabilities/forge.review", async () => ({ call: ++calls }));
  host.post("/api/lark-agent/capabilities/forge.deploy", async () => ({ call: ++calls }));
  await host.listen({ host: "127.0.0.1", port: 0 });
  const address = host.server.address(); assert(address && typeof address !== "string");
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "shadow", workspaceRoot: root,
    trustedSenderIds: [], approverId: "ou_owner", runtimeToken: "secret", hostBaseUrl: `http://127.0.0.1:${address.port}`,
    turnApprovalReviewer: async () => { reviews++; return { decision: "approve_turn", reason: "PR review only" }; },
    approvalCardSender: (_recipient, card) => { cards.push(card.approvalId); return { ok: true, messageId: "om_card" }; }
  });
  const insertMessage = (id: number, sender: string, turn: string) => {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages (id,message_id,chat_id,sender_id,content,codex_turn_id,raw_json,received_at,created_at) VALUES (?,?,'oc_test',?,?,?,'{}',?,?)")
      .run(id, `om_${id}`, sender, "https://git.example.com/team/repo/pulls/23 please review", turn, now, now);
  };
  const invoke = (id: number, sender: string, turn: string, value: number, capability = "forge.review") => {
    insertMessage(id, sender, turn);
    return runtime.app.inject({ method: "POST", url: `/v1/internal/capabilities/${capability}/execute`, headers: { authorization: "Bearer secret" },
      payload: { input: { value }, context: { larkMessageId: id, chatId: "oc_test", trustScope: "untrusted", turnId: turn } } });
  };
  try {
    await runtime.app.inject({ headers: { authorization: "Bearer secret" }, method: "POST", url: "/v1/capabilities/register", payload: { capabilities: [
      { id: "forge.review", title: "Review", description: "Review", inputSchema: {}, risk: "local-write" },
      { id: "forge.deploy", title: "Deploy", description: "Deploy", inputSchema: {}, risk: "external-write" }
    ] } });
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true } });
    assert.equal((await invoke(1, "ou_sender", "turn-one", 1)).statusCode, 200);
    assert.equal((await invoke(2, "ou_sender", "turn-one", 2)).statusCode, 200);
    assert.equal(reviews, 1); assert.equal(cards.length, 0);
    assert.equal((await invoke(3, "ou_sender", "turn-two", 3)).statusCode, 200);
    assert.equal((await invoke(4, "ou_other", "turn-two", 4)).statusCode, 200); assert.equal(reviews, 3);
    const pending = invoke(5, "ou_sender", "turn-one", 5, "forge.deploy");
    for (let i = 0; !cards.length && i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cards.length, 1); assert.equal(calls, 4);
    await runtime.app.inject({ method: "POST", url: `/v1/approvals/${cards[0]}/reject` });
    assert.equal((await pending).statusCode, 409); assert.equal(calls, 4);
    const audit = (await runtime.app.inject({ method: "GET", url: "/v1/approvals" })).json().autoReviews;
    assert.equal(audit.length, 3); assert(audit.every((row: { applied_at: string }) => row.applied_at));
  } finally { await runtime.app.close(); runtime.stop(); await host.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed model review returns to the existing human card and cannot execute before approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-auto-fallback-"));
  const cards: number[] = [];
  const runtime = createRuntime({ databasePath: path.join(root, "test.sqlite"), mode: "shadow", trustedSenderIds: [], approverId: "ou_owner", runtimeToken: "secret",
    turnApprovalReviewer: async () => { throw new Error("reviewer timeout"); },
    approvalCardSender: (_recipient, card) => { cards.push(card.approvalId); return { ok: true, messageId: "om_card" }; }
  });
  try {
    const now = new Date().toISOString();
    runtime.store.db.prepare("INSERT INTO lark_messages (id,chat_id,sender_id,content,codex_turn_id,raw_json,received_at,created_at) VALUES (1,'oc_test','ou_sender','review PR','turn-test','{}',?,?)").run(now, now);
    await runtime.app.inject({ headers: { authorization: "Bearer secret" }, method: "POST", url: "/v1/capabilities/register", payload: { capabilities: [{ id: "forge.review", title: "Review", description: "Review", inputSchema: {}, risk: "local-write" }] } });
    await runtime.app.inject({ method: "PATCH", url: "/v1/settings", payload: { turnAutoApprovalEnabled: true } });
    const pending = runtime.app.inject({ method: "POST", url: "/v1/internal/capabilities/forge.review/execute", headers: { authorization: "Bearer secret" }, payload: { input: {}, context: { larkMessageId: 1, chatId: "oc_test", trustScope: "untrusted", turnId: "turn-test" } } });
    for (let i = 0; !cards.length && i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cards.length, 1);
    await runtime.app.inject({ method: "POST", url: `/v1/approvals/${cards[0]}/reject` });
    assert.equal((await pending).statusCode, 409);
    const audit = (await runtime.app.inject({ method: "GET", url: "/v1/approvals" })).json().autoReviews[0];
    assert.equal(audit.decision, "manual"); assert.equal(audit.applied_at, null); assert.match(audit.reason, /timeout/);
  } finally { await runtime.app.close(); runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
