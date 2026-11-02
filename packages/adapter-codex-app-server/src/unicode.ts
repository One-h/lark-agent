// Keep the existing UTF-16 budget without cutting a Unicode surrogate pair.
export function unicodeSafePrefix(text: string, maxCodeUnits: number): string {
  let end = Math.min(text.length, Math.max(0, Math.trunc(maxCodeUnits)));
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return text.slice(0, end);
}

export function serializeCodexAppServerMessage(message: unknown): string {
  const invalidSurrogate = /[\uD800-\uDFFF]/u;
  const serialized = JSON.stringify(message, (key, value: unknown) => {
    if (invalidSurrogate.test(key) || typeof value === "string" && invalidSurrogate.test(value)) {
      throw new Error("Codex app-server payload contains invalid Unicode; no message was sent");
    }
    return value;
  });
  if (serialized === undefined) throw new Error("Codex app-server message must be JSON serializable");
  return serialized;
}
