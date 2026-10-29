import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
const publicEmail = /@(?:users\.noreply\.github\.com|example\.(?:com|net|org))$/i;

export function publicationPolicy(explicit, required = false) {
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const filename = explicit || process.env.PUBLICATION_POLICY_PATH || path.join(common, "publication-policy.json");
  if (!fs.existsSync(filename)) {
    if (required) throw new Error("Configure the local Git publication-policy.json before publishing main");
    return { denyTerms: [] };
  }
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!value || Object.keys(value).some(key => key !== "denyTerms") || !Array.isArray(value.denyTerms) || value.denyTerms.some(term => typeof term !== "string" || !term.trim())) {
    throw new Error("Publication policy must contain a denyTerms string array");
  }
  return { denyTerms: value.denyTerms.map(term => term.toLowerCase()) };
}

export function auditPublication(ref, policy) {
  const oid = git("rev-parse", "--verify", `${ref}^{commit}`);
  const objects = git("rev-list", "--objects", "--no-object-names", oid).split("\n");
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    input: objects.join("\n") + "\n", maxBuffer: 256 * 1024 * 1024
  });
  const findings = [], commits = [], paths = new Set();
  const report = (rule, object) => findings.push({ rule, object: object.slice(0, 12) });
  const inspect = (text, object) => {
    if (policy.denyTerms.some(term => text.toLowerCase().includes(term))) report("private-term", object);
    if (/\b(?:ou|oc|om)_(?:x)?[a-f0-9]{24,}\b/i.test(text)) report("live-message-identity", object);
    if (/(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|(?:sk|rk)-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{40,})/.test(text)) report("credential", object);
    for (const match of text.matchAll(/\/(?:Users|home)\/([^/\s'"`]+)/g)) {
      if (!/^(?:example|user|runner|app|demo|test|name|<[^>]+>|\$\{[^}]+\})$/.test(match[1])) report("personal-home", object);
    }
  };
  let offset = 0, blobs = 0;
  for (const expected of objects) {
    const end = batch.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete Git object batch");
    const [object, type, sizeText] = batch.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText), start = end + 1;
    if (object !== expected || !Number.isSafeInteger(size) || size < 0 || start + size >= batch.length || batch[start + size] !== 10) throw new Error("Invalid Git object batch");
    const data = batch.subarray(start, start + size).toString("utf8");
    offset = start + size + 1;
    if (type === "commit") {
      commits.push(object);
      for (const field of ["author", "committer"]) {
        const email = data.match(new RegExp(`^${field} .* <([^<>]+)> [0-9]+ [+-][0-9]{4}$`, "m"))?.[1];
        if (!email || !publicEmail.test(email)) report("private-commit-identity", object);
      }
      inspect(data, object);
    } else if (type === "blob") { blobs++; inspect(data, object); }
  }
  for (const commit of commits) {
    const names = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", commit], { encoding: "utf8" });
    for (const name of names.split("\0").filter(Boolean)) paths.add(name);
  }
  for (const name of paths) {
    inspect(name, oid);
    if (/^data\//.test(name) || /(?:^|\/)(?:runtime\.env|\.env(?:\.[^/]+)?)$/.test(name) && !/\.(?:example|sample|template)$/.test(name)
      || /\.(?:sqlite(?:-wal|-shm)?|p12|pfx|pem)$/.test(name)) report("private-file", oid);
  }
  return { ok: findings.length === 0, oid, commits: commits.length, blobs, paths: paths.size, findings };
}

export function checkPrePush(remote, url, input) {
  const isPublic = remote === "github" || /(?:github\.com[:/])/.test(url);
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [localRef, localOid, remoteRef] = line.split(/\s+/);
    if (isPublic && remoteRef !== "refs/heads/main") throw new Error("Only main may be published; internal archive refs and tags stay private");
    if (remoteRef !== "refs/heads/main") continue;
    if (remote !== "sync") throw new Error("Publish main with npm run sync:main so both remotes are updated");
    const urls = git("config", "--get-all", "remote.sync.pushurl").split("\n");
    if (new Set(urls).size !== 2) throw new Error("The sync remote must have exactly two distinct push URLs");
    if (localRef !== "refs/heads/main" || localOid !== git("rev-parse", "refs/heads/main")) throw new Error("Only the local main ref may update remote main");
    const result = auditPublication(localOid, publicationPolicy(undefined, true));
    if (!result.ok) throw new Error(`Publication audit rejected ${result.findings.length} findings; run npm run publication:check`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--pre-push") checkPrePush(args[1], args[2], fs.readFileSync(0, "utf8"));
    else {
      const index = args.indexOf("--policy");
      const ref = args[0] && !args[0].startsWith("--") ? args[0] : "HEAD";
      const result = auditPublication(ref, publicationPolicy(index >= 0 ? args[index + 1] : undefined, args.includes("--require-policy")));
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
