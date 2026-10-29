import { spawnSync } from "node:child_process";
import { auditPublication, git, publicationPolicy } from "./check-publication.mjs";

try {
  const result = auditPublication("refs/heads/main", publicationPolicy(undefined, true));
  if (!result.ok) throw new Error(`Publication audit rejected ${result.findings.length} findings; run npm run publication:check`);
  const urls = git("config", "--get-all", "remote.sync.pushurl").split("\n");
  if (new Set(urls).size !== 2) throw new Error("Configure exactly two distinct sync push URLs");
  const read = url => git("ls-remote", url, "refs/heads/main").split(/\s+/)[0] || null;
  const before = urls.map(read);
  for (let i = 0; i < urls.length; i++) {
    if (!before[i]) continue;
    git("fetch", "--no-tags", urls[i], "refs/heads/main");
    if (spawnSync("git", ["merge-base", "--is-ancestor", before[i], result.oid]).status !== 0) throw new Error("A remote main diverged; no push performed");
  }
  if (git("rev-parse", "refs/heads/main") !== result.oid) throw new Error("Local main changed during preflight; no push performed");
  const pushed = spawnSync("git", ["-c", "push.followTags=false", "push", "sync", "refs/heads/main:refs/heads/main"], { encoding: "utf8" });
  const after = urls.map(read);
  if (pushed.status !== 0 || after.some(oid => oid !== result.oid)) throw new Error("Main synchronization incomplete; do not report success. Resolve the failed remote and retry without force");
  console.log(JSON.stringify({ ok: true, oid: result.oid, remoteCount: after.length }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
