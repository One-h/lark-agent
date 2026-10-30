import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderLarkReply, parseLarkReplyPresentation } from "./richReply.js";
import { sendLarkTextReply } from "./reply.js";

const elements = (reply: ReturnType<typeof renderLarkReply>) => (reply.content.body as { elements: Array<Record<string, any>> }).elements;

test("Markdown explanations, links, code and ordinary lists use post/md without modifying their content", () => {
  const source = "## Result\n\n**Ready** [details](https://example.com)\n\n- First explanation\n- Second explanation\n\n```sql\nSELECT id FROM demo LIMIT 2;\n```";
  const reply = renderLarkReply(source);
  assert.equal(reply.msgType, "post");
  assert.deepEqual(reply.content, { zh_cn: { content: [[{ tag: "md", text: source }]] } });
  assert.equal(reply.overflowMarkdown, undefined);
});

test("GFM tables become Card 2 native tables with literal values, empty cells and inline links", () => {
  const source = "## Summary\n\n| Name | Count | Share |\n| --- | ---: | ---: |\n| [Demo](https://example.com) | 0012 | 50% |\n| Unknown | | 0% |\n\nMissing categories are retained.";
  const reply = renderLarkReply(source);
  assert.equal(reply.msgType, "interactive");
  assert.equal(reply.content.schema, "2.0");
  const table = elements(reply).find(item => item.tag === "table")!;
  assert.equal(table.columns[1].display_name, "Count");
  assert.deepEqual(table.rows[0], { c0: "[Demo](https://example.com)", c1: "0012", c2: "50%" });
  assert.equal(table.rows[1].c1, "");
  assert.equal(table.page_size, 5); assert.equal(table.freeze_first_column, true);
  assert.match(JSON.stringify(reply.content), /Missing categories are retained/);
  assert.equal(reply.overflowMarkdown, undefined);
});

test("record lists use grouped read-only components while code examples never become tables", () => {
  const records = renderLarkReply("- **Example A**：count: 2\n- **Example B**：count: 3");
  assert.equal(records.msgType, "interactive");
  const group = elements(records).find(item => item.tag === "column_set")!;
  assert.equal(group.columns[0].elements.length, 2);
  assert.match(JSON.stringify(group), /Example B/);
  assert.doesNotMatch(JSON.stringify(records), /callback|behaviors/);
  const code = "```md\n| Name | Value |\n| --- | --- |\n| Demo | 1 |\n```";
  assert.equal(renderLarkReply(code).msgType, "post");
});

test("leading sender mentions preserve first-block Markdown and card at syntax never rewrites code", () => {
  const header = renderLarkReply('<at user_id="ou_sender"></at> ## Heading');
  assert.match(JSON.stringify(header.content), /\\n\\n## Heading/);
  const source = '<at user_id="ou_sender"></at> | Person | Example |\n| --- | --- |\n| <at user_id="ou_other"></at> | `<at user_id="ou_code"></at>` |';
  const card = renderLarkReply(source);
  assert.equal(card.msgType, "interactive");
  assert.match(JSON.stringify(card.content), /<at id=ou_sender>/);
  assert.equal(elements(card).find(item => item.tag === "table")!.rows[0].c0, "<at id=ou_other></at>");
  assert.equal(elements(card).find(item => item.tag === "table")!.rows[0].c1, '`<at user_id="ou_code"></at>`');
});

test("large data previews declare their bounds and retain complete Markdown for attachment delivery", () => {
  const source = "| Name | Count |\n| --- | --- |\n" + Array.from({ length: 30 }, (_, i) => `| item ${i} | ${i} |`).join("\n");
  const reply = renderLarkReply(source);
  assert.equal(reply.msgType, "interactive");
  assert.equal(elements(reply).find(item => item.tag === "table")!.rows.length, 20);
  assert.match(JSON.stringify(reply.content), /共 30 行/);
  assert.equal(reply.overflowMarkdown, source);
  const long = renderLarkReply("结果\n\n" + "x".repeat(40_000));
  assert.equal(long.msgType, "post");
  assert.match(JSON.stringify(long.content), /完整结果见附件/);
  assert.equal(long.overflowMarkdown?.length, 40_004);
});

test("presentation snapshots round-trip and invalid versions or types fail closed", () => {
  const reply = renderLarkReply("**Ready**");
  assert.deepEqual(parseLarkReplyPresentation(JSON.stringify(reply)), reply);
  for (const value of [{ ...reply, version: 2 }, { ...reply, msgType: "text" }, { ...reply, content: {} }, { ...reply, content: { zh_cn: "x".repeat(30_000) } }]) {
    assert.throws(() => parseLarkReplyPresentation(JSON.stringify(value)));
  }
});

test("wide and multibyte data preserve the full result when platform preview limits are exceeded", () => {
  const headers = Array.from({ length: 10 }, (_, i) => `C${i}`);
  const source = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n| ${headers.map(() => "示例").join(" | ")} |`;
  const result = renderLarkReply(source);
  assert.equal(elements(result).find(item => item.tag === "table")!.columns.length, 8);
  assert.match(JSON.stringify(result.content), /共 1 行、10 列/);
  assert.equal(result.overflowMarkdown, source);
  const large = renderLarkReply("| 内容 |\n| --- |\n| " + "内容".repeat(20_000) + " |");
  assert.ok(Buffer.byteLength(JSON.stringify(large.content)) <= 24_000);
  assert.ok(large.overflowMarkdown?.includes("内容".repeat(20_000)));
});

test("CLI sender uses exact persisted post/card JSON and legacy calls keep the text transport", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-rich-cli-"));
  const log = path.join(root, "args.json"), previous = process.env.PATH;
  fs.writeFileSync(path.join(root, "lark-cli"), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({ok:true,data:{message_id:'om_sent',msg_type:process.argv[process.argv.indexOf('--msg-type')+1]}}));\n`, { mode: 0o755 });
  process.env.PATH = `${root}:${previous ?? ""}`;
  try {
    for (const source of ["**Ready**", "| A | B |\n| --- | --- |\n| 1 | 2 |"] ) {
      const presentation = renderLarkReply(source);
      assert.equal(sendLarkTextReply("om_source", source, "fixed-key", presentation).ok, true);
      const args = JSON.parse(fs.readFileSync(log, "utf8")) as string[];
      assert.equal(args[args.indexOf("--msg-type") + 1], presentation.msgType);
      assert.deepEqual(JSON.parse(args[args.indexOf("--content") + 1]), presentation.content);
      assert.equal(args.includes("--text"), false);
      assert.equal(args[args.indexOf("--idempotency-key") + 1], "fixed-key");
    }
    assert.equal(sendLarkTextReply("om_source", "literal **text**", "legacy-key").ok, true);
    assert.ok(JSON.parse(fs.readFileSync(log, "utf8")).includes("--text"));
  } finally { process.env.PATH = previous; fs.rmSync(root, { recursive: true, force: true }); }
});
