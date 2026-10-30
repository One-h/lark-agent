import { Lexer, marked, type Token, type Tokens } from "marked";

export type LarkReplyPresentation = {
  version: 1;
  msgType: "post" | "interactive";
  content: Record<string, unknown>;
  overflowMarkdown?: string;
};
const maxBodyBytes = 24_000;
const tableRows = 20, tableColumns = 8, recordRows = 12;
const bytes = (content: unknown) => Buffer.byteLength(JSON.stringify(content), "utf8");
const post = (text: string): LarkReplyPresentation => ({ version: 1, msgType: "post", content: { zh_cn: { content: [[{ tag: "md", text }]] } } });

function plain(text: string): string {
  const visit = (tokens: Token[]): string => tokens.map(token => {
    if (token.type === "image") return (token as Tokens.Image).text;
    if ("tokens" in token && Array.isArray(token.tokens)) return visit(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : token.raw;
  }).join("");
  return visit(Lexer.lexInline(text)).replace(/<[^>]*>/g, "").trim();
}

function cardMarkdown(source: string): string {
  let prefix = "\uE000reply-code-";
  while (source.includes(prefix)) prefix += "x";
  const codes: string[] = [];
  marked.walkTokens(Lexer.lex(source, { gfm: true }), token => {
    if (token.type === "code" || token.type === "codespan") codes.push(token.raw);
  });
  let text = source;
  const protectedCode: string[] = [];
  for (const raw of [...new Set(codes)].sort((a, b) => b.length - a.length)) {
    if (!text.includes(raw)) continue;
    const marker = `${prefix}${protectedCode.length}\uE001`;
    protectedCode.push(raw); text = text.replaceAll(raw, marker);
  }
  text = text.replace(/<at\s+user_id\s*=\s*["']((?:ou_[A-Za-z0-9]+)|all)["']\s*>/g, "<at id=$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
  for (const [index, raw] of protectedCode.entries()) text = text.replaceAll(`${prefix}${index}\uE001`, raw);
  return text;
}

function isRecords(token: Token): token is Tokens.List {
  if (token.type !== "list") return false;
  const list = token as Tokens.List;
  return list.items.length > 1 && list.items.every(item => {
    if (item.tokens.some(child => child.type === "list" && (child as Tokens.List).items.length > 1)) return true;
    if (/^\s*\*\*[^\n*]+\*\*\s*[:：]/.test(item.text)) return true;
    return (item.text.match(/(?:^|[\n,，;；])\s*[^\n:：,，;；]{1,24}[:：]\s*\S/g) ?? []).length >= 2;
  });
}

function table(token: Tokens.Table): Record<string, unknown> {
  const columns = token.header.slice(0, tableColumns).map((cell, index) => ({
    name: `c${index}`, display_name: plain(cell.text), data_type: "lark_md", width: "auto"
  }));
  return {
    tag: "table", page_size: 5, row_height: "auto", freeze_first_column: true,
    header_style: { background_style: "grey", bold: true }, columns,
    rows: token.rows.slice(0, tableRows).map(row => Object.fromEntries(columns.map((column, index) => [column.name, cardMarkdown(row[index]?.text ?? "")]))),
    margin: "0px"
  };
}

function records(token: Tokens.List): Record<string, unknown> {
  return { tag: "column_set", flex_mode: "none", background_style: "grey-50", columns: [{ tag: "column", width: "weighted", weight: 1,
    padding: "8px", vertical_spacing: "8px", elements: token.items.slice(0, recordRows).map((item, index) => ({
      tag: "markdown", content: cardMarkdown(`${token.ordered ? `${Number(token.start || 1) + index}. ` : ""}${item.text}`), text_size: "normal", margin: "0px"
    })) }] };
}

export function renderLarkReply(markdown: string): LarkReplyPresentation {
  // A synthetic leading mention must not turn the first heading or list into plain text.
  const display = markdown.replace(/^((?:<at\s+user_id=["'](?:ou_[A-Za-z0-9]+|all)["']>[^\n]*?<\/at>\s*)+)(?=\S)/, prefix => `${prefix.trim()}\n\n`);
  const tokens = Lexer.lex(display, { gfm: true });
  const tables = tokens.filter(token => token.type === "table") as Tokens.Table[];
  const lists = tokens.filter(isRecords);
  const needsCard = tables.length > 0 || lists.length > 0;
  if (!needsCard && bytes(post(display).content) <= maxBodyBytes) return post(display);
  let overflow = tables.length > 5 || tables.some(item => item.rows.length > tableRows || item.header.length > tableColumns)
    || lists.some(item => item.items.length > recordRows) || Buffer.byteLength(markdown, "utf8") > maxBodyBytes;
  const elements: Record<string, unknown>[] = [];
  let shownTables = 0;
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "table") {
      if (++shownTables <= 5) elements.push(table(token as Tokens.Table));
    } else if (isRecords(token)) elements.push(records(token));
    else {
      const last = elements.at(-1);
      const text = cardMarkdown(token.raw);
      if (last?.tag === "markdown") last.content = `${last.content}\n\n${text}`;
      else elements.push({ tag: "markdown", content: text, text_size: "normal", margin: "0px" });
    }
  }
  if (elements[0]?.tag !== "markdown") elements.unshift({ tag: "markdown", content: "**数据结果**", text_size: "normal", margin: "0px" });
  const notice = [
    ...tables.filter(item => item.rows.length > tableRows || item.header.length > tableColumns).map(item =>
      `表格共 ${item.rows.length} 行、${item.header.length} 列，本卡展示前 ${Math.min(tableRows, item.rows.length)} 行、${Math.min(tableColumns, item.header.length)} 列。`),
    ...lists.filter(item => item.items.length > recordRows).map(item => `列表共 ${item.items.length} 项，本卡展示前 ${recordRows} 项。`),
    ...(tables.length > 5 ? [`共 ${tables.length} 个表格，本卡展示前 5 个。`] : []),
    "完整内容见随附的 Markdown 文件。"
  ].join("\n");
  const makeCard = (body: Record<string, unknown>[]): LarkReplyPresentation => ({ version: 1, msgType: "interactive", content: {
    schema: "2.0", config: { update_multi: true, width_mode: tables.length ? "fill" : "default" },
    body: { direction: "vertical", padding: "12px", vertical_spacing: "8px", elements: body }
  } });
  if (needsCard) {
    const card = makeCard(overflow ? [...elements, { tag: "markdown", content: notice, text_size: "notation" }] : elements);
    const count = (items: Record<string, unknown>[]): number => items.reduce((total, item) => total + 1
      + (Array.isArray(item.elements) ? count(item.elements) : 0) + (Array.isArray(item.columns) && item.tag === "column_set" ? count(item.columns) : 0), 0);
    if (elements.length <= 60 && count(elements) < 190 && bytes(card.content) <= maxBodyBytes) return { ...card, ...(overflow ? { overflowMarkdown: markdown } : {}) };
  }
  const excerpt = tokens.find(token => token.type === "paragraph" && token.raw.length < 1000)?.raw ?? "";
  const preview = post(`**完整结果见附件**\n\n${excerpt}\n\n回复内容较长，本条仅展示摘要，完整内容见随附的 Markdown 文件。`);
  return { ...preview, overflowMarkdown: markdown };
}

export function parseLarkReplyPresentation(value: string): LarkReplyPresentation {
  const item = JSON.parse(value) as LarkReplyPresentation;
  if (item.version !== 1 || !["post", "interactive"].includes(item.msgType) || !item.content || typeof item.content !== "object" || Array.isArray(item.content)
    || bytes(item.content) > maxBodyBytes || item.overflowMarkdown !== undefined && typeof item.overflowMarkdown !== "string") throw new Error("Invalid reply presentation snapshot");
  if (item.msgType === "post" && !item.content.zh_cn || item.msgType === "interactive" && (item.content.schema !== "2.0" || !item.content.body)) throw new Error("Invalid reply presentation content");
  return item;
}
