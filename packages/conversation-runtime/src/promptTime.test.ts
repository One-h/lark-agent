import assert from "node:assert/strict";
import test from "node:test";
import { larkPromptTime, shortLarkTime } from "./promptTime.js";

test("message time uses one Beijing minute stamp and only adds processing time when needed", () => {
  const sent = "2026-10-22T11:16:26.000Z";
  assert.equal(larkPromptTime({ message_at: sent }, new Date("2026-10-22T11:16:59Z")), "时间(+08:00)：消息 2026-10-22 19:16");
  assert.equal(larkPromptTime({ message_at: sent }, new Date("2026-10-22T11:18:00Z")), "时间(+08:00)：消息 2026-10-22 19:16；当前 19:18");
  assert.equal(larkPromptTime({ message_at: sent }, new Date("2026-10-23T01:00:00Z")), "时间(+08:00)：消息 2026-10-22 19:16；当前 2026-10-23 09:00");
  assert.equal(shortLarkTime("2026-10-22T16:00:00Z"), "2026-10-23 00:00");
});

test("legacy or invalid message times fall back without fabricating a send time", () => {
  const now = new Date("2026-10-22T11:16:26Z");
  assert.equal(larkPromptTime({ message_at: "invalid", received_at: now.toISOString() }, now), "时间(+08:00)：消息 2026-10-22 19:16");
  assert.equal(larkPromptTime({ created_at: now.toISOString() }, now), "时间(+08:00)：消息 2026-10-22 19:16");
  assert.equal(larkPromptTime({}, now), "时间(+08:00)：当前 2026-10-22 19:16");
  assert.equal(shortLarkTime(null), null);
  assert.equal(shortLarkTime("invalid"), null);
});
