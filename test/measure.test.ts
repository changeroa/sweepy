import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

const withReport = (policyPath: string, report: object) =>
  writeFileSync(policyPath, JSON.stringify({ ...JSON.parse(readFileSync(policyPath, "utf8")), report }));

test("report lists targets biggest first with coverage", async () => {
  const s = sandbox();
  const outside = join(s.dir, "outside");
  mkdirSync(outside);
  mkdirSync(join(s.root, "small"));
  mkdirSync(join(s.root, "big"));
  s.tool("du", `case "$2" in *big) echo "4096	$2";; *small) echo "8	$2";; *) echo "1024	$2";; esac`);
  withReport(s.policyPath, { paths: [outside], childrenOf: [s.root] });
  const r = await s.run(["report", "--json"]);
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout).rows;
  expect(rows.map((x: any) => [x.path.split("/").at(-1), x.bytes, x.coverage])).toEqual([
    ["big", 4096 * 1024, "roots"], ["outside", 1024 * 1024, "outside"], ["small", 8 * 1024, "roots"],
  ]);
  const md = await s.run(["report"]);
  expect(md.stdout).toContain("| path | GB | modified | sweepy |");
});

test("du result is cached until the directory mtime changes", async () => {
  const s = sandbox();
  const target = join(s.root, "proj");
  mkdirSync(target);
  const counter = join(s.dir, "du-calls");
  s.tool("du", `echo x >> "${counter}"; echo "2048	$2"`);
  withReport(s.policyPath, { paths: [target] });
  const calls = () => readFileSync(counter, "utf8").trim().split("\n").length;
  const row = async () => JSON.parse((await s.run(["report", "--json"])).stdout).rows[0];

  const first = await row();
  const second = await row();
  expect([first.cached, second.cached, second.bytes, calls()]).toEqual([false, true, 2048 * 1024, 1]);

  utimesSync(target, new Date(), new Date(Date.now() + 5000));
  const third = await row();
  expect([third.cached, calls()]).toEqual([false, 2]);
});

test("du that hangs is killed at the deadline and not cached", async () => {
  const s = sandbox();
  const target = join(s.root, "huge");
  mkdirSync(target);
  s.tool("du", "exec sleep 30");
  withReport(s.policyPath, { paths: [target] });
  const started = Date.now();
  const r = await s.run(["report", "--json"], { SWEEPY_DU_TIMEOUT: "1" });
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(JSON.parse(r.stdout).rows[0]).toMatchObject({ bytes: null, timedOut: true });
  expect(readdirSync(s.state)).not.toContain("du-cache.json");
}, 20_000);

test("credentials in remote URLs are masked in output, proposals and logs", async () => {
  const s = sandbox();
  const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
  s.tool("void", `case "$*" in *guard*) echo '{"state":"ok","free_bytes":1000,"free_percent":50}';; *scan*) echo "fatal: unable to access 'https://bot:${secret}@github.com/o/r.git/'" >&2; exit 1;; esac`);
  const r = await s.run(["check"]);
  const proposals = readdirSync(join(s.state, "proposals")).map((f) => readFileSync(join(s.state, "proposals", f), "utf8")).join("");
  const log = readFileSync(join(s.state, "sweepy.log"), "utf8");
  for (const text of [r.stdout, r.stderr, proposals, log]) expect(text).not.toContain(secret);
  expect(log).toContain("https://***@github.com/o/r.git");
}, 60_000);
