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

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readSnapshotSource(source: ReplyMedia, output: string): Buffer {
  const expected = fs.lstatSync(source.absolutePath);
  const fd = fs.openSync(source.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    const realFile = fs.realpathSync(source.absolutePath);
    if (!expected.isFile() || !before.isFile() || before.nlink !== 1 || !sameFile(expected, before)
      || !within(realFile, output) || !sameFile(fs.lstatSync(realFile), before)) throw new Error("附件源文件发生变化或不安全");
    const limit = (source.kind === "image" ? 10 : 50) * 1024 * 1024;
    const chunks: Buffer[] = [], buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0, count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += count;
      if (size > limit) throw new Error("附件大小不符合限制");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fs.fstatSync(fd);
    if (size < 1 || size !== before.size || after.size !== before.size || after.nlink !== before.nlink
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("附件在登记期间发生变化，请重新生成并登记");
    return Buffer.concat(chunks, size);
  } finally { fs.closeSync(fd); }
}

function assertSnapshotDirectory(directory: string, output: string): void {
  if (fs.realpathSync(output) !== output || fs.realpathSync(directory) !== directory || !within(directory, output)
    || !fs.lstatSync(directory).isDirectory()) throw new Error("附件快照目录不安全");
}

export function createReplyMarkdownAttachment(taskDir: string, markdown: string): ReplyMedia {
  const contents = Buffer.from(markdown, "utf8");
  if (!contents.length || contents.length > 50 * 1024 * 1024) throw new Error("完整回复附件大小不符合限制");
  const outputPath = path.join(taskDir, "output");
  fs.mkdirSync(outputPath, { recursive: true });
  const realTask = fs.realpathSync(taskDir), output = fs.realpathSync(outputPath);
  if (!within(output, realTask)) throw new Error("完整回复附件目录不安全");
  const directory = path.join(output, ".rendered");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  assertSnapshotDirectory(directory, output);
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  const file = path.join(directory, `reply-details-${digest.slice(0, 24)}.md`);
  let fd: number | undefined;
  let created: fs.Stats | undefined;
  let complete = false;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      created = fs.fstatSync(fd);
      assertSnapshotDirectory(directory, output);
      if (!created.isFile() || created.nlink !== 1 || !sameFile(fs.lstatSync(file), created)) throw new Error("完整回复附件路径发生变化");
      fs.writeFileSync(fd, contents); fs.fsyncSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fd !== undefined) throw error;
    }
    assertSnapshotDirectory(directory, output);
    const source = resolveReplyAttachment(taskDir, path.relative(output, file));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || created && !sameFile(stat, created)
      || attachmentDigest(source.absolutePath) !== digest) throw new Error("完整回复附件校验失败");
    complete = true;
    return { ...source, sha256: digest };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!complete && created) removeCreatedSnapshot(file, created, output);
  }
}

function removeCreatedSnapshot(file: string, identity: fs.Stats, output: string): void {
  try {
    assertSnapshotDirectory(path.dirname(file), output);
    if (!sameFile(fs.lstatSync(file), identity)) return;
    fs.unlinkSync(file);
    try { fs.rmdirSync(path.dirname(file)); } catch { /* Keep nonempty directories. */ }
  } catch { /* Never follow a replaced directory to clean up another location. */ }
}

function snapshotAttachment(context: AttachmentContext, entry: { path: string; name?: string }, onCreated: (cleanup: () => void) => void): RegisteredAttachment {
  const source = resolveReplyAttachment(context.taskDir, entry.path);
  const name = entry.name?.trim() ?? path.basename(source.absolutePath);
  if (!name || name.length > 160 || /[/\\\x00-\x1f\x7f]/.test(name) || [".", ".."].includes(name)
    || path.extname(name).toLowerCase() !== path.extname(source.absolutePath).toLowerCase()) throw new Error("附件名称必须是保留原扩展名的普通文件名");
  const realOutput = fs.realpathSync(path.join(context.taskDir, "output"));
  // Copy and hash these captured bytes; never reopen the mutable source path.
  const contents = readSnapshotSource(source, realOutput);
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  const id = `att_${crypto.createHash("sha256").update(JSON.stringify([context.threadId, context.turnId, context.messageId, source.absolutePath, digest, name])).digest("hex").slice(0, 24)}`;
  const relative = path.join(".attachments", id, name);
  const root = path.join(realOutput, ".attachments");
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  assertSnapshotDirectory(root, realOutput);
  const directory = path.join(root, id);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  assertSnapshotDirectory(directory, realOutput);
  const target = path.join(directory, name);
  let fd: number | undefined;
  let created: fs.Stats | undefined;
  let complete = false;
  try {
    try {
      fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      created = fs.fstatSync(fd);
      assertSnapshotDirectory(directory, realOutput);
      if (!created.isFile() || created.nlink !== 1 || !sameFile(fs.lstatSync(target), created)) throw new Error("附件快照文件不安全");
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fd !== undefined) throw error;
    }
    assertSnapshotDirectory(directory, realOutput);
    const snapshot = resolveReplyAttachment(context.taskDir, relative);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || created && !sameFile(stat, created)
      || attachmentDigest(snapshot.absolutePath) !== digest) throw new Error("附件快照发生变化，请重新登记");
    if (created) {
      const identity = created;
      onCreated(() => removeCreatedSnapshot(target, identity, realOutput));
    }
    complete = true;
  } finally {
    if (fd !== undefined) {
      try { if (!complete) fs.ftruncateSync(fd, 0); }
      catch { /* Unlink the owned file even if truncation fails. */ }
      finally { fs.closeSync(fd); }
    }
    if (!complete && created) removeCreatedSnapshot(target, created, realOutput);
  }
  const snapshot = resolveReplyAttachment(context.taskDir, relative);
  return { ...snapshot, id, name, sourcePath: source.absolutePath, sha256: digest };
}

export function registerReplyAttachments(args: unknown, context: AttachmentContext, previous?: AttachmentState) {
  const state: AttachmentState = matchingAttachmentState(previous, context)
    ? { ...previous!, files: [...previous!.files] }
    : { threadId: context.threadId, turnId: context.turnId, messageId: context.messageId, files: [] };
  const cleanups: Array<() => void> = [];
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
      const attachment = snapshotAttachment(context, entry, (cleanup) => cleanups.push(cleanup));
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
    for (const cleanup of cleanups.reverse()) cleanup();
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
