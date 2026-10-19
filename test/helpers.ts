import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SWEEPY = join(import.meta.dir, "..", "bin", "sweepy");

// A throwaway sandbox: state dir, policy, and a bin/ dir prepended to PATH for fake tools.
export function sandbox(policy: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sweepy-test-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const root = join(dir, "root");
  [bin, state, root].forEach((d) => mkdirSync(d, { recursive: true }));
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify({
    roots: [root], protect: [], artifacts: { kinds: ["node_modules"], ecosystems: ["node"], staleDays: 14 },
    worktrees: { idleDays: 7 }, auto: { enabled: false }, inbox: { minBytes: 1 }, proposalTtlHours: 24, ...policy,
  }));
  const tool = (name: string, script: string) => {
    const p = join(bin, name);
    writeFileSync(p, "#!/bin/sh\n" + script + "\n");
    chmodSync(p, 0o755);
    return p;
  };
  // Default fake void: healthy disk, empty scan.
  const voidBin = tool("void", `case "$*" in *guard*) echo '{"state":"ok","free_bytes":1000,"free_percent":50}';; *scan*) echo '[]';; esac`);
  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, SWEEPY, ...args], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, SWEEPY_STATE_DIR: state, SWEEPY_POLICY: policyPath, SWEEPY_VOID: voidBin, ...extraEnv },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  };
  return { dir, bin, state, root, policyPath, tool, run };
}
