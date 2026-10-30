import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

export type MediaPolicy = {
  readonly enabled?: boolean; readonly roots?: string[]; readonly scratchRoots?: string[];
  readonly uploadResults?: string[]; readonly staleDays?: number; readonly minBytes?: number;
  readonly originalMinBytes?: number;
};
type Entry = { readonly path: string; readonly directory: boolean; readonly mtime: number; readonly size: number; readonly symlink?: boolean };
type Text = { readonly path: string; readonly text: string };
export type MediaItem = { readonly kind: "media"; readonly tier: "approve"; readonly path: string; readonly bytes: number; readonly reason: string };
type Excluded = { readonly kind: "media"; readonly path: string; readonly reason: string };
type Context = {
  readonly policy: MediaPolicy; readonly protect: string[]; readonly includeOriginals: boolean;
  readonly measure: (path: string) => { bytes: number | null; timedOut: boolean };
  readonly gitFiles: (root: string) => { code: number; out: string };
};
const DAY = 86_400_000;
const extensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4a", ".mp3", ".wav", ".png"]);
const skip = new Set([".git", "node_modules", ".venv", "target", ".next"]);
const under = (p: string, base: string) => p === base || p.startsWith(base + "/");
const expand = (p: string) => p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
const series = (p: string) => basename(p).match(/^(.*?)[-_]v(\d+)(?:[-_].*)?$/i);
const mediaFile = (p: string) => extensions.has(extname(p).toLowerCase());
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!record(value)) return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
function paths(patterns: string[]): string[] {
  return [...new Set(patterns.flatMap((p) => {
    const pattern = expand(p);
    return /[*?{[]/.test(pattern) ? [...new Bun.Glob(pattern).scanSync({ onlyFiles: false, followSymlinks: false })] : [pattern];
  }).filter(existsSync).map((p) => realpathSync(p)))];
}
// Filesystem failures and bounded inventory/reference scans fail closed for that root.
function inventory(root: string): Entry[] {
  const out: Entry[] = [];
  const deadline = Date.now() + 15_000;
  const walk = (p: string) => {
    if (out.length >= 100_000 || Date.now() > deadline) throw new Error(`media inventory limit: ${root}`);
    const st = lstatSync(p);
    if (!st.isDirectory() && !st.isFile() && !st.isSymbolicLink()) throw new Error(`media special file requires manual review: ${p}`);
    out.push({ path: p, directory: st.isDirectory(), mtime: st.mtimeMs, size: st.size, symlink: st.isSymbolicLink() });
    if (st.isDirectory()) for (const e of readdirSync(p)) if (!skip.has(e)) walk(join(p, e));
  };
  walk(root);
  return out;
}
function texts(entries: Entry[]): Text[] {
  const out: Text[] = [];
  const deadline = Date.now() + 15_000;
  let bytes = 0;
  for (const e of entries) {
    if (Date.now() > deadline) throw new Error("media reference scan deadline exceeded");
    if (e.directory || e.symlink || mediaFile(e.path)) continue;
    const fd = openSync(e.path, "r");
    const sample = Buffer.alloc(Math.min(e.size, 4096));
    try { readSync(fd, sample, 0, sample.length, 0); }
    finally { closeSync(fd); }
    if (sample.includes(0)) continue;
    if (e.size > 16 * 1024 * 1024) throw new Error(`media reference file too large: ${e.path}`);
    bytes += e.size;
    if (bytes > 128 * 1024 * 1024) throw new Error("media reference corpus exceeds 128 MiB");
    const buf = readFileSync(e.path);
    if (!buf.includes(0)) out.push({ path: e.path, text: buf.toString("utf8") });
  }
  return out;
}
function json(text: Text): unknown {
  try { return JSON.parse(text.text); }
  catch (e) { throw new Error(`media metadata unreadable: ${text.path}`, { cause: e }); }
}
function repoFor(root: string): string {
  let p = root;
  while (p !== "/") {
    if (existsSync(join(p, ".git"))) return p;
    p = dirname(p);
  }
  return root;
}
function reference(path: string, corpus: Text[], scope: string): string | undefined {
  const rel = relative(scope, path);
  const parts = rel.split("/");
  const needles = [path, ...parts.map((_, i) => parts.slice(i).join("/"))].filter((n) => n.length > 3 && (n.includes("/") || !!series(path)));
  return corpus.find((t) => !under(t.path, path) && needles.some((n) => {
    let at = t.text.indexOf(n);
    while (at >= 0) {
      const before = t.text[at - 1] ?? "", after = t.text[at + n.length] ?? "";
      if (!/[\w.@-]/.test(before) && !/[\w.@-]/.test(after)) return true;
      at = t.text.indexOf(n, at + 1);
    }
    return false;
  }))?.path;
}
// A directory name alone does not establish regenerability: website captures
// also use frames/. Require a rendered video and its edit metadata together.
function renderFolders(entries: Entry[]): Set<string> {
  const videos = new Set(entries.filter((e) => !e.directory && /\.(mp4|mov)$/i.test(e.path)).map((e) => dirname(e.path)));
  return new Set(entries.filter((e) => !e.directory && /^(?:timeline\.json|(?:.*\.)?edit\.json)$/i.test(basename(e.path)))
    .map((e) => dirname(e.path)).filter((p) => videos.has(p)));
}

export function scanMedia(ctx: Context) {
  const items: MediaItem[] = [], excluded: Excluded[] = [], errors: string[] = [];
  if (ctx.policy.enabled === false) return { items, excluded, errors, totalBytes: 0 };
  const roots = paths(ctx.policy.roots ?? ["~/projects/*/poc", "~/projects/*/out", "~/projects/*/renders", "~/projects/*/exports"]);
  const scratch = paths(ctx.policy.scratchRoots ?? ["~/.dori/state/downloads", "~/.dori/state/research", "/tmp"]);
  const uploads: string[] = [];
  const uploadPath = (p: string) => existsSync(expand(p)) ? realpathSync(expand(p)) : expand(p);
  try {
    for (const p of paths(ctx.policy.uploadResults ?? ["~/.dori/state/lane-results/*upload*.json"])) {
      for (const obj of objects(json({ path: p, text: readFileSync(p, "utf8") }))) {
        for (const key of ["sourceVideoPath", "video", "sourcePath", ...(obj.videoId ? ["path"] : [])]) if (typeof obj[key] === "string") uploads.push(uploadPath(obj[key]));
        if (typeof obj.manifest === "string" && existsSync(expand(obj.manifest))) {
          for (const m of objects(json({ path: obj.manifest, text: readFileSync(expand(obj.manifest), "utf8") })))
            for (const key of ["sourceVideoPath", "video", "sourcePath"]) if (typeof m[key] === "string") uploads.push(uploadPath(m[key]));
        }
      }
    }
  } catch (e) {
    errors.push(String(e));
    return { items, excluded, errors, totalBytes: 0 };
  }
  const corpora = new Map<string, { entries: Entry[]; corpus: Text[]; tracked: string[] }>();
  const now = Date.now();
  for (const root of [...new Set([...roots, ...scratch])]) {
    try {
      // /tmp is intentionally shallow: never crawl unrelated processes' private trees.
      const isScratch = scratch.includes(root) && !roots.includes(root);
      const entries = isScratch && root === realpathSync("/tmp")
        ? readdirSync(root).map((n) => join(root, n)).filter((p) => lstatSync(p).isFile() && !lstatSync(p).isSymbolicLink())
          .map((path) => { const st = lstatSync(path); return { path, directory: false, mtime: st.mtimeMs, size: st.size }; })
        : inventory(root);
      const scope = repoFor(root);
      let data = corpora.get(scope);
      if (!data) {
        const all = scope === root ? entries : inventory(scope);
        const tracked = existsSync(join(scope, ".git")) ? ctx.gitFiles(scope) : { code: 0, out: "" };
        if (tracked.code !== 0) throw new Error(`media git tracking check failed: ${scope}`);
        data = { entries: all, corpus: texts(all), tracked: tracked.out.split("\0").filter(Boolean).map((p) => join(scope, p)) };
        corpora.set(scope, data);
      }
      const versions = data.entries.filter((e) => e.directory && series(e.path));
      const latest = versions.filter((e) => {
        const m = series(e.path);
        return m && !versions.some((v) => {
          const n = series(v.path);
          return n && dirname(v.path) === dirname(e.path) && n[1] === m[1] && Number(n[2]) > Number(m[2]);
        });
      }).map((e) => e.path);
      const originals = data.corpus.filter((t) => /(?:source|proxy)-manifest\.json$/.test(t.path)).flatMap((t) => objects(json(t)))
        .filter((o) => typeof o.driveId === "string" && typeof o.originalFilename === "string");
      const rendered = renderFolders(data.entries);
      const candidates = entries.filter((e) => {
        if (isScratch) return !e.directory && mediaFile(e.path);
        if (e.directory) return (!!series(e.path) || /^(frames|phone-frames|proxies)$/.test(basename(e.path)))
          && entries.some((child) => !child.directory && under(child.path, e.path) && mediaFile(child.path));
        return mediaFile(e.path) && (/\.(wav|webm)$/i.test(e.path) || /proxy/i.test(basename(e.path)) || originals.some((o) => o.originalFilename === basename(e.path)));
      }).sort((a, b) => a.path.length - b.path.length);
      for (const entry of candidates) {
        const p = entry.path;
        if (items.some((i) => under(p, i.path))) continue;
        const descendants = entry.directory ? entries.filter((e) => under(e.path, p)) : [entry];
        const namedOriginal = originals.find((o) => o.originalFilename === basename(p));
        const original = originals.find((o) => o.originalFilename === basename(p) && (o.bytes === entry.size || o.remoteBytes === entry.size));
        const marker = descendants.map((e) => e.path.match(/^(.*?\/(?:final|delivery|uploaded|latest))(?:\/|$)/i)?.[1]).find(Boolean);
        let reason: string | undefined;
        if (ctx.protect.some((b) => under(p, b) || under(b, p))) reason = "protected path";
        else if (marker) reason = `${under(p, marker) ? "inside" : "contains"} ${basename(marker)}/: ${marker}`;
        else if (uploads.some((u) => under(u, p) || under(p, u))) reason = "uploaded source path";
        else if (latest.some((l) => under(p, l) || under(l, p))) reason = "latest series version";
        else if (descendants.some((e) => e.symlink)) reason = "symlink requires manual review";
        else if (descendants.some((e) => e.mtime > now - DAY)) reason = "modified in last 24h";
        else if (data.tracked.some((t) => under(t, p) || under(p, t))) reason = "git-tracked media";
        else if (descendants.some((e) => e.directory && readdirSync(e.path).some((n) => skip.has(n)))) reason = "unscanned protected subtree";
        else if (entry.directory && originals.some((o) => descendants.some((e) => basename(e.path) === o.originalFilename))) reason = "contains camera originals";
        else {
          const ref = reference(p, [...corpora.values()].flatMap((d) => d.corpus), scope);
          if (ref) reason = `referenced_by ${ref}`;
        }
        if (!reason && entry.directory && /^(frames|phone-frames)$/.test(basename(p))
          && !rendered.has(dirname(p)) && !rendered.has(dirname(dirname(p))))
          reason = "not a verified video render: frames may be source captures (requires rendered mp4/mov and timeline.json or *.edit.json)";
        if (!reason && entry.directory && series(p) && ![...rendered].some((d) => under(d, p)))
          reason = "not a verified video render: requires rendered mp4/mov and timeline.json or *.edit.json";
        if (!reason && namedOriginal && !original) reason = "original manifest size mismatch";
        if (!reason && original && !ctx.includeOriginals) reason = "originals off by default (--include-originals)";
        if (!reason && isScratch && entry.mtime > now - Math.max(1, ctx.policy.staleDays ?? 3) * DAY) reason = `scratch younger than ${Math.max(1, ctx.policy.staleDays ?? 3)}d`;
        if (reason) { excluded.push({ kind: "media", path: p, reason }); continue; }
        const measured = ctx.measure(p);
        if (measured.bytes === null) { excluded.push({ kind: "media", path: p, reason: measured.timedOut ? "media size timed out" : "media size unavailable" }); continue; }
        if (measured.bytes < (ctx.policy.minBytes ?? 1024 * 1024)) continue;
        if (original && entry.size < (ctx.policy.originalMinBytes ?? 100 * 1024 * 1024)) continue;
        const why = original ? `re-downloadable original; remote ID ${original.driveId}; needed for future edits`
          : isScratch ? `stale scratch older than ${Math.max(1, ctx.policy.staleDays ?? 3)}d`
          : series(p) ? "superseded render version; newer sibling exists" : "regenerable media intermediate";
        for (let i = items.length - 1; i >= 0; i--) if (under(items[i]?.path ?? "", p)) items.splice(i, 1);
        items.push({ kind: "media", tier: "approve", path: p, bytes: measured.bytes, reason: why });
      }
    } catch (e) {
      // Discard any partial proposals from an incompletely inspected tree.
      for (let i = items.length - 1; i >= 0; i--) if (under(items[i]?.path ?? "", root)) items.splice(i, 1);
      excluded.push({ kind: "media", path: root, reason: String(e) });
      errors.push(String(e));
    }
  }
  return { items, excluded, errors, totalBytes: items.reduce((n, i) => n + i.bytes, 0) };
}
