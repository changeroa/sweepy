import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./helpers";

const repoPolicy = JSON.parse(readFileSync(join(import.meta.dir, "..", "policy.json"), "utf8"));
const dockerCleaner = repoPolicy.cleaners.find((c: any) => c.id === "docker");

function withFakeDocker(colimaUp: boolean) {
  const s = sandbox();
  const calls = join(s.dir, "calls");
  s.tool("colima", `echo "colima $*" >> "${calls}"; [ "$1" = status ] && exit ${colimaUp ? 0 : 1}; exit 0`);
  // Images line, empty lines for other types, Build Cache line, as docker system df --format prints them.
  s.tool("docker", `echo "docker $*" >> "${calls}"; case "$1 $2" in "system df") printf '573.2MB (20%%)\\n\\n\\n1.44GB\\n';; esac`);
  const policy = JSON.parse(readFileSync(s.policyPath, "utf8"));
  writeFileSync(s.policyPath, JSON.stringify({ ...policy, cleaners: [dockerCleaner] }));
  const log = () => { try { return readFileSync(calls, "utf8").trim().split("\n"); } catch { return []; } };
  return { s, log };
}

test("docker cleaner is approve-tier and sizes from docker system df reclaimable (SI units)", async () => {
  const { s } = withFakeDocker(true);
  const p = JSON.parse((await s.run(["scan"])).stdout);
  expect(p.items.find((i: any) => i.path === "docker")).toMatchObject({ tier: "approve", bytes: 573_200_000 + 1_440_000_000 });
}, 30_000);

test("colima down excludes docker; check never runs approve-tier prunes", async () => {
  const down = withFakeDocker(false);
  const p = JSON.parse((await down.s.run(["scan"])).stdout);
  expect(p.excluded).toContainEqual({ kind: "cleaner", path: "docker", reason: "colima status failed" });

  const up = withFakeDocker(true);
  await up.s.run(["check"]);
  expect(up.log().filter((l) => l.includes("prune") || l.includes("fstrim"))).toEqual([]);
}, 60_000);

test("approved apply runs builder prune, dangling image prune, then fstrim in order", async () => {
  const { s, log } = withFakeDocker(true);
  const p = JSON.parse((await s.run(["scan"])).stdout);
  const r = JSON.parse((await s.run(["apply", p.id])).stdout);
  expect(r.failures).toEqual([]);
  expect(log().filter((l) => /prune|fstrim/.test(l))).toEqual([
    "docker builder prune -f", "docker image prune -f", "colima ssh -- sudo fstrim -av",
  ]);
}, 60_000);
