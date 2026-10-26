import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ReplyMedia = { relativePath: string; absolutePath: string; kind: "image" | "file"; size: number; stickerId?: string; sha256?: string };
export type RegisteredAttachment = ReplyMedia & { id: string; name: string; sourcePath: string; sha256: string };
export type AttachmentContext = { threadId: string; turnId: string; messageId: number; taskDir: string };
export type AttachmentState = Pick<AttachmentContext, "threadId" | "turnId" | "messageId"> & { files: RegisteredAttachment[] };
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const within = (file: string, directory: string) => file.startsWith(`${directory}${path.sep}`);

export function resolveReplyAttachment(taskDir: string, requestedPath: string): ReplyMedia {
  if (!requestedPath.trim() || requestedPath.length > 1024 || path.isAbsolute(requestedPath) || requestedPath.includes("\0")) throw new Error("附件路径必须是 output 目录下的相对路径");
  const output = path.resolve(taskDir, "output");
  const candidate = path.resolve(output, requestedPath);
  if (!within(candidate, output) || !fs.existsSync(candidate)) throw new Error(`附件不存在或不在 output 目录中：${requestedPath}`);
  const realTask = fs.realpathSync(taskDir), realOutput = fs.realpathSync(output), realCandidate = fs.realpathSync(candidate);
  if (!within(realOutput, realTask) || !within(realCandidate, realOutput)) throw new Error("附件路径不安全");
  const stat = fs.statSync(realCandidate);
  const kind = imageExtensions.has(path.extname(realCandidate).toLowerCase()) ? "image" : "file";
  if (!stat.isFile() || stat.size < 1 || stat.size > (kind === "image" ? 10 : 50) * 1024 * 1024) throw new Error("附件类型或大小不符合限制");
  return { relativePath: path.relative(taskDir, candidate), absolutePath: realCandidate, kind, size: stat.size };
}

export function attachmentDigest(file: string, maxBytes = 50 * 1024 * 1024): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("附件不是普通文件");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0, count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      bytes += count;
      if (bytes > maxBytes) throw new Error("附件大小不符合限制");
      hash.update(buffer.subarray(0, count));
    }
    if (bytes === 0) throw new Error("附件为空");
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

export function matchingAttachmentState(state: AttachmentState | undefined, context: Pick<AttachmentContext, "threadId" | "turnId" | "messageId">): boolean {
  return Boolean(state && state.threadId === context.threadId && state.turnId === context.turnId && state.messageId === context.messageId);
}

function snapshotAttachment(context: AttachmentContext, entry: { path: string; name?: string }): RegisteredAttachment {
  const source = resolveReplyAttachment(context.taskDir, entry.path);
  const name = entry.name?.trim() ?? path.basename(source.absolutePath);
  if (!name || name.length > 160 || /[/\\\x00-\x1f\x7f]/.test(name) || [".", ".."].includes(name)
    || path.extname(name).toLowerCase() !== path.extname(source.absolutePath).toLowerCase()) throw new Error("附件名称必须是保留原扩展名的普通文件名");
  const digest = attachmentDigest(source.absolutePath, (source.kind === "image" ? 10 : 50) * 1024 * 1024);
  const id = `att_${crypto.createHash("sha256").update(JSON.stringify([context.threadId, context.turnId, context.messageId, source.absolutePath, digest, name])).digest("hex").slice(0, 24)}`;
  const relative = path.join(".attachments", id, name);
  const realOutput = fs.realpathSync(path.join(context.taskDir, "output"));
  const root = path.join(realOutput, ".attachments");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  if (!within(fs.realpathSync(root), realOutput)) throw new Error("附件快照目录不安全");
  const directory = path.join(root, id);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  if (!within(fs.realpathSync(directory), realOutput)) throw new Error("附件快照目录不安全");
  const target = path.join(directory, name);
  if (!fs.existsSync(target)) fs.copyFileSync(source.absolutePath, target, fs.constants.COPYFILE_EXCL);
  const snapshot = resolveReplyAttachment(context.taskDir, relative);
  if (attachmentDigest(snapshot.absolutePath) !== digest) throw new Error("附件在登记期间发生变化，请重新生成并登记");
  fs.chmodSync(snapshot.absolutePath, 0o600);
  return { ...snapshot, id, name, sourcePath: source.absolutePath, sha256: digest };
}

export function registerReplyAttachments(args: unknown, context: AttachmentContext, previous?: AttachmentState) {
  const state: AttachmentState = matchingAttachmentState(previous, context)
    ? { ...previous!, files: [...previous!.files] }
    : { threadId: context.threadId, turnId: context.turnId, messageId: context.messageId, files: [] };
  try {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "files")) throw new Error("只接受 files；接收对象由当前消息绑定");
    const files = (args as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length > 8) throw new Error("files 必须是最多 8 个附件的数组，空数组用于清空登记");
    const parsed = files.map(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some(key => !["path", "name"].includes(key))
        || typeof entry.path !== "string" || (entry.name !== undefined && typeof entry.name !== "string")) throw new Error("每个附件需要 path 和可选 name");
      return { path: entry.path as string, ...(entry.name === undefined ? {} : { name: entry.name as string }) };
    });
    const selected = new Map(state.files.map(file => [file.sourcePath, file]));
    if (parsed.length === 0) selected.clear();
    for (const entry of parsed) {
      const attachment = snapshotAttachment(context, entry);
      selected.set(attachment.sourcePath, attachment);
    }
    if (selected.size > 8) throw new Error("本条消息最多登记 8 个附件");
    const next = { ...state, files: [...selected.values()] };
    const fd = fs.openSync(path.join(context.taskDir, "reply-attachments.json"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("附件登记文件不安全");
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    return { state: next, result: { success: true, contentItems: [{ type: "inputText" as const, text: JSON.stringify({ status: "staged", sent: false,
      files: next.files.map(file => ({ id: file.id, name: file.name, kind: file.kind, size: file.size })), message: "附件已登记，正常结束本轮后才投递；最终回复无需媒体标签。" }) }] } };
  } catch (error) {
    return { state, result: { success: false, contentItems: [{ type: "inputText" as const, text: error instanceof Error ? error.message : "附件登记失败" }] } };
  }
}

export function registeredReplyMedia(state: AttachmentState | undefined, context: Pick<AttachmentContext, "threadId" | "turnId" | "messageId">): RegisteredAttachment[] {
  return matchingAttachmentState(state, context) ? state!.files : [];
}

export function validateRegisteredAttachment(taskDir: string, file: RegisteredAttachment): ReplyMedia {
  const resolved = resolveReplyAttachment(taskDir, path.relative(path.resolve(taskDir, "output"), path.resolve(taskDir, file.relativePath)));
  if (attachmentDigest(resolved.absolutePath, (resolved.kind === "image" ? 10 : 50) * 1024 * 1024) !== file.sha256) throw new Error("已登记的附件发生变化，未发送");
  return { ...resolved, sha256: file.sha256 };
}

export function attachmentToolPrompt(contextToken: string | undefined, outputDirectory: string | undefined): string {
  if (!contextToken || !outputDirectory) return "";
  return `附件：将要交付的图片或文档生成到 ${outputDirectory}，再调用 lark_stickers MCP 的 attach_files 登记 output 相对路径（可选 name 保留扩展名）。重复路径只保留最新登记，最多 8 个，files=[] 清空。本轮 context_token=${contextToken}。工具返回 staged 表示待投递，不是已发送；登记失败先修正文件。最终只写普通回复，无需媒体标签；可以只交付附件。任务取消或不回复时不发送暂存附件。`;
}
