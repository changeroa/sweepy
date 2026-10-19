import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

// A fake "uv": cache dir is a temp dir measured by a fake du; prune drops a marker so we can see whether it ran.
function withFakeUv(opts: { shadow: boolean; autoEnabled: boolean }) {
  const s = sandbox({ auto: { enabled: opts.autoEnabled } });
  const cache = join(s.dir, "uv-cache");
  mkdirSync(cache);
  const marker = join(s.dir, "pruned");
  s.tool("uv", `case "$*" in --version) echo uv 0.0;; "cache dir") echo "${cache}";; "cache prune") touch "${marker}";; esac`);
  s.tool("du", `echo "1024	$2"`);
  const policy = JSON.parse(readFileSync(s.policyPath, "utf8"));
  policy.cleaners = [{ id: "uv", tier: "auto", shadow: opts.shadow, detect: ["uv", "--version"], size: { duOf: ["uv", "cache", "dir"] }, apply: ["uv", "cache", "prune"] }];
  writeFileSync(s.policyPath, JSON.stringify(policy));
  const history = () => readFileSync(join(s.state, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { s, marker, history };
}

test("scan proposes a cleaner with the tool-derived size", async () => {
  const { s } = withFakeUv({ shadow: true, autoEnabled: false });
  const p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items).toContainEqual(expect.objectContaining({ kind: "cleaner", path: "uv", tier: "auto", bytes: 1024 * 1024, shadow: true }));
}, 30_000);

test("shadow cleaner is only recorded even when auto is enabled", async () => {
  const { s, marker, history } = withFakeUv({ shadow: true, autoEnabled: true });
  await s.run(["check"]);
  expect(existsSync(marker)).toBe(false);
  expect(history()).toContainEqual(expect.objectContaining({ mode: "shadow", detail: [{ kind: "cleaner", path: "uv", bytes: 1024 * 1024 }] }));
}, 30_000);

test("non-shadow auto cleaner runs its prune and records estimate vs measured", async () => {
  const { s, marker, history } = withFakeUv({ shadow: false, autoEnabled: true });
  await s.run(["check"]);
  expect(existsSync(marker)).toBe(true);
  const applied = history().find((h) => h.mode === "applied");
  expect(applied.cleaners).toEqual([{ cleaner: "uv", estimated: 1024 * 1024, measured: expect.any(Number) }]);
}, 30_000);

test("missing tool is excluded, and dry-run never runs apply", async () => {
  const { s, marker } = withFakeUv({ shadow: true, autoEnabled: false });
  const policy = JSON.parse(readFileSync(s.policyPath, "utf8"));
  policy.cleaners.push({ id: "ghost", tier: "auto", detect: ["definitely-not-a-tool-xyz"], size: { du: ["/nonexistent"] }, apply: ["false"] });
  writeFileSync(s.policyPath, JSON.stringify(policy));
  const p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.excluded).toContainEqual({ kind: "cleaner", path: "ghost", reason: "tool not installed" });
  const dry = JSON.parse((await s.run(["dry-run"])).stdout);
  expect(dry.map((d: any) => [d.id, d.installed])).toEqual([["uv", true], ["ghost", false]]);
  expect(existsSync(marker)).toBe(false);
}, 30_000);

test("brew-style human size is parsed from the dry-run output", async () => {
  const s = sandbox();
  s.tool("brew", `case "$*" in --version) echo Homebrew 4;; *) echo "==> This operation would free approximately 1.5GB of disk space.";; esac`);
  const policy = JSON.parse(readFileSync(s.policyPath, "utf8"));
  policy.cleaners = [{ id: "brew", tier: "auto", shadow: true, detect: ["brew", "--version"], size: { cmd: ["brew", "cleanup", "-n"], pattern: "free approximately ([\\d.]+\\s*[KMGT]?B)" }, apply: ["false"] }];
  writeFileSync(s.policyPath, JSON.stringify(policy));
  const p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items.find((i: any) => i.path === "brew").bytes).toBe(Math.round(1.5 * 1024 ** 3));
}, 30_000);
