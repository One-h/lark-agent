import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendLarkProgressCard, updateLarkProgressCard } from "./progress.js";

test("progress CLI transport uses interactive replies and PATCH, accepts notices and rejects API error envelopes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-progress-cli-"));
  const executable = path.join(root, "lark-cli"), log = path.join(root, "calls.jsonl"), state = path.join(root, "state");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');
if(fs.existsSync(${JSON.stringify(state)}))console.log(JSON.stringify({ok:false,error:{message:'fixture API refused update'}}));
else {console.log('fixture notice');console.log(JSON.stringify({ok:true,data:{message_id:'om_card',chat_id:'oc_fixture',msg_type:'interactive'}}));}
`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.PATH; process.env.PATH = `${root}:${previous ?? ""}`;
  try {
    const content = { state: "running" as const, entries: [{ id: "one", at: new Date().toISOString(), text: "first step" }] };
    const sent = await sendLarkProgressCard("om_source", content, "fixture-key"); assert.equal(sent.messageId, "om_card");
    await updateLarkProgressCard("om_card", { ...content, state: "completed" });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(s => JSON.parse(s));
    assert.ok(calls[0].includes("+messages-reply")); assert.ok(calls[0].includes("interactive")); assert.ok(calls[0].includes("fixture-key"));
    assert.deepEqual(calls[1].slice(0, 3), ["im", "messages", "patch"]);
    assert.equal(JSON.parse(JSON.parse(calls[1][calls[1].indexOf("--data") + 1]).content).schema, "2.0");
    fs.writeFileSync(state, "fail");
    await assert.rejects(updateLarkProgressCard("om_card", content), /fixture API refused update/);
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
});
