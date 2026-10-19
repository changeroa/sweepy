import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

const DAY = 86_400_000;
const setPolicy = (s: ReturnType<typeof sandbox>, extra: object) =>
  writeFileSync(s.policyPath, JSON.stringify({ ...JSON.parse(readFileSync(s.policyPath, "utf8")), ...extra }));
const staleDirs = (p: any) => p.items.filter((i: any) => i.kind === "stale_dir").map((i: any) => i.path.split("/").at(-1)).sort();

test("models not accessed for 60 days are proposed; recently read ones are not", async () => {
  const s = sandbox();
  const hub = join(realpathSync(s.dir), "hub");
  for (const m of ["models--a--old", "models--b--used", "blobs"]) { mkdirSync(join(hub, m), { recursive: true }); writeFileSync(join(hub, m, "w.bin"), "x"); }
  const old = new Date(Date.now() - 90 * DAY);
  for (const m of ["models--a--old", "models--b--used", "blobs"]) utimesSync(join(hub, m, "w.bin"), old, old);
  utimesSync(join(hub, "models--b--used", "w.bin"), new Date(), old); // read yesterday: atime fresh, mtime old
  s.tool("du", 'echo "1	$2"');
  setPolicy(s, { staleDirs: [{ id: "hf", parent: hub, match: "^models--", lastAccessDays: 60, tier: "approve" }] });
  expect(staleDirs(JSON.parse((await s.run(["scan"])).stdout))).toEqual(["models--a--old"]);
}, 30_000);

test("an app cache is proposed only while the app is not running", async () => {
  const s = sandbox();
  const caches = join(realpathSync(s.dir), "Caches");
  ["Aside", "Other"].forEach((d) => mkdirSync(join(caches, d), { recursive: true }));
  s.tool("du", 'echo "1	$2"');
  setPolicy(s, { staleDirs: [{ id: "aside", parent: caches, match: "^Aside$", unlessRunning: "Aside", tier: "approve" }] });
  s.tool("pgrep", "exit 1");
  expect(staleDirs(JSON.parse((await s.run(["scan"])).stdout))).toEqual(["Aside"]);
  s.tool("pgrep", '[ "$2" = Aside ] && exit 0; exit 1');
  expect(staleDirs(JSON.parse((await s.run(["scan"])).stdout))).toEqual([]);
}, 30_000);

test("old brew kegs: every formula keeps its linked version", async () => {
  const s = sandbox();
  const prefix = realpathSync(s.dir);
  const cellar = join(prefix, "Cellar"), opt = join(prefix, "opt");
  mkdirSync(opt);
  for (const v of ["1.0", "2.0"]) mkdirSync(join(cellar, "tailscale", v), { recursive: true });
  mkdirSync(join(cellar, "jq", "1.7"), { recursive: true });
  symlinkSync(join(cellar, "tailscale", "2.0"), join(opt, "tailscale"));
  symlinkSync(join(cellar, "jq", "1.7"), join(opt, "jq"));
  s.tool("du", 'echo "1	$2"');
  setPolicy(s, { staleDirs: [{ id: "kegs", parent: cellar + "/*", keep: { symlink: opt + "/{name}" }, tier: "approve" }] });
  const p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items.filter((i: any) => i.kind === "stale_dir").map((i: any) => i.path)).toEqual([join(cellar, "tailscale", "1.0")]);
}, 30_000);

test("brew duplicates: older versioned formula without dependents is proposed, approve only", async () => {
  const s = sandbox();
  const calls = join(s.dir, "brew-calls");
  s.tool("brew", `echo "$*" >> "${calls}"; case "$*" in
    "list --formula") printf 'node@22\\nnode@24\\npython@3.13\\npython@3.14\\njq\\n';;
    "--cellar") echo /nonexistent;;
    "--prefix") echo /nonexistent;;
    leaves) printf 'node@22\npython@3.13\njq\n';;
    "uses --installed --recursive python@3.13") echo some-tool;;
    "uses --installed"*) ;;
  esac`);
  s.tool("du", 'echo "1	$2"');
  const home = join(s.dir, "home"); mkdirSync(home);
  setPolicy(s, { brewDuplicates: { tier: "auto" } });
  const off = JSON.parse((await s.run(["scan"], { HOME: home })).stdout);
  expect(off.items.filter((i: any) => i.kind === "brew_dup")).toEqual([]);
  expect(off.excluded).toContainEqual({ kind: "brew_dup", path: "node@22", reason: "versioned formula (brew.allowVersionedRemoval is off)" });
  setPolicy(s, { brewDuplicates: { tier: "auto" }, brew: { allowVersionedRemoval: true } });
  const p = JSON.parse((await s.run(["scan"], { HOME: home })).stdout);
  expect(p.items.filter((i: any) => i.kind === "brew_dup").map((i: any) => [i.path, i.tier])).toEqual([["node@22", "approve"]]);
  expect(p.excluded).toContainEqual({ kind: "brew_dup", path: "python@3.13", reason: "needed by some-tool" });
  const r = JSON.parse((await s.run(["apply", p.id], { HOME: home })).stdout);
  expect(r.measurements.map((m: any) => m.source)).toEqual(["brew_dup"]);
  expect(readFileSync(calls, "utf8")).toContain("uninstall node@22");
}, 30_000);

test("brew duplicates referenced by a launchd plist are excluded even when versioned removal is allowed", async () => {
  const s = sandbox();
  s.tool("brew", `case "$*" in
    "list --formula") printf 'node@24\\nnode@25\\npython@3.13\\npython@3.14\\n';;
    "--cellar") echo /opt/homebrew/Cellar;;
    "--prefix") echo /opt/homebrew;;
    leaves) printf 'node@24\\nnode@25\\npython@3.13\\npython@3.14\\n';;
  esac`);
  s.tool("du", 'echo "1	$2"');
  const home = join(s.dir, "home"), agents = join(home, "Library/LaunchAgents"), extra = join(s.dir, "scripts");
  mkdirSync(agents, { recursive: true }); mkdirSync(extra);
  writeFileSync(join(agents, "com.example.bridge.plist"), "<plist><array><string>/opt/homebrew/opt/node@24/bin/node</string></array></plist>");
  writeFileSync(join(extra, "run"), "#!/bin/sh\nexec /opt/homebrew/opt/python@3.13/bin/python3.13 job.py\n");
  setPolicy(s, { brewDuplicates: { tier: "approve" }, brew: { allowVersionedRemoval: true }, referenceRoots: [extra] });
  const p = JSON.parse((await s.run(["scan"], { HOME: home })).stdout);
  expect(p.items.filter((i: any) => i.kind === "brew_dup")).toEqual([]);
  const reasons = Object.fromEntries(p.excluded.filter((e: any) => e.kind === "brew_dup").map((e: any) => [e.path, e.reason]));
  expect(reasons["node@24"]).toBe(`referenced_by ${realpathSync(agents)}/com.example.bridge.plist`);
  expect(reasons["python@3.13"]).toBe(`referenced_by ${realpathSync(extra)}/run`);
}, 30_000);

test("status shows per-source estimate accuracy and flags median ratio under 0.5", async () => {
  const s = sandbox();
  const h = (o: object) => appendFileSync(join(s.state, "history.jsonl"), JSON.stringify(o) + "\n");
  h({ mode: "applied", measurements: [{ source: "uv", estimated: 1000, measured: 100 }, { source: "codex-releases", estimated: 1000, measured: 900 }] });
  h({ mode: "applied", measurements: [{ source: "uv", estimated: 1000, measured: 300 }] });
  h({ mode: "applied", cleaners: [{ cleaner: "uv", estimated: 1000, measured: 200 }] }); // older history shape
  const st = JSON.parse((await s.run(["status"])).stdout);
  expect(st.accuracy.uv).toMatchObject({ runs: 3, medianRatio: 0.2, estimateOff: true });
  expect(st.accuracy["codex-releases"]).toMatchObject({ runs: 1, medianRatio: 0.9, estimateOff: false });
}, 30_000);
