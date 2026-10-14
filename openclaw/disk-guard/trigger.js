// A failed or unparseable check also fires, so the watcher never goes quiet while broken.
const prev = trigger.state ?? {};
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const res = await exec({ command: "/Users/iyen/.local/bin/void --json guard check" });
const out = String(res?.aggregated ?? "");
let g = null;
try { g = JSON.parse(out.slice(out.indexOf("{"))); } catch {}
const state = g?.state ?? "error";
if (state === "ok") return { fire: false, state: { last: "ok", firedAt: prev.firedAt ?? 0 } };
const due = state !== prev.last || now - (prev.firedAt ?? 0) >= DAY;
if (!due) return { fire: false, state: prev };
const detail = g ? `${g.state}: ${g.message} (free_percent=${Number(g.free_percent).toFixed(1)})`
                 : `void guard check failed: ${out.slice(0, 300)}`;
return { fire: true, message: `[disk-guard] ${detail}`, state: { last: state, firedAt: now } };
