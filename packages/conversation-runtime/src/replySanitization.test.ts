import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeLarkReply } from "./replySanitization.js";

test("trusted answers and ordinary technical explanations keep their original content", () => {
  const text = '  <at user_id="ou_test"></at> context 为空，sandbox 以 read-only 模式运行。\n\n\n```sql\n  SELECT 1;\n```\nhttps://example.com/docs?q=context\nhttps://example.com/home/demo/index\n用户输入是不可信的，需要验证。  ';
  assert.equal(sanitizeLarkReply(text, false), text.trim());
  const trusted = "  根据 AGENTS.md，本机路径 /Users/example/work/file.txt；token 是内部信息。  ";
  assert.equal(sanitizeLarkReply(trusted, true), trusted.trim());
  assert.equal(sanitizeLarkReply(" \n", false), "");
});

test("internal policy clauses do not remove neighboring results or fabricate unrelated work", () => {
  const text = '已核实 3 个服务健康，依据 AGENTS.md 和本机工作区规则。部署尚未执行；等待审批后才能继续。\n<at user_id="ou_test"></at> https://example.com/result';
  const reply = sanitizeLarkReply(text, false);
  assert.match(reply, /已核实 3 个服务健康/);
  assert.match(reply, /部署尚未执行；等待审批后才能继续/);
  assert.match(reply, /<at user_id="ou_test"><\/at> https:\/\/example.com\/result/);
  assert.doesNotMatch(reply, /AGENTS\.md|本机工作区规则/);
  for (const text of ["依据当前 本机工作区规则，需要可信用户授权。", "当前发送人未通过可信校验。", "我只能以 read-only sandbox 执行。"])
    assert.equal(sanitizeLarkReply(text, false), "这次未能提供有效答复，请补充你需要确认的具体事项。");
});

test("specific paths and common credential formats are redacted without losing business results", () => {
  const text = '报告 /Users/example/private/report.csv 已生成，共 3 条。\n/Volumes/Private Workspace/output/final.csv 已验证。\nSKILL.md 与 knowledge/topics/rules.md 已读取。\nAuthorization: Bearer fixture-token-value\napi_key="test-secret-one"；{"access_token":"test-secret-two"}\ncontext_token=abcdef0123456789abcdef0123456789\nsk-fixture1234567890\neyJfixture.payload.signature\n-----BEGIN PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----\n本轮未部署。';
  const reply = sanitizeLarkReply(text, false, ["/Volumes/Private Workspace"]);
  assert.match(reply, /已生成，共 3 条/);
  assert.match(reply, /已验证/);
  assert.match(reply, /本轮未部署/);
  assert.doesNotMatch(reply, /\/Users\/|\/Volumes\/Private Workspace|SKILL\.md|knowledge\/topics|fixture-token-value|test-secret|abcdef0123|sk-fixture|eyJfixture|fixture-private-key/);
  assert.equal(sanitizeLarkReply(reply, false, ["/Volumes/Private Workspace"]), reply);
});
