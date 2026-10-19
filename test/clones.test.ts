import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

const OLD = "2026-01-01T00:00:00Z";
const env = { ...process.env, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(cmd.join(" ") + ": " + r.stderr.toString());
  return r.stdout.toString();
};
const ageIndex = (repo: string) => { const t = new Date(OLD); utimesSync(join(repo, ".git", "index"), t, t); };

// origin (bare) + main clone "proj" + whatever extra clones the test makes, all old and pushed.
function world(ghScript = 'echo "[]"') {
  const s = sandbox({ clones: { idleDays: 14, namePatterns: ["-backup-\\d{8}$", "-pr\\d+-review$"] } });
  const root = realpathSync(s.root);
  const origin = join(realpathSync(s.dir), "proj.git");
  sh(s.dir, "git", "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "git", "clone", "-q", origin, "proj");
  const proj = join(root, "proj");
  writeFileSync(join(proj, ".gitignore"), ".env\n");
  writeFileSync(join(proj, "a.txt"), "a");
  sh(proj, "git", "add", "."); sh(proj, "git", "commit", "-qm", "init"); sh(proj, "git", "push", "-q", "origin", "main");
  sh(origin, "git", "symbolic-ref", "HEAD", "refs/heads/main");
  ageIndex(proj);
  const clone = (name: string) => { sh(root, "git", "clone", "-q", origin, name); const p = join(root, name); ageIndex(p); return p; };
  s.tool("gh", ghScript);
  s.tool("du", 'echo "10	$2"');
  const scan = async () => JSON.parse((await s.run(["scan"])).stdout);
  return { s, root, proj, clone, scan };
}
const clones = (p: any) => p.items.filter((i: any) => i.kind === "clone");

test("the primary clone (named like its origin) is never proposed while other copies are", async () => {
  const w = world();
  const a = w.clone("copy-a");
  const b = w.clone("copy-b");
  const proposed = clones(await w.scan()).map((c: any) => c.path);
  expect(proposed).not.toContain(w.proj);
  expect(proposed.sort()).toEqual([a, b].sort());
}, 60_000);

test("a clean, pushed, idle backup clone is proposed as approve with its ignored files listed", async () => {
  const w = world();
  const backup = w.clone("proj-backup-20260901");
  writeFileSync(join(backup, ".env"), "SECRET=1");
  const p = await w.scan();
  expect(clones(p)).toEqual([expect.objectContaining({ tier: "approve", path: backup, ignored: [".env"] })]);
  expect(clones(p)[0].reason).toContain("same origin as");
}, 60_000);

test("unpushed commits exclude a review clone until its PR is merged", async () => {
  const w = world();
  const review = w.clone("proj-pr12-review");
  sh(review, "git", "checkout", "-qb", "feature");
  writeFileSync(join(review, "b.txt"), "b");
  sh(review, "git", "add", "."); sh(review, "git", "commit", "-qm", "wip");
  ageIndex(review);
  let p = await w.scan();
  expect(p.excluded).toContainEqual({ kind: "clone", path: review, reason: "1 commit(s) not on any remote" });

  w.s.tool("gh", 'case "$*" in *merged*) echo \'[{"number":12}]\';; *) echo "[]";; esac');
  p = await w.scan();
  expect(clones(p).find((c: any) => c.path === review)?.reason).toContain("PR for feature merged");
}, 60_000);

test("dirty, stashed, recently used, or open-PR clones are excluded; auto is never used", async () => {
  const w = world('case "$*" in *open*) echo \'[{"number":3}]\';; *) echo "[]";; esac');
  const backup = w.clone("proj-backup-20260902");
  let p = await w.scan();
  expect(p.excluded).toContainEqual({ kind: "clone", path: backup, reason: "1 open PR(s) for main" });

  w.s.tool("gh", 'echo "[]"');
  writeFileSync(join(backup, "a.txt"), "changed");
  p = await w.scan();
  expect(p.excluded).toContainEqual({ kind: "clone", path: backup, reason: "uncommitted changes" });
  sh(backup, "git", "stash", "-q");
  ageIndex(backup);
  p = await w.scan();
  expect(p.excluded).toContainEqual({ kind: "clone", path: backup, reason: "has stashes" });
  expect(p.items.every((i: any) => i.kind !== "clone" || i.tier === "approve")).toBe(true);
}, 60_000);

test("approved apply removes the clone; the original stays", async () => {
  const w = world();
  const backup = w.clone("proj-backup-20260903");
  const p = await w.scan();
  const policy = JSON.parse(readFileSync(w.s.policyPath, "utf8"));
  expect(policy.clones).toBeDefined();
  const r = JSON.parse((await w.s.run(["apply", p.id])).stdout);
  expect(r.failures).toEqual([]);
  expect([existsSync(backup), existsSync(w.proj)]).toEqual([false, true]);
}, 60_000);
