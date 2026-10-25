type MessageTime = { message_at?: string | null; received_at?: string | null; created_at?: string | null };

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

export function shortLarkTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function larkPromptTime(message: MessageTime, now = new Date()): string {
  const current = shortLarkTime(now)!;
  const sent = [message.message_at, message.received_at, message.created_at].map(shortLarkTime).find(Boolean);
  if (!sent) return `时间(+08:00)：当前 ${current}`;
  const processing = sent === current ? "" : `；当前 ${sent.slice(0, 10) === current.slice(0, 10) ? current.slice(11) : current}`;
  return `时间(+08:00)：消息 ${sent}${processing}`;
}
