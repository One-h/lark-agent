import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { larkStickerImage, listLarkStickers, searchLarkStickers } from "./stickers.js";

export type StickerToolState = { threadId: string; turnId: string; messageId: number; candidateIds: string[]; selectedId: string | null };
type ContentItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string };
export type StickerToolContext = { threadId: string; turnId: string; messageId: number; taskDir: string };

function thumbnail(id: string, taskDir: string): string | null {
  const source = larkStickerImage(id);
  if (!source || !/^stk_[A-Za-z0-9_-]+$/.test(id)) return null;
  const directory = path.join(taskDir, "sticker-previews");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.png`);
  if (!fs.existsSync(file)) {
    const result = spawnSync("/usr/bin/sips", ["-s", "format", "png", "-Z", "256", source.path, "--out", file], { timeout: 5000, stdio: "ignore" });
    if (result.status !== 0) return null;
  }
  if (fs.statSync(file).size > 200_000) return null;
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
}

export function runStickerTool(name: string, args: unknown, context: StickerToolContext, previous?: StickerToolState): { state: StickerToolState; result: { success: boolean; contentItems: ContentItem[] } } {
  const state: StickerToolState = previous && previous.threadId === context.threadId && previous.turnId === context.turnId && previous.messageId === context.messageId
    ? { ...previous, candidateIds: [...previous.candidateIds] }
    : { threadId: context.threadId, turnId: context.turnId, messageId: context.messageId, candidateIds: [], selectedId: null };
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected an argument object");
    const input = args as Record<string, unknown>;
    const field = name === "lark_stickers_search" ? "query" : "sticker_id";
    if (Object.keys(input).some((key) => key !== field)) throw new Error("Unexpected argument; recipient is bound to the current message");
    if (name === "lark_stickers_search") {
      if (typeof input.query !== "string" || input.query.trim().length < 2 || input.query.trim().length > 120) throw new Error("query must be 2-120 characters");
      const candidates = searchLarkStickers(input.query.trim());
      state.candidateIds = candidates.map((sticker) => sticker.id);
      const contentItems: ContentItem[] = [{ type: "inputText", text: JSON.stringify({ candidates: candidates.map((s) => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })), selectedId: state.selectedId, sent: false }) }];
      for (const candidate of candidates) {
        const imageUrl = thumbnail(candidate.id, context.taskDir);
        if (imageUrl) contentItems.push({ type: "inputText", text: `Preview: ${candidate.id}` }, { type: "inputImage", imageUrl });
      }
      return { state, result: { success: true, contentItems } };
    }
    if (name !== "lark_stickers_select") throw new Error("Unknown sticker tool");
    if (input.sticker_id !== null && (typeof input.sticker_id !== "string" || !state.candidateIds.includes(input.sticker_id) || !listLarkStickers(true).some((s) => s.id === input.sticker_id) || !larkStickerImage(input.sticker_id))) throw new Error("Select a valid candidate from this message and turn's latest search");
    state.selectedId = input.sticker_id as string | null;
    fs.writeFileSync(path.join(context.taskDir, "sticker-selection.json"), JSON.stringify(state, null, 2));
    return { state, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ status: state.selectedId ? "selected_pending_final_text" : "selection_cleared", stickerId: state.selectedId, sent: false }) }] } };
  } catch (error) {
    return { state: previous ?? state, result: { success: false, contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }] } };
  }
}

export function applySelectedSticker(answer: string | null, state: StickerToolState | undefined, context: Omit<StickerToolContext, "taskDir">): string | null {
  if (!answer || /^<(?:lark|forge)-no-reply\s*\/>$/i.test(answer.trim())) return answer;
  if (!state || state.threadId !== context.threadId || state.turnId !== context.turnId || state.messageId !== context.messageId) return answer;
  const text = answer.replace(/<(?:lark|forge)-sticker>[\s\S]*?<\/(?:lark|forge)-sticker>/gi, "").trim();
  return state.selectedId ? `${text}\n<lark-sticker>${JSON.stringify({ id: state.selectedId })}</lark-sticker>` : text;
}
