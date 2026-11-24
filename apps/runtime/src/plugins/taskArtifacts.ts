import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TaskArtifact = { name: string; checksum: string; bytes: Buffer | null; commit: string | null };
const fileName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.(?:md|txt|csv|tsv|json|pdf|xlsx|ods)$/i;
const idPattern = /^[0-9a-f-]{36}$/;
const maxBytes = 4 * 1024 * 1024;
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export class TaskArtifacts {
  constructor(private readonly base: string) {}

  private directory(id: string, mode: "worker" | "reviewer"): string {
    if (!idPattern.test(id)) throw new Error("Invalid task artifact identity");
    mkdirSync(this.base, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.base);
    const state = lstatSync(this.base);
    if (!state.isDirectory() || (state.mode & 0o077) !== 0 || state.uid !== process.getuid?.())
      throw new Error("Task artifacts require a private, user-owned root");
    const directory = path.join(root, mode + "-" + id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || realpathSync(directory) !== directory)
      throw new Error("Task artifact directory was replaced");
    return directory;
  }

  workerDirectory(id: string): string { return this.directory(id, "worker"); }

  freeze(id: string, text: string, workspace: string): { text: string; artifacts: TaskArtifact[] } {
    const artifacts: TaskArtifact[] = [];
    const content: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^Artifact:/i.test(line)) { content.push(line); continue; }
      if (artifacts.length >= 4) throw new Error("Too many declared task artifacts");
      const match = /^Artifact: (file|git) (\S+)$/.exec(line);
      if (!match) throw new Error("Invalid task artifact declaration");
      const [, kind, value] = match;
      if (artifacts.some(artifact => artifact.name === value)) throw new Error("Duplicate task artifact");
      if (kind === "git") {
        if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value)) throw new Error("A Git artifact needs a full commit object ID");
        const actual = execFileSync("git", ["--no-optional-locks", "-C", workspace, "cat-file", "-t", value],
          { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
        if (actual.trim() !== "commit") throw new Error("The Git artifact is not a commit");
        artifacts.push({ name: value, checksum: value, bytes: null, commit: value });
        continue;
      }
      if (!fileName.test(value)) throw new Error("A file must be named within the designated task directory");
      const directory = this.workerDirectory(id);
      const source = path.join(directory, value);
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.size < 1 || before.size > maxBytes)
          throw new Error("Unsupported task file, link, ownership or size");
        const bytes = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = readSync(fd, bytes, count, bytes.length - count, count);
          if (!read) break;
          count += read;
        }
        const after = fstatSync(fd);
        const published = lstatSync(source);
        if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1
          || !published.isFile() || published.ino !== after.ino || published.dev !== after.dev
          || realpathSync(source) !== source)
          throw new Error("Task file changed while freezing");
        const exact = bytes.subarray(0, count);
        artifacts.push({ name: value, checksum: checksum(exact), bytes: exact, commit: null });
      } finally { closeSync(fd); }
    }
    return { text: content.join("\n").trim(), artifacts };
  }

  reviewInput(reviewId: string, artifacts: readonly TaskArtifact[], workspace: string): string {
    return artifacts.map(artifact => {
      if (artifact.commit) {
        const type = execFileSync("git", ["--no-optional-locks", "-C", workspace, "cat-file", "-t", artifact.commit],
          { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
        if (type.trim() !== "commit") throw new Error("Frozen Git commit is not available in the reviewer workspace");
        return "Git commit: " + artifact.commit;
      }
      if (!fileName.test(artifact.name) || !artifact.bytes || checksum(artifact.bytes) !== artifact.checksum)
        throw new Error("Task artifact integrity check failed");
      const target = path.join(this.directory(reviewId, "reviewer"), artifact.name);
      try { writeFileSync(target, artifact.bytes, { flag: "wx", mode: 0o400 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = lstatSync(target);
        if (!info.isFile() || info.nlink !== 1 || info.size !== artifact.bytes.length
          || !readFileSync(target).equals(artifact.bytes)) throw new Error("Reviewer artifact cache differs from the frozen version");
      }
      return "Frozen file: " + target + " (SHA-256 " + artifact.checksum + ")";
    }).join("\n");
  }
}
