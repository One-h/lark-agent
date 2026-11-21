import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type ManagedChatCreator = (input: { ownerId: string; name: string; requestId: string }) =>
  Promise<{ chatId: string; ownerConfirmed: boolean }>;

export const createManagedLarkChat: ManagedChatCreator = async ({ ownerId, name, requestId }) => {
  const { stdout } = await exec("lark-cli", [
    "im", "chats", "create", "--as", "bot", "--user-id-type", "open_id",
    "--uuid", requestId, "--set-bot-manager", "--format", "json", "--data",
    JSON.stringify({ name, chat_mode: "group", chat_type: "private", external: false,
      owner_id: ownerId, user_id_list: [ownerId] })
  ], { timeout: 20_000, maxBuffer: 128 * 1024 });
  const result = JSON.parse(stdout);
  if (result?.ok !== true || result.identity !== "bot" || typeof result.data?.chat_id !== "string")
    throw new Error("Lark group creation result could not be confirmed");
  return { chatId: result.data.chat_id, ownerConfirmed: result.data.owner_id === ownerId };
};
