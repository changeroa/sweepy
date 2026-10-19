import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

const old = (p: string, days: number) => { const t = new Date(Date.now() - days * 86_400_000); utimesSync(p, t, t); };
const setPolicy = (s: ReturnType<typeof sandbox>, extra: object) =>
  writeFileSync(s.policyPath, JSON.stringify({ ...JSON.parse(readFileSync(s.policyPath, "utf8")), ...extra }));

test("old closed session logs are proposed for zstd archive; fresh and open ones are not", async () => {
  const s = sandbox();
  const logs = join(realpathSync(s.dir), "sessions", "2026", "05");
  mkdirSync(logs, { recursive: true });
  const [stale, fresh, other] = ["a.jsonl", "b.jsonl", "c.txt"].map((n) => join(logs, n));
  [stale, fresh, other].forEach((f) => writeFileSync(f, "x".repeat(1000)));
  old(stale, 40); old(other, 40);
  setPolicy(s, { archives: [{ id: "sessions", paths: [join(s.dir, "sessions")], match: "\\.jsonl$", olderThanDays: 30, tier: "approve" }] });
  const p = JSON.parse((await s.run(["scan"])).stdout);
  const item = p.items.find((i: any) => i.kind === "archive");
  expect(item).toMatchObject({ tier: "approve", path: "sessions", files: [stale], bytes: 850 });

  const r = JSON.parse((await s.run(["apply", p.id])).stdout);
  expect(r.failures).toEqual([]);
  expect([existsSync(stale), existsSync(stale + ".zst"), existsSync(fresh), existsSync(other)]).toEqual([false, true, true, true]);
}, 60_000);

test("an open log file is excluded from the archive", async () => {
  const s = sandbox();
  const dir = join(s.dir, "sessions");
  mkdirSync(dir);
  const f = join(dir, "live.jsonl");
  writeFileSync(f, "x");
  old(f, 40);
  setPolicy(s, { archives: [{ id: "sessions", paths: [dir], match: "\\.jsonl$", olderThanDays: 30, tier: "approve" }] });
  const holder = Bun.spawn(["sh", "-c", "exec 3<\"$0\"; echo ready; exec sleep 60", f], { stdout: "pipe" });
  const reader = holder.stdout.getReader();
  await reader.read(); // the shell holds fd 3 on the file once it prints "ready"
  try {
    const p = JSON.parse((await s.run(["scan"])).stdout);
    expect(p.items.filter((i: any) => i.kind === "archive")).toEqual([]);
    expect(p.excluded).toContainEqual({ kind: "archive", path: "sessions", reason: "1 old file(s) still open" });
  } finally { holder.kill(); }
}, 60_000);

test("stale version dirs: keep the symlinked current and the newest, propose the rest; apply removes only approved", async () => {
  const s = sandbox();
  const releases = join(s.dir, "releases");
  for (const v of ["1.0", "1.1", "1.2", "1.3"]) mkdirSync(join(releases, v), { recursive: true });
  old(join(releases, "1.0"), 50); old(join(releases, "1.1"), 40); old(join(releases, "1.2"), 30);
  symlinkSync(join(releases, "1.1"), join(s.dir, "current"));
  s.tool("du", `echo "100	$2"`);
  setPolicy(s, { staleDirs: [{ id: "rel", parent: releases, keep: { symlink: join(s.dir, "current") }, keepNewest: 1, tier: "approve" }] });
  const p = JSON.parse((await s.run(["scan"])).stdout);
  const paths = p.items.filter((i: any) => i.kind === "stale_dir").map((i: any) => i.path.split("/").at(-1)).sort();
  expect(paths).toEqual(["1.0", "1.2"]);
  await s.run(["apply", p.id]);
  expect(["1.0", "1.1", "1.2", "1.3"].map((v) => existsSync(join(releases, v)))).toEqual([false, true, false, true]);
}, 60_000);

test("keep.cmd that cannot tell the current version keeps everything", async () => {
  const s = sandbox();
  const store = join(s.dir, "store");
  ["v3", "v10", "v11"].forEach((v) => mkdirSync(join(store, v), { recursive: true }));
  s.tool("pnpm", "exit 1");
  setPolicy(s, { staleDirs: [{ id: "pnpm", parent: store, keep: { cmd: ["pnpm", "store", "path"] }, tier: "approve" }] });
  let p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items.filter((i: any) => i.kind === "stale_dir")).toEqual([]);

  s.tool("pnpm", `echo "${store}/v11"`);
  p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items.filter((i: any) => i.kind === "stale_dir").map((i: any) => i.path.split("/").at(-1)).sort()).toEqual(["v10", "v3"]);
}, 60_000);
