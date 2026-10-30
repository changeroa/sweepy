import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sandbox } from "./helpers";

const DAY = 86_400_000;
const OLD = new Date("2000-01-01T00:00:00Z");
const SIZE = 128;
const sandboxes: string[] = [];

type MediaEntry = {
  readonly kind: string;
  readonly path: string;
  readonly reason: string;
  readonly tier?: string;
  readonly bytes?: number;
};
type Discovery = {
  readonly items: readonly MediaEntry[];
  readonly excluded: readonly MediaEntry[];
  readonly errors: readonly string[];
};
type Proposal = Discovery & { readonly id: string };
type DryRun = Discovery & { readonly totalBytes: number };

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world(options: { enabled?: boolean; staleDays?: number; globs?: boolean; overlap?: boolean; auto?: boolean } = {}) {
  const s = sandbox();
  sandboxes.push(s.dir);
  const base = realpathSync(s.dir);
  const root = join(base, "media");
  const scratch = join(base, "scratch");
  const uploads = join(base, "upload-results.json");
  mkdirSync(root);
  mkdirSync(scratch);
  writeFileSync(uploads, "{}");
  const media = {
    roots: options.globs ? [join(base, "med*")] : [root],
    scratchRoots: options.overlap ? [root, scratch, join(base, "scr*")] : options.globs ? [join(base, "scr*")] : [scratch],
    uploadResults: options.globs ? [join(base, "upload-*.json")] : [uploads],
    staleDays: options.staleDays ?? 3,
    minBytes: 1,
    originalMinBytes: 1,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  };
  const policy = JSON.parse(readFileSync(s.policyPath, "utf8"));
  writeFileSync(s.policyPath, JSON.stringify({ ...policy, media, auto: { enabled: options.auto ?? false } }));
  s.tool("lsof", "exit 0");
  s.tool("du", 'for p do :; done; printf "8\\t%s\\n" "$p"');

  // Age every newly created ancestor too: tests must not accidentally protect
  // an old render because mkdir left a recent nested directory behind.
  const file = (path: string, content: string | Buffer = Buffer.alloc(SIZE)) => {
    if (!path.startsWith(base + "/")) throw new Error("fixture path must stay inside the canonical sandbox");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    let current = path;
    while (current !== base) {
      utimesSync(current, OLD, OLD);
      current = dirname(current);
    }
    return path;
  };
  const render = (name: string, leaf = "render.mp4") => {
    const path = join(root, "out", name);
    file(join(path, leaf));
    if (leaf !== "render.mp4") file(join(path, "render.mp4"));
    file(join(path, "timeline.json"), JSON.stringify({ segments: [] }));
    return path;
  };
  const run = async <T>(args: string[]): Promise<T> => {
    const result = await s.run(args);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    return JSON.parse(result.stdout);
  };
  return { s, root, scratch, uploads, file, render, run };
}

const mediaItems = (result: Discovery) => result.items.filter((item) => item.kind === "media");
const paths = (result: Discovery) => mediaItems(result).map((item) => item.path).sort();
const under = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);

function expectProtected(result: Discovery, path: string) {
  // An eligible descendant must never bypass protection of its container.
  expect(mediaItems(result).filter((item) => under(item.path, path) || under(path, item.path))).toEqual([]);
  expect(result.excluded).toContainEqual(expect.objectContaining({ kind: "media", path, reason: expect.any(String) }));
}

test("scan groups numeric render versions by stem and omits every latest directory", async () => {
  // Given two independent series, including a suffix on the latest version.
  const w = world();
  const trust = [1, 2, 3].map((v) => w.render(`trust-v${v}`));
  const bio = ["10", "11", "12-hook"].map((v) => w.render(`biotokens-v${v}`));

  // When scanning the CLI.
  const result = await w.run<Proposal>(["scan"]);

  // Then only older directories, never their individual children, are proposed.
  expect(paths(result)).toEqual([trust[0], trust[1], bio[0], bio[1]].sort());
  expect(result.errors).toEqual([]);
  for (const item of mediaItems(result)) {
    expect(item.bytes).toBeGreaterThan(0);
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item).toMatchObject({ kind: "media", tier: "approve" });
  }
  for (const latest of [trust[2], bio[2]]) {
    if (latest) expectProtected(result, latest);
  }
}, 30_000);

test("scan orders render versions numerically rather than lexicographically", async () => {
  // Given a series crossing a decimal digit boundary.
  const w = world();
  const v2 = w.render("trust-v2");
  const v9 = w.render("trust-v9");
  const latest = w.render("trust-v10");

  // When scanning.
  const result = await w.run<Proposal>(["scan"]);

  // Then v10 is latest, not v9.
  expect(paths(result)).toEqual([v2, v9].sort());
  expectProtected(result, latest);
}, 30_000);

test("dry-run media expands configured globs and reports exact proposed byte totals without deleting", async () => {
  // Given globbed media and scratch roots.
  const w = world({ globs: true });
  const older = w.render("trust-v1");
  const latest = w.render("trust-v2");
  const scratch = w.file(join(w.scratch, "clip.mov"));

  // When requesting only the media dry-run.
  const result = await w.run<DryRun>(["dry-run", "media"]);

  // Then it returns the media object contract and leaves all fixture files intact.
  expect(paths(result)).toEqual([older, scratch].sort());
  expect(result.excluded).toBeArray();
  expect(result.errors).toEqual([]);
  expect(result.totalBytes).toBe(mediaItems(result).reduce((sum, item) => sum + (item.bytes ?? 0), 0));
  expect(result.totalBytes).toBeGreaterThan(0);
  expect([older, latest, scratch].every(existsSync)).toBe(true);
}, 30_000);

for (const command of [["scan"], ["dry-run", "media"]]) {
  test(`${command.join(" ")} discovers nothing when media.enabled is false`, async () => {
    // Given otherwise eligible render and scratch media with discovery disabled.
    const w = world({ enabled: false });
    w.render("trust-v1");
    w.render("trust-v2");
    w.file(join(w.scratch, "old.mp4"));

    // When invoking either discovery surface.
    const result = await w.run<DryRun>(command);

    // Then no media is proposed or excluded.
    expect(paths(result)).toEqual([]);
    expect(result.excluded.filter((item) => item.kind === "media")).toEqual([]);
    expect(result.errors).toEqual([]);
    if (command[0] === "dry-run") expect(result.totalBytes).toBe(0);
  }, 30_000);
}

for (const marker of ["final", "delivery", "uploaded"]) {
  test(`scan protects an older render containing a ${marker} descendant`, async () => {
    // Given an old series with a protected descendant and a newer version.
    const w = world();
    const protectedDir = w.render("trust-v1", `${marker}/clip.mp4`);
    w.file(join(protectedDir, "audio.wav"));
    w.file(join(protectedDir, "frames", "0001.png"));
    const eligible = w.render("trust-v2");
    w.render("trust-v3");

    // When scanning.
    const result = await w.run<Proposal>(["scan"]);

    // Then the entire protected directory stays out, not just its marked file.
    expect(paths(result)).toEqual([eligible]);
    expectProtected(result, protectedDir);
    expect(result.excluded.find((item) => item.path === protectedDir)?.reason).toContain(join(protectedDir, marker));
  }, 30_000);
}

test("scan protects a render named by a configured upload-results JSON glob", async () => {
  // Given an uploaded old render and a separate eligible old render.
  const w = world({ globs: true });
  const uploaded = w.render("trust-v1");
  w.file(join(uploaded, "audio.wav"));
  w.file(join(uploaded, "frames", "0001.png"));
  const eligible = w.render("trust-v2");
  w.render("trust-v3");
  writeFileSync(w.uploads, JSON.stringify({ uploads: [{ path: join(uploaded, "render.mp4"), videoId: "fixture-video", status: "uploaded" }] }));

  // When scanning with upload-results configured outside the media tree.
  const result = await w.run<Proposal>(["scan"]);

  // Then upload evidence protects the containing render directory.
  expect(paths(result)).toEqual([eligible]);
  expectProtected(result, uploaded);
}, 30_000);

for (const field of ["sourceVideoPath", "video", "manifest"]) {
  test(`scan protects uploaded media recorded through ${field}`, async () => {
    // Given upload evidence outside the media root, including manifest-only results.
    const w = world();
    const uploaded = w.render("trust-v1");
    w.render("trust-v2");
    const video = join(uploaded, "render.mp4");
    const manifest = w.file(join(dirname(w.root), "upload-manifest.json"), JSON.stringify({ content: { sourceVideoPath: video } }));
    writeFileSync(w.uploads, JSON.stringify({ videoId: "fixture-video", [field]: field === "manifest" ? manifest : video }));

    // When discovering media from an otherwise eligible older render.
    const result = await w.run<Proposal>(["scan"]);

    // Then both direct and manifest-linked upload paths protect the entire render.
    expectProtected(result, uploaded);
  }, 30_000);
}

for (const gitRepo of [false, true]) {
  test(`scan protects v7-ref referenced by external JSON in a ${gitRepo ? "git repository" : "non-git media root"}`, async () => {
    // Given the reference incident, with templates outside out/ in a git repo.
    const w = world();
    const references = w.root;
    if (gitRepo) {
      const init = await Bun.$`git init -q ${w.root}`.quiet();
      expect(init.exitCode).toBe(0);
      const policy = JSON.parse(readFileSync(w.s.policyPath, "utf8"));
      writeFileSync(w.s.policyPath, JSON.stringify({ ...policy, media: { ...policy.media, roots: [join(w.root, "out")] } }));
    }
    const referenced = w.render("four-shorts-v7-ref", "phone-ui.png");
    w.render("four-shorts-v8");
    const eligible = w.render("trust-v1");
    w.render("trust-v2");
    w.file(join(references, "templates", "layout.json"), JSON.stringify({ image: "out/four-shorts-v7-ref/phone-ui.png" }));

    // When scanning, including untracked non-code text outside the candidate.
    const result = await w.run<Proposal>(["scan"]);

    // Then the whole v7 directory is protected even though v8 exists.
    expect(paths(result)).toEqual([eligible]);
    expectProtected(result, referenced);
    expect(result.excluded.find((item) => item.path === referenced)?.reason).toContain(join(references, "templates", "layout.json"));
  }, 30_000);
}

test("scan ignores candidate-internal, binary, node_modules, and .git references", async () => {
  // Given references only in locations that must not protect stale renders.
  const w = world();
  const eligible = w.render("trust-v1");
  w.render("trust-v2");
  expect((await Bun.$`git init -q ${w.root}`.quiet()).exitCode).toBe(0);
  const reference = "out/trust-v1/render.mp4";
  w.file(join(eligible, "self.json"), JSON.stringify({ path: reference }));
  w.file(join(w.root, "node_modules", "fixture", "index.js"), reference);
  w.file(join(w.root, ".git", "objects", "fixture"), reference);
  w.file(join(w.root, "templates", "binary.dat"), Buffer.concat([Buffer.from([0]), Buffer.from(reference)]));

  // When scanning.
  const result = await w.run<Proposal>(["scan"]);

  // Then these references do not make the old directory immortal.
  expect(paths(result)).toEqual([eligible]);
}, 30_000);

test("scan uses recent descendant mtimes rather than only the old render directory mtime", async () => {
  // Given old ancestors containing a newly modified nested media file.
  const w = world();
  const recent = w.render("trust-v1", "frames/nested/frame.png");
  w.file(join(recent, "audio.wav"));
  const eligible = w.render("trust-v2");
  w.render("trust-v3");
  const now = new Date();
  utimesSync(join(recent, "frames", "nested", "frame.png"), now, now);

  // When scanning.
  const result = await w.run<Proposal>(["scan"]);

  // Then the recent descendant protects its entire old render directory.
  expect(paths(result)).toEqual([eligible]);
  expectProtected(result, recent);
}, 30_000);

test("scan protects git-tracked descendants using a real git index", async () => {
  // Given a real repository with one tracked old render and one untracked one.
  const w = world();
  const tracked = w.render("trust-v1");
  w.file(join(tracked, "audio.wav"));
  const eligible = w.render("trust-v2");
  w.render("trust-v3");
  const init = await Bun.$`git init -q ${w.root}`.quiet();
  expect(init.exitCode).toBe(0);
  const add = await Bun.$`git -C ${w.root} add -- ${relative(w.root, join(tracked, "render.mp4"))}`.quiet();
  expect(add.exitCode).toBe(0);

  // When scanning.
  const result = await w.run<Proposal>(["scan"]);

  // Then tracking any descendant protects the containing render directory.
  expect(paths(result)).toEqual([eligible]);
  expectProtected(result, tracked);
}, 30_000);

for (const includeOriginals of [false, true]) {
  test(`scan ${includeOriginals ? "proposes" : "protects"} exact manifest originals ${includeOriginals ? "with" : "without"} opt-in`, async () => {
    // Given an exact name+size match; localPath is deliberately absent so it
    // cannot itself act as a reference when originals are explicitly included.
    const w = world();
    const original = w.file(join(w.root, "source-camera.mov"));
    w.file(join(w.root, "source-manifest.json"), JSON.stringify({
      files: [{ originalFilename: "source-camera.mov", driveId: "remote-fixture", bytes: SIZE }],
    }));

    // When scanning with or without the explicit originals flag.
    const result = await w.run<Proposal>(includeOriginals ? ["scan", "--include-originals"] : ["scan"]);

    // Then only opt-in exposes the matching original for approval.
    expect(paths(result)).toEqual(includeOriginals ? [original] : []);
    if (includeOriginals) expect(mediaItems(result)[0]).toMatchObject({ tier: "approve", path: original, bytes: 8192 });
    else expectProtected(result, original);
  }, 30_000);
}

test("dry-run media honors originals opt-in but still protects localPath references", async () => {
  // Given two manifest originals, only one of which has a local reference.
  const w = world();
  const eligible = w.file(join(w.root, "unreferenced.mov"));
  const referenced = w.file(join(w.root, "referenced.mov"));
  w.file(join(w.root, "source-manifest.json"), JSON.stringify({
    files: [
      { originalFilename: "unreferenced.mov", driveId: "remote-one", bytes: SIZE },
      { originalFilename: "referenced.mov", driveId: "remote-two", bytes: SIZE, localPath: referenced },
    ],
  }));

  // When opting into originals during dry-run.
  const result = await w.run<DryRun>(["dry-run", "media", "--include-originals"]);

  // Then the flag does not bypass reference safety.
  expect(paths(result)).toEqual([eligible]);
  expectProtected(result, referenced);
  expect(result.totalBytes).toBe(8192);
}, 30_000);

test("scan does not identify originals from filename alone or size alone", async () => {
  // Given manifest entries that each fail one part of the original identity.
  const w = world();
  const wrongSize = w.file(join(w.root, "wrong-size.mov"));
  const wrongName = w.file(join(w.root, "different-name.mov"));
  w.file(join(w.root, "source-manifest.json"), JSON.stringify({
    files: [
      { originalFilename: "wrong-size.mov", driveId: "remote-one", bytes: SIZE + 1 },
      { originalFilename: "absent.mov", driveId: "remote-two", bytes: SIZE },
    ],
  }));

  // When explicitly asking to discover remote-backed originals.
  const result = await w.run<Proposal>(["scan", "--include-originals"]);

  // Then neither ordinary source file is falsely proposed as a remote original.
  expect(paths(result)).toEqual([]);
  expect([wrongSize, wrongName].every(existsSync)).toBe(true);
}, 30_000);

test("scratch discovery honors the configured three-day age and media extension allowlist", async () => {
  // Given every supported extension plus unrelated text and younger media.
  const w = world();
  const eligible = ["mp4", "mov", "mkv", "webm", "m4a", "mp3", "wav", "png"]
    .map((extension) => w.file(join(w.scratch, `old.${extension}`)));
  const text = w.file(join(w.scratch, "unrelated.txt"));
  const twoDays = w.file(join(w.scratch, "two-days.mp4"));
  const fresh = w.file(join(w.scratch, "fresh.mp4"));
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * DAY);
  utimesSync(twoDays, twoDaysAgo, twoDaysAgo);
  utimesSync(fresh, new Date(now), new Date(now));

  // When scanning with staleDays=3.
  const result = await w.run<Proposal>(["scan"]);

  // Then only old allowlisted media is proposed.
  expect(paths(result)).toEqual(eligible.sort());
  expect([text, twoDays, fresh].every(existsSync)).toBe(true);
}, 30_000);

test("scratch discovery enforces a twenty-four-hour floor when staleDays is zero", async () => {
  // Given media on either side of the hard floor, far from its boundary.
  const w = world({ staleDays: 0 });
  const older = w.file(join(w.scratch, "two-days.mp4"));
  const younger = w.file(join(w.scratch, "twelve-hours.mp4"));
  const now = Date.now();
  const olderTime = new Date(now - 2 * DAY);
  const youngerTime = new Date(now - DAY / 2);
  utimesSync(older, olderTime, olderTime);
  utimesSync(younger, youngerTime, youngerTime);

  // When scanning a policy requesting no age delay.
  const result = await w.run<Proposal>(["scan"]);

  // Then the minimum safety age still applies.
  expect(paths(result)).toEqual([older]);
}, 30_000);

test("ordinary non-versioned intermediates are eligible but final delivery and latest stay protected", async () => {
  // Given ordinary intermediate directories/files, not just numbered renders.
  const w = world();
  const frames = join(w.root, "work", "frames");
  const phoneFrames = join(w.root, "work", "phone-frames");
  w.file(join(frames, "0001.png"));
  w.file(join(phoneFrames, "0001.png"));
  const wav = w.file(join(w.root, "work", "audio.wav"));
  const webm = w.file(join(w.root, "work", "preview.webm"));
  const proxy = w.file(join(w.root, "work", "proxy.mp4"));
  w.file(join(w.root, "work", "render.mp4"));
  w.file(join(w.root, "work", "timeline.json"), JSON.stringify({ segments: [] }));
  w.file(join(w.root, "work", "notes.txt"));
  for (const marker of ["final", "delivery", "latest"]) {
    w.file(join(w.root, marker, "frames", "0001.png"));
    w.file(join(w.root, marker, "audio.wav"));
    w.file(join(w.root, marker, "preview.webm"));
    w.file(join(w.root, marker, "proxy.mp4"));
  }

  // When discovering ordinary intermediate media.
  const result = await w.run<Proposal>(["scan"]);

  // Then directories are proposed once, without their individual frame files.
  expect(paths(result)).toEqual([frames, phoneFrames, wav, webm, proxy].sort());
}, 30_000);

test("sibling timeline references protect local frames and audio paths", async () => {
  // Given verified render context with paths relative to its own timeline.
  const w = world();
  const work = join(w.root, "work");
  const frames = join(work, "frames");
  const audio = w.file(join(work, "audio.wav"));
  w.file(join(frames, "0001.png"));
  w.file(join(work, "render.mp4"));
  const timeline = w.file(join(work, "timeline.json"), JSON.stringify({ frame: "frames/0001.png", audio: "audio.wav" }));

  // When checking ordinary intermediate candidates.
  const result = await w.run<DryRun>(["dry-run", "media"]);

  // Then local path references protect both directory and file candidates.
  expectProtected(result, frames);
  expectProtected(result, audio);
  for (const path of [frames, audio])
    expect(result.excluded.find((item) => item.path === path)?.reason).toContain(timeline);
}, 30_000);

for (const target of ["out/trust-v1", "out/trust-v1/render.mp4"]) {
  test(`referenced render containers protect descendants when pointing at ${target}`, async () => {
    // Given a referenced older render with otherwise eligible nested media.
    const w = world();
    const older = w.render("trust-v1", "frames/0001.png");
    w.file(join(older, "audio.wav"));
    w.render("trust-v2");
    const reference = w.file(join(w.root, "templates", "layout.json"), JSON.stringify({ renderDir: target }));

    // When scanning both the version container and its intermediate children.
    const result = await w.run<DryRun>(["dry-run", "media"]);

    // Then the excluded parent cannot be bypassed through its children.
    expectProtected(result, older);
    expect(result.excluded.find((item) => item.path === join(older, "audio.wav"))?.reason).toContain(reference);
    expect(result.totalBytes).toBe(0);
  }, 30_000);
}

test("a referenced render does not protect unrelated sibling versions", async () => {
  // Given a root-level reference to only one of two older render versions.
  const w = world();
  const referenced = w.render("trust-v1");
  w.file(join(referenced, "audio.wav"));
  const eligible = w.render("trust-v2");
  w.render("trust-v3");
  w.file(join(w.root, "README.md"), "Use out/trust-v1\n");

  // When ancestor references are inherited by individual intermediates.
  const result = await w.run<Proposal>(["scan"]);

  // Then protection stays with the referenced subtree, not its siblings.
  expectProtected(result, referenced);
  expect(paths(result)).toEqual([eligible]);
}, 30_000);

for (const childFirst of [false, true]) {
  test(`overlapping roots preserve protected containers with child-first=${childFirst}`, async () => {
    // Given an independently scanned WAV inside a final-containing render.
    const w = world();
    const protectedDir = w.render("trust-v1", "final/clip.mp4");
    const audio = w.file(join(protectedDir, "audio.wav"));
    const eligible = w.render("trust-v2");
    w.render("trust-v3");
    const policy = JSON.parse(readFileSync(w.s.policyPath, "utf8"));
    writeFileSync(w.s.policyPath, JSON.stringify({
      ...policy, media: { ...policy.media, roots: childFirst ? [audio, w.root] : [w.root, audio] },
    }));

    // When either root is scanned first.
    const result = await w.run<DryRun>(["dry-run", "media"]);

    // Then the overlapping scan cannot bypass the protected parent.
    expectProtected(result, protectedDir);
    expect(paths(result)).toEqual([eligible]);
  }, 30_000);
}

test("overlapping render and scratch roots never produce duplicate or nested proposals", async () => {
  // Given the same candidates visible through paths, globs, and two categories.
  const w = world({ overlap: true });
  const older = w.render("trust-v1", "frames/0001.png");
  const latest = w.render("trust-v2");
  const scratch = w.file(join(w.scratch, "scratch.mp4"));
  w.file(join(older, "audio.wav"));

  // When doing a media dry-run.
  const result = await w.run<DryRun>(["dry-run", "media"]);

  // Then each byte belongs to at most one proposal.
  expect(paths(result)).toEqual([older, scratch].sort());
  const proposed = paths(result);
  expect(new Set(proposed).size).toBe(proposed.length);
  for (const parent of proposed) {
    expect(proposed.filter((path) => path !== parent && under(path, parent))).toEqual([]);
  }
  expect(mediaItems(result).some((item) => under(item.path, latest))).toBe(false);
  expect(result.totalBytes).toBe(mediaItems(result).reduce((sum, item) => sum + (item.bytes ?? 0), 0));
}, 30_000);

test("site capture frame packs remain source material without a rendered video", async () => {
  // Given point-in-time website captures, not regenerable video frames.
  const w = world();
  const pack = join(w.root, "out", "packs", "example");
  const frames = join(pack, "frames");
  w.file(join(frames, "scene-01-f0-y0000.png"));
  w.file(join(frames, "scene-01-text.txt"), "Captured website text");
  w.file(join(frames, "audio.wav"));
  w.file(join(pack, "scenes.json"), JSON.stringify({ scenes: [{ id: 1 }] }));
  w.file(join(pack, "SCENEBOOK.md"), "# SceneBook\n");
  // An unrelated video elsewhere must not make every frames/ regenerable.
  w.render("trust-v1");

  // When discovering media under generic output roots.
  const result = await w.run<Proposal>(["scan"]);

  // Then the raw capture directory is explicitly excluded and left intact.
  expectProtected(result, frames);
  expect(existsSync(join(frames, "scene-01-text.txt"))).toBe(true);
}, 30_000);

for (const missing of ["video", "metadata"]) {
  test(`frame directories require both render inputs when ${missing} is absent`, async () => {
    // Given a frame directory with only half of the required render context.
    const w = world();
    const frames = join(w.root, "work", "phone-frames");
    w.file(join(frames, "0001.png"));
    if (missing !== "video") w.file(join(w.root, "work", "render.mov"));
    if (missing !== "metadata") w.file(join(w.root, "work", "timeline.json"), "{}");

    // When scanning candidate media.
    const result = await w.run<Proposal>(["scan"]);

    // Then neither naming nor a single marker proves regeneration is possible.
    expectProtected(result, frames);
  }, 30_000);
}

test("check queues media for approval and status reports it without auto-deleting", async () => {
  // Given auto enabled, media must still be approval-only.
  const w = world({ auto: true });
  const older = w.render("trust-v1");
  const latest = w.render("trust-v2");

  // When the scheduled check runs.
  const checked = await w.run<{ readonly proposal: string; readonly auto: number; readonly approve: number; readonly errors: readonly string[] }>(["check"]);

  // Then the persisted inbox and status expose the same pending media.
  expect(checked).toMatchObject({ auto: 0, approve: 1, errors: [] });
  const inbox = readdirSync(join(w.s.state, "inbox"));
  expect(inbox).toEqual([`${checked.proposal}.json`]);
  const proposal: Proposal = JSON.parse(readFileSync(join(w.s.state, "inbox", inbox[0] ?? ""), "utf8"));
  expect(paths(proposal)).toEqual([older]);
  expect(mediaItems(proposal)[0]).toMatchObject({ tier: "approve" });
  const status = await w.run<{ readonly pending: readonly { readonly id: string; readonly items: number; readonly bytes: number; readonly media: readonly MediaEntry[] }[] }>(["status"]);
  expect(status.pending).toEqual([expect.objectContaining({ id: checked.proposal, items: 1, bytes: mediaItems(proposal)[0]?.bytes })]);
  expect(status.pending[0]?.media.map((i) => i.path)).toEqual([older]);
  expect([older, latest].every(existsSync)).toBe(true);
}, 30_000);

test("report exposes media proposal reasons and sizes in JSON and text", async () => {
  // Given an eligible media tree and no other report targets.
  const w = world();
  const older = w.render("trust-v1");
  w.render("trust-v2");

  // When reading both supported report surfaces.
  const report = await w.run<{ readonly media: DryRun }>(["report", "--json"]);
  const text = await w.s.run(["report"]);

  // Then the real CLI includes per-item data without changing media.
  expect(paths(report.media)).toEqual([older]);
  expect(report.media.totalBytes).toBe(8192);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(older);
  expect(existsSync(older)).toBe(true);
}, 30_000);

test("approval revalidation drops media newly referenced after its proposal", async () => {
  // Given an approval proposal followed by a newly added external reference.
  const w = world();
  const older = w.render("trust-v1");
  w.render("trust-v2");
  const proposal = await w.run<Proposal>(["scan"]);
  w.file(join(w.root, "templates", "layout.json"), JSON.stringify({ source: "out/trust-v1/render.mp4" }));

  // When applying this sandbox proposal through the existing approval flow.
  const result = await w.run<{ readonly applied: number; readonly dropped: readonly { readonly path: string }[] }>(["apply", proposal.id]);

  // Then no fixture media is removed because it is no longer eligible.
  expect(result.applied).toBe(0);
  expect(result.dropped.map((i) => i.path)).toContain(older);
  expect(existsSync(older)).toBe(true);
}, 30_000);

test("automatic application never selects approve-only media", async () => {
  // Given media in a proposal while auto is enabled.
  const w = world({ auto: true });
  const older = w.render("trust-v1");
  w.render("trust-v2");
  const proposal = await w.run<Proposal>(["scan"]);

  // When requesting auto-tier application in the isolated sandbox.
  const result = await w.run<{ readonly applied: number }>(["apply", proposal.id, "--tier", "auto"]);

  // Then the media is still waiting for explicit approval.
  expect(result.applied).toBe(0);
  expect(existsSync(older)).toBe(true);
}, 30_000);
