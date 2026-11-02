import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./client.js";
import { serializeCodexAppServerMessage, unicodeSafePrefix } from "./unicode.js";

test("Unicode prefixes retain UTF-16 budgets and never split valid surrogate pairs", () => {
  const samples = ["plain ASCII", "中文文字", "A\u{1f4dd}B\u{1f600}C", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", "e\u0301\u{1f1e8}\u{1f1f3}"];
  for (const text of samples) for (let budget = 0; budget <= text.length + 1; budget++) {
    const prefix = unicodeSafePrefix(text, budget);
    assert(prefix.length <= budget); assert(text.startsWith(prefix));
    assert.doesNotMatch(prefix, /[\uD800-\uDFFF]/u);
    assert.doesNotThrow(() => serializeCodexAppServerMessage({ prefix }));
  }
  assert.equal(unicodeSafePrefix("abcdef", 3), "abc");
  assert.equal(unicodeSafePrefix("A\u{1f4dd}B", 2), "A");
  assert.equal(unicodeSafePrefix("A\u{1f4dd}B", 3), "A\u{1f4dd}");
  assert.equal(unicodeSafePrefix("abc", -1), "");
});

test("JSON-RPC serialization preserves valid payloads exactly and rejects malformed keys and nested text", () => {
  const payload = { id: 1, method: "turn/start", params: { text: "中文\u{1f4dd}", path: "fixture/文本.png", literal: "\\ud83d", ["\u{1f4dd}"]: "valid key", optional: undefined } };
  assert.equal(serializeCodexAppServerMessage(payload), JSON.stringify(payload));
  for (const bad of [{ params: { text: "private-value\ud83d" } }, { params: ["\udcdd"] }, { ["private-key\ud83d"]: "x" }]) {
    assert.throws(() => serializeCodexAppServerMessage(bad), error => {
      assert(error instanceof Error); assert.match(error.message, /invalid Unicode/);
      assert.doesNotMatch(error.message, /private-|timed out/); return true;
    });
  }
});

test("stdio rejects malformed Unicode before writing and a later valid request still succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-unicode-rpc-"));
  const executable = path.join(root, "codex.mjs"), log = path.join(root, "requests.jsonl");
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 try{
  const m=JSON.parse(line,(key,value)=>{if(/[\\uD800-\\uDFFF]/u.test(key)||typeof value==='string'&&/[\\uD800-\\uDFFF]/u.test(value))throw Error('invalid Unicode');return value;});
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
  if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='turn/start'?{turn:{id:'fixture-turn'},input:m.params.input}:{}})+'\\n');
 }catch{process.stderr.write('fixture parser rejected malformed request\\n');}
});`);
  fs.chmodSync(executable, 0o755);
  const previous = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = executable;
  const client = new CodexAppServerClient(() => root);
  try {
    await client.start();
    for (const params of [{ input: [{ type: "text", text: "invalid\ud83d" }] }, { ["field\udcdd"]: "value" }]) {
      await assert.rejects(client.request("turn/start", params, 500), /invalid Unicode/);
      assert.match(client.status().lastError ?? "", /invalid Unicode/);
    }
    assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(m => m.method === "turn/start").length, 0);
    const input = [{ type: "text", text: "中文\u{1f4dd}" }];
    const result = await client.request<{ input: unknown }>("turn/start", { input }, 2000);
    assert.deepEqual(result.input, input);
  } finally {
    client.stop();
    if (previous === undefined) delete process.env.CODEX_EXECUTABLE; else process.env.CODEX_EXECUTABLE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
