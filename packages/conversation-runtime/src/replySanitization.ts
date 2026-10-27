const unavailableReply = "这次未能提供有效答复，请补充你需要确认的具体事项。";

const internalPolicy = /(?:依据|根据|遵循|按照|受限于)[^。！？!?；;\n]{0,60}(?:AGENTS\.md|SKILL\.md|docs\/skills|knowledge\/topics|(?:本机|当前|项目)\s*工作区(?:规则)?)|当前发送人[^。！？!?；;\n]{0,20}(?:可信|不可信)|(?:你|您|对方|用户)(?:是|属于|未通过|已通过)[^。！？!?；;\n]{0,8}(?:可信校验|可信用户|不可信)|(?:需要|等待|仅限)[^。！？!?；;\n]{0,12}可信用户|(?:我|当前会话)(?:目前|当前|只能|正在|处于|使用|运行在|是|为|以|在|\s){0,12}(?:read-only|sandbox|Codex exec)|(?:内部上下文|权限边界|执行边界|工作区规则)/i;

function redactReplyValues(text: string, privateRoots: string[]): string {
  for (const root of privateRoots.filter(value => value.length > 2)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![A-Za-z0-9:/])${escaped}(?=$|[\\s/])[^\\s<>"'\x60，。；！？、）)\\]}]*`, "g"), "[本机路径已隐藏]");
  }
  return text
    .replace(/(?<![A-Za-z0-9:/])(?:file:\/\/)?\/(?:Users|home)\/[^\s<>"'`，。；！？、）)\]}]+/gi, "[本机路径已隐藏]")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, "[凭据已隐藏]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[凭据已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[凭据已隐藏]")
    .replace(/(\b(?:context_token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s,;，。；<>]+)/gi, '$1"[已隐藏]"');
}

export function sanitizeLarkReply(answer: string, trustedSender: boolean, privateRoots: string[] = []): string {
  const text = answer.trim();
  if (trustedSender || !text) return text;
  // Keep business clauses surrounding an internal-policy explanation.
  const cleaned = redactReplyValues(text, privateRoots).split(/(\r?\n)/).map(line => {
    if (/^\r?\n$/.test(line)) return line;
    const clauses = line.match(/[^，,。！？!?；;]+[，,。！？!?；;]?/g) ?? [];
    const visible = clauses.filter(clause => !internalPolicy.test(clause));
    return visible.length === clauses.length ? line : visible.join("").replace(/^[，,；;]+/, "").replace(/[，,；;]$/, "。");
  }).join("");
  const redacted = cleaned.replace(/\b(?:AGENTS|SKILL)\.md\b|docs\/skills(?:\/[^\s<>"'`，。；！？、）)\]}]*)?|knowledge\/topics(?:\/[^\s<>"'`，。；！？、）)\]}]*)?/gi, "[内部文档已隐藏]");
  return redacted === text ? text : redacted.replace(/\n{3,}/g, "\n\n").trim() || unavailableReply;
}
