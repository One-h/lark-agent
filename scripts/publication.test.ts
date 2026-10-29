import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lark-publication-"));
  const cwd = path.join(root, "repo"); fs.mkdirSync(cwd);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Contributor", GIT_AUTHOR_EMAIL: "contributor@users.noreply.github.com", GIT_COMMITTER_NAME: "Contributor", GIT_COMMITTER_EMAIL: "contributor@users.noreply.github.com" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  const policy = path.join(root, "policy.json"); fs.writeFileSync(policy, JSON.stringify({ denyTerms: ["private-team.invalid"] }));
  const run = (name: string, args: string[] = [], input?: string) => spawnSync(process.execPath, [path.join(scripts, name), ...args], { cwd, env: { ...env, PUBLICATION_POLICY_PATH: policy }, encoding: "utf8", input });
  const commit = (content = "public content", extraEnv = {}) => {
    fs.writeFileSync(path.join(cwd, "note.txt"), content); git("add", "note.txt");
    execFileSync("git", ["commit", "-m", "Update fixture"], { cwd, env: { ...env, ...extraEnv }, stdio: "pipe" });
    return git("rev-parse", "HEAD");
  };
  return { root, cwd, env, git, run, commit, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("publication audit checks deleted historical content and raw private commit identities", () => {
  const f = fixture(); try {
    f.commit();
    assert.equal(f.run("check-publication.mjs").status, 0);
    f.commit("private-team.invalid", { GIT_AUTHOR_EMAIL: "contributor@private-team.invalid" });
    f.commit("now public again");
    const result = f.run("check-publication.mjs"); assert.equal(result.status, 1);
    const value = JSON.parse(result.stdout);
    assert(value.findings.some((x: { rule: string }) => x.rule === "private-term"));
    assert(value.findings.some((x: { rule: string }) => x.rule === "private-commit-identity"));
    assert(!result.stdout.includes("private-team.invalid"));
  } finally { f.close(); }
});

test("publication audit rejects live-style identifiers and tracked persistent data, but allows examples", () => {
  const f = fixture(); try {
    f.commit("/Users/example/work/report.txt"); assert.equal(f.run("check-publication.mjs").status, 0);
    f.commit("ou_" + "a".repeat(32));
    fs.mkdirSync(path.join(f.cwd, "data")); fs.writeFileSync(path.join(f.cwd, "data", "records.sqlite"), "private state");
    f.git("add", "data"); f.git("commit", "-m", "Fixture private data");
    const result = JSON.parse(f.run("check-publication.mjs").stdout);
    assert(result.findings.some((x: { rule: string }) => x.rule === "live-message-identity"));
    assert(result.findings.some((x: { rule: string }) => x.rule === "private-file"));
  } finally { f.close(); }
});

test("pre-push refuses a private archive on public remotes and single-target main writes", () => {
  const f = fixture(); try {
    const oid = f.commit();
    const update = `refs/heads/main ${oid} refs/heads/main ${"0".repeat(40)}\n`;
    assert.equal(f.run("check-publication.mjs", ["--pre-push", "origin", "file:///private"], update).status, 1);
    const archive = update.replace(/refs\/heads\/main/g, "refs/heads/archive/private");
    assert.equal(f.run("check-publication.mjs", ["--pre-push", "github", "https://github.com/example/repo.git"], archive).status, 1);
    f.git("config", "--add", "remote.sync.pushurl", "file:///remote-one");
    f.git("config", "--add", "remote.sync.pushurl", "file:///remote-two");
    assert.equal(f.run("check-publication.mjs", ["--pre-push", "sync", "file:///remote-one"], update).status, 0);
    assert.equal(f.run("check-publication.mjs", ["--pre-push", "sync", "file:///remote-one"], update.replace(oid, "0".repeat(40))).status, 1);
  } finally { f.close(); }
});

test("sync publishes the identical main to two remotes and refuses divergence before either write", () => {
  const f = fixture(); try {
    const remotes = ["one", "two"].map(name => path.join(f.root, name + ".git"));
    for (const remote of remotes) execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    f.git("remote", "add", "sync", remotes[0]);
    for (const remote of remotes) f.git("config", "--add", "remote.sync.pushurl", remote);
    const first = f.commit(); assert.equal(f.run("sync-main.mjs").status, 0);
    const read = (remote: string) => execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
    assert(remotes.every(remote => read(remote) === first));
    const second = f.commit("second"); assert.equal(f.run("sync-main.mjs").status, 0);
    assert(remotes.every(remote => read(remote) === second));
    f.commit("local third");
    f.git("checkout", "-b", "diverged", first); const divergent = f.commit("independent branch");
    f.git("push", remotes[1], "HEAD:refs/heads/main", "--force"); f.git("checkout", "main");
    const failed = f.run("sync-main.mjs"); assert.equal(failed.status, 1); assert.match(failed.stderr, /diverged/);
    assert.equal(read(remotes[0]), second); assert.equal(read(remotes[1]), divergent);
  } finally { f.close(); }
});

test("a rejected second remote reports incomplete synchronization and allows a safe retry", () => {
  const f = fixture(); try {
    const remotes = ["one", "two"].map(name => path.join(f.root, name + ".git"));
    for (const remote of remotes) execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    f.git("remote", "add", "sync", remotes[0]);
    for (const remote of remotes) f.git("config", "--add", "remote.sync.pushurl", remote);
    f.commit(); assert.equal(f.run("sync-main.mjs").status, 0);
    const hook = path.join(remotes[1], "hooks", "pre-receive"); fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const oid = f.commit("next"); const failed = f.run("sync-main.mjs");
    assert.equal(failed.status, 1); assert.match(failed.stderr, /incomplete/);
    fs.unlinkSync(hook); assert.equal(f.run("sync-main.mjs").status, 0);
    assert.equal(execFileSync("git", ["--git-dir", remotes[1], "rev-parse", "main"], { encoding: "utf8" }).trim(), oid);
  } finally { f.close(); }
});

test("missing and malformed private publication policies fail closed", () => {
  const f = fixture(); try {
    f.commit(); fs.unlinkSync(path.join(f.root, "policy.json"));
    assert.equal(f.run("check-publication.mjs", ["main", "--require-policy"]).status, 1);
    fs.writeFileSync(path.join(f.root, "policy.json"), JSON.stringify({ denyTerms: [], typo: true }));
    assert.equal(f.run("check-publication.mjs", ["main", "--require-policy"]).status, 1);
  } finally { f.close(); }
});

test("installed Git pre-push hooks allow audited dual synchronization and block a direct main push", () => {
  const f = fixture(); try {
    const remotes = ["one", "two"].map(name => path.join(f.root, name + ".git"));
    for (const remote of remotes) execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    f.git("remote", "add", "sync", remotes[0]); f.git("remote", "add", "origin", remotes[0]);
    for (const remote of remotes) f.git("config", "--add", "remote.sync.pushurl", remote);
    fs.mkdirSync(path.join(f.cwd, "scripts")); fs.copyFileSync(path.join(scripts, "check-publication.mjs"), path.join(f.cwd, "scripts", "check-publication.mjs"));
    f.git("config", "core.hooksPath", path.resolve(scripts, "../.githooks"));
    const first = f.commit(); assert.equal(f.run("sync-main.mjs").status, 0);
    f.commit("second");
    assert.throws(() => f.git("push", "origin", "main"));
    assert.equal(execFileSync("git", ["--git-dir", remotes[0], "rev-parse", "main"], { encoding: "utf8" }).trim(), first);
    assert.equal(f.run("sync-main.mjs").status, 0);
  } finally { f.close(); }
});
