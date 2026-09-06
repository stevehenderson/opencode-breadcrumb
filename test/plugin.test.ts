import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MESSAGE_THROTTLE_MS,
  PLUGIN_VERSION,
  captureGitState,
  createService,
  ensureMachineId,
  ensureStateDir,
  extractPromptText,
  extractSessionRef,
  loadState,
  removeSnapshot,
  upsertSnapshot,
  writeStateAtomic,
} from "../plugin/breadcrumb.ts";
import { parseState, type BreadcrumbState, type SessionSnapshot } from "../shared/state.ts";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function snap(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    session_id: id,
    title: `t-${id}`,
    directory: `/d/${id}`,
    git_branch: "main",
    git_commit: "a".repeat(40),
    git_dirty: false,
    updated_at: "2026-09-05T12:00:00Z",
    ...overrides,
  };
}

function state0(sessions: SessionSnapshot[] = []): BreadcrumbState {
  return {
    schema: 1,
    machine_id: "m",
    hostname: "h",
    written_at: "2026-01-01T00:00:00Z",
    plugin_version: PLUGIN_VERSION,
    sessions,
  };
}

async function readStateFile(dir: string) {
  const text = await fs.readFile(path.join(dir, "state.json"), "utf8");
  return parseState(text);
}

// -- event extraction (FR-PLUGIN-010/011/020) -----------------------------------

test("extractSessionRef maps session.created/updated (info: Session)", () => {
  const ref = extractSessionRef(
    { type: "session.created", properties: { info: { id: "ses_1", title: "hi", directory: "/w" } } },
    "/ctx",
  );
  assert.deepEqual(ref, { kind: "observe", sessionID: "ses_1", title: "hi", directory: "/w", throttled: false });
  const updated = extractSessionRef(
    { type: "session.updated", properties: { info: { id: "ses_1", title: "renamed" } } },
    "/ctx",
  );
  assert.equal(updated?.kind, "observe");
  if (updated?.kind === "observe") {
    assert.equal(updated.title, "renamed");
    assert.equal(updated.directory, undefined);
  }
});

test("extractSessionRef maps idle/compacted (flat sessionID) without throttle", () => {
  const ref = extractSessionRef({ type: "session.idle", properties: { sessionID: "ses_9" } }, "/ctx");
  assert.deepEqual(ref, { kind: "observe", sessionID: "ses_9", throttled: false });
  const compacted = extractSessionRef({ type: "session.compacted", properties: { sessionID: "ses_9" } }, "/ctx");
  assert.equal(compacted?.kind, "observe");
});

test("extractSessionRef maps session.deleted to remove", () => {
  assert.deepEqual(extractSessionRef({ type: "session.deleted", properties: { info: { id: "ses_x" } } }, "/ctx"), {
    kind: "remove",
    sessionID: "ses_x",
  });
});

test("extractSessionRef maps message events with throttle (FR-PLUGIN-042)", () => {
  const ref = extractSessionRef({ type: "message.updated", properties: { info: { sessionID: "ses_m" } } }, "/ctx");
  assert.deepEqual(ref, { kind: "observe", sessionID: "ses_m", throttled: true });
  const part = extractSessionRef({ type: "message.part.updated", properties: { part: { sessionID: "ses_p" } } }, "/ctx");
  assert.equal(part?.kind, "observe");
  if (part?.kind === "observe") assert.equal(part.throttled, true);
});

test("extractSessionRef ignores unknown events and missing ids", () => {
  assert.equal(extractSessionRef({ type: "pty.updated", properties: {} }, "/ctx"), null);
  assert.equal(extractSessionRef({ type: "session.idle", properties: {} }, "/ctx"), null);
  assert.equal(extractSessionRef({}, "/ctx"), null);
  assert.equal(extractSessionRef({ type: "session.created", properties: null }, "/ctx"), null);
});

// -- git capture (FR-PLUGIN-030/031) ----------------------------------------------

test("captureGitState: non-git directory is non-fatal (null/false)", async () => {
  const dir = await tmpDir("bc-nongit-");
  const git = await captureGitState(dir);
  assert.deepEqual(git, { git_branch: null, git_commit: null, git_dirty: false });
});

test("captureGitState: missing git binary is non-fatal (FR-PLUGIN-031)", async () => {
  const dir = await tmpDir("bc-nogitbin-");
  const git = await captureGitState(dir, { bin: "/nonexistent/git-bc-test" });
  assert.deepEqual(git, { git_branch: null, git_commit: null, git_dirty: false });
});

test("captureGitState: stub git controls branch/commit/dirty", async () => {
  const dir = await tmpDir("bc-stubgit-");
  const bin = path.join(dir, "git-stub");
  await fs.writeFile(
    bin,
    [
      "#!/bin/sh",
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--abbrev-ref" ]; then',
      '  if [ -n "$BC_FAKE_BRANCH" ]; then echo "$BC_FAKE_BRANCH"; exit 0; fi',
      "  exit 128",
      "fi",
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then',
      '  if [ -n "$BC_FAKE_COMMIT" ]; then echo "$BC_FAKE_COMMIT"; exit 0; fi',
      "  exit 128",
      "fi",
      'if [ "$3" = "status" ]; then',
      '  if [ -n "$BC_FAKE_DIRTY" ]; then echo " M fakefile"; fi',
      "  exit 0",
      "fi",
      "exit 128",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.BC_FAKE_BRANCH = "feature-x";
  process.env.BC_FAKE_COMMIT = "deadbeef";
  process.env.BC_FAKE_DIRTY = "1";
  try {
    assert.deepEqual(await captureGitState("/any/dir", { bin }), {
      git_branch: "feature-x",
      git_commit: "deadbeef",
      git_dirty: true,
    });
    delete process.env.BC_FAKE_BRANCH;
    delete process.env.BC_FAKE_COMMIT;
    delete process.env.BC_FAKE_DIRTY;
    assert.deepEqual(await captureGitState("/any/dir", { bin }), {
      git_branch: null,
      git_commit: null,
      git_dirty: false,
    });
  } finally {
    delete process.env.BC_FAKE_BRANCH;
    delete process.env.BC_FAKE_COMMIT;
    delete process.env.BC_FAKE_DIRTY;
  }
});

test("captureGitState: real git repo — branch, commit, dirty, detached HEAD", async (t) => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    t.skip("git not available");
    return;
  }
  const repo = await tmpDir("bc-repo-");
  const run = (args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  run(["init"]);
  run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  run(["config", "user.email", "t@t.local"]);
  run(["config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "f.txt"), "x");
  run(["add", "f.txt"]);
  const c = run(["commit", "-m", "init"]);
  assert.equal(c.status, 0, c.stderr);

  const clean = await captureGitState(repo);
  assert.equal(clean.git_branch, "main");
  assert.match(clean.git_commit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(clean.git_dirty, false);

  await fs.writeFile(path.join(repo, "f.txt"), "x modified");
  const dirty = await captureGitState(repo);
  assert.equal(dirty.git_dirty, true);
  assert.equal(dirty.git_branch, "main");

  const d = run(["checkout", "--detach"]);
  assert.equal(d.status, 0, d.stderr);
  const detached = await captureGitState(repo);
  assert.equal(detached.git_branch, null);
  assert.match(detached.git_commit ?? "", /^[0-9a-f]{40}$/);
});

// -- state file I/O (FR-PLUGIN-040/041, IDN-010/011) ------------------------------

test("ensureStateDir creates ~/.local/share/breadcrumb with mode 0700 (FR-PLUGIN-041)", async () => {
  const home = await tmpDir("bc-home-");
  const dir = await ensureStateDir(home);
  assert.equal(dir, path.join(home, ".local", "share", "breadcrumb"));
  const st = await fs.stat(dir);
  assert.equal(st.isDirectory(), true);
  assert.equal((st.mode & 0o777) >>> 0, 0o700);
});

test("ensureMachineId creates a UUID once and is stable across calls (IDN-010/011)", async () => {
  const dir = await tmpDir("bc-mid-");
  const id1 = await ensureMachineId(dir);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const st = await fs.stat(path.join(dir, "machine_id"));
  assert.equal((st.mode & 0o777) >>> 0, 0o600);
  assert.equal(await ensureMachineId(dir), id1);
});

test("ensureMachineId respects a pre-existing id (survives reinstall)", async () => {
  const dir = await tmpDir("bc-mid2-");
  await fs.writeFile(path.join(dir, "machine_id"), "existing-id-1234\n");
  assert.equal(await ensureMachineId(dir), "existing-id-1234");
});

test("writeStateAtomic writes parseable file with mode 0600 and leaves no temp files (FR-PLUGIN-040)", async () => {
  const dir = await tmpDir("bc-atomic-");
  const state = state0([snap("s1")]);
  await writeStateAtomic(dir, state);
  const parsed = await readStateFile(dir);
  assert.equal(parsed.sessions[0].session_id, "s1");
  const st = await fs.stat(path.join(dir, "state.json"));
  assert.equal((st.mode & 0o777) >>> 0, 0o600);
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries.filter((e) => e.includes("tmp")), []);
});

test("loadState: absent file is fresh; unknown schema or corrupt file is foreign", async () => {
  const dir = await tmpDir("bc-load-");
  const fresh = await loadState(dir, "h", "m", "0.1.0", Date.now());
  assert.equal(fresh.exists, false);
  assert.equal(fresh.foreign, false);
  assert.deepEqual(fresh.state.sessions, []);

  await fs.writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ ...state0(), schema: 2 }),
  );
  const foreign = await loadState(dir, "h", "m", "0.1.0", Date.now());
  assert.equal(foreign.exists, true);
  assert.equal(foreign.foreign, true);

  await fs.writeFile(path.join(dir, "state.json"), "{ not json");
  const corrupt = await loadState(dir, "h", "m", "0.1.0", Date.now());
  assert.equal(corrupt.foreign, true);
});

// -- snapshot list management (FR-PLUGIN-050/051) ----------------------------------

test("upsertSnapshot replaces in place and moves to front (FR-PLUGIN-051)", async () => {
  let state = state0([snap("old", { updated_at: "2026-01-01T00:00:00Z" })]);
  state = await upsertSnapshot(state, snap("new", { updated_at: "2026-02-01T00:00:00Z" }), Date.parse("2026-02-02T00:00:00Z"));
  state = await upsertSnapshot(state, snap("old", { updated_at: "2026-03-01T00:00:00Z", title: "old-twin" }), Date.parse("2026-03-02T00:00:00Z"));
  assert.deepEqual(
    state.sessions.map((s) => s.session_id),
    ["old", "new"],
  );
  assert.equal(state.sessions[0].title, "old-twin"); // replaced, not duplicated
  assert.equal(state.written_at, "2026-03-02T00:00:00.000Z");
});

test("upsertSnapshot keeps newest-first and caps at 200, dropping oldest (FR-PLUGIN-050)", async () => {
  const sessions = [];
  for (let i = 0; i < 200; i++) {
    // 200 hourly entries starting April 1 — all older than "newest" (June 1)
    sessions.push(snap(`s${i}`, { updated_at: new Date(Date.UTC(2026, 3, 1) + i * 3600_000).toISOString() }));
  }
  let state = state0(sessions);
  state = await upsertSnapshot(state, snap("newest", { updated_at: "2026-06-01T00:00:00Z" }), Date.now());
  assert.equal(state.sessions.length, 200);
  assert.equal(state.sessions[0].session_id, "newest");
  assert.equal(state.sessions[199].session_id, "s1"); // s0 (oldest) dropped
});

test("removeSnapshot drops the session", async () => {
  const state = state0([snap("a"), snap("b")]);
  const next = await removeSnapshot(state, "a", Date.parse("2026-01-02T00:00:00Z"));
  assert.deepEqual(
    next.sessions.map((s) => s.session_id),
    ["b"],
  );
});

// -- service: end-to-end plugin behavior --------------------------------------------

test("service: session lifecycle events rewrite the state file (FR-PLUGIN-011/020)", async () => {
  const home = await tmpDir("bc-svc-");
  let t = Date.parse("2026-09-05T12:00:00Z");
  const svc = await createService({
    home,
    directory: "/work/proj",
    hostname: "testhost",
    now: () => t,
    gitBin: "/nonexistent/git-bc-test",
  });

  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_1", title: "hello", directory: "/work/proj" } } });
  let st = await readStateFile(svc.stateDir);
  assert.equal(st.hostname, "testhost");
  assert.match(st.machine_id, /^[0-9a-f-]{36}$/);
  assert.equal(st.plugin_version, PLUGIN_VERSION);
  assert.equal(st.written_at, new Date(t).toISOString());
  assert.equal(st.sessions.length, 1);
  assert.equal(st.sessions[0].session_id, "ses_1");
  assert.equal(st.sessions[0].title, "hello");
  assert.equal(st.sessions[0].directory, "/work/proj");
  assert.equal(st.sessions[0].git_branch, null); // git missing: non-fatal (FR-PLUGIN-031)

  t += 60_000;
  await svc.handleEvent({ type: "session.idle", properties: { sessionID: "ses_2" } });
  st = await readStateFile(svc.stateDir);
  assert.deepEqual(
    st.sessions.map((s) => s.session_id),
    ["ses_2", "ses_1"], // newest first
  );
  const ses2 = st.sessions[0];
  assert.equal(ses2.title, null); // idle event carries no title
  assert.equal(ses2.directory, "/work/proj"); // falls back to plugin context dir
});

test("service: message events are throttled to one write per 5s (FR-PLUGIN-042)", async () => {
  const home = await tmpDir("bc-throttle-");
  let t = Date.parse("2026-09-05T12:00:00Z");
  const svc = await createService({
    home,
    directory: "/w",
    now: () => t,
    gitBin: "/nonexistent/git-bc-test",
  });
  const msg = () => svc.handleEvent({ type: "message.updated", properties: { info: { sessionID: "ses_m" } } });

  await msg(); // first message write is not throttled
  const afterFirst = (await readStateFile(svc.stateDir)).sessions[0].updated_at;

  t += 1_000;
  await msg();
  const throttled = (await readStateFile(svc.stateDir)).sessions[0].updated_at;
  assert.equal(throttled, afterFirst, "write within 5s must be skipped");

  t += MESSAGE_THROTTLE_MS + 1;
  await msg();
  const afterWindow = (await readStateFile(svc.stateDir)).sessions[0].updated_at;
  assert.notEqual(afterWindow, afterFirst, "write after the 5s window must land");
});

test("extractPromptText joins text parts and ignores everything else", () => {
  assert.equal(
    extractPromptText([{ type: "text", text: "hello" }, { type: "tool", text: "x" }, { type: "text", text: "world" }]),
    "hello\nworld",
  );
  assert.equal(extractPromptText([{ type: "reasoning", text: "thinking" }]), null);
  assert.equal(extractPromptText([{ type: "text", text: "" }]), null);
  assert.equal(extractPromptText([]), null);
  assert.equal(extractPromptText("nope"), null);
  assert.equal(extractPromptText(null), null);
});

test("service: recordPrompt stores the last user prompt as the gist and it sticks", async () => {
  const home = await tmpDir("bc-prompt-");
  const svc = await createService({ home, directory: "/w", gitBin: "/nonexistent/git-bc-test" });
  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_p", title: "t", directory: "/w" } } });
  await svc.recordPrompt("ses_p", "  Fix the\n ingress   502 please ");
  let st = await readStateFile(svc.stateDir);
  assert.equal(st.sessions[0].last_prompt, "Fix the ingress 502 please");

  // A later observation that carries no prompt keeps the recorded gist.
  await svc.handleEvent({ type: "session.idle", properties: { sessionID: "ses_p" } });
  st = await readStateFile(svc.stateDir);
  assert.equal(st.sessions[0].last_prompt, "Fix the ingress 502 please");

  // A fresh service loads the gist from disk into its known-context map.
  const svc2 = await createService({ home, directory: "/w", gitBin: "/nonexistent/git-bc-test" });
  await svc2.handleEvent({ type: "session.idle", properties: { sessionID: "ses_p" } });
  st = await readStateFile(svc2.stateDir);
  assert.equal(st.sessions[0].last_prompt, "Fix the ingress 502 please");
});

test("plugin entry: chat.message hook records the prompt gist", async () => {
  const mod = await import("../plugin/breadcrumb.ts");
  const home = await tmpDir("bc-chat-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const hooks = await mod.default.server({ directory: "/ctx/dir" } as never);
    const chat = hooks["chat.message"] as (i: unknown, o: unknown) => Promise<void>;
    assert.equal(typeof chat, "function");
    await chat(
      { sessionID: "ses_chat" },
      { message: { role: "user", sessionID: "ses_chat" }, parts: [{ type: "text", text: "add a search command" }] },
    );
    const parsed = await readStateFile(path.join(home, ".local", "share", "breadcrumb"));
    assert.equal(parsed.sessions[0].session_id, "ses_chat");
    assert.equal(parsed.sessions[0].last_prompt, "add a search command");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("service: session.deleted removes the snapshot", async () => {
  const home = await tmpDir("bc-del-");
  const svc = await createService({ home, directory: "/w", gitBin: "/nonexistent/git-bc-test" });
  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_gone", title: "x", directory: "/w" } } });
  await svc.handleEvent({ type: "session.deleted", properties: { info: { id: "ses_gone" } } });
  const st = await readStateFile(svc.stateDir);
  assert.deepEqual(st.sessions, []);
});

test("service: never clobbers a state file with a newer schema (reject, don't misparse, §5.1)", async () => {
  const home = await tmpDir("bc-foreign-");
  const dir = path.join(home, ".local", "share", "breadcrumb");
  await fs.mkdir(dir, { recursive: true });
  const future = JSON.stringify({ ...state0([snap("future-session")]), schema: 2 });
  await fs.writeFile(path.join(dir, "state.json"), future);

  const svc = await createService({ home, directory: "/w", gitBin: "/nonexistent/git-bc-test" });
  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_local", directory: "/w" } } });
  const text = await fs.readFile(path.join(dir, "state.json"), "utf8");
  assert.equal(text, future, "file must be left untouched");
});

test("service: keeps entries written by a concurrent instance (read-modify-write)", async () => {
  const home = await tmpDir("bc-conc-");
  const svc = await createService({ home, directory: "/w", gitBin: "/nonexistent/git-bc-test" });
  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_a", title: "a", directory: "/w" } } });

  // Simulate a second opencode instance on the same machine writing its session.
  const foreignState = await readStateFile(svc.stateDir);
  await writeStateAtomic(
    svc.stateDir,
    {
      ...foreignState,
      sessions: [...foreignState.sessions, snap("ses_b", { updated_at: "2026-09-05T11:00:00Z" })],
    },
  );

  await svc.handleEvent({ type: "session.created", properties: { info: { id: "ses_c", title: "c", directory: "/w" } } });
  const st = await readStateFile(svc.stateDir);
  assert.deepEqual(
    st.sessions.map((s) => s.session_id).sort(),
    ["ses_a", "ses_b", "ses_c"],
  );
});

test("service: all failures are swallowed, never thrown into opencode (FR-PLUGIN-060)", async () => {
  const home = await tmpDir("bc-swallow-");
  const svc = await createService({
    home,
    directory: "/w",
    gitBin: "/nonexistent/git-bc-test",
  });
  // Unknown shape, missing fields, null properties: none may throw.
  await assert.doesNotReject(svc.handleEvent({}));
  await assert.doesNotReject(svc.handleEvent({ type: "session.idle", properties: null }));
  await assert.doesNotReject(svc.handleEvent({ type: "session.created", properties: { info: null } }));
  await assert.doesNotReject(svc.handleEvent({ type: "totally.unknown.event", properties: {} }));
});

test("plugin entry: default export is the v1 PluginModule with id + server", async () => {
  const mod = await import("../plugin/breadcrumb.ts");
  assert.equal(typeof mod.default, "object");
  assert.equal(mod.default.id, "breadcrumb");
  assert.equal(typeof mod.default.server, "function");
  // The named helpers are plain exports, not plugins (loader takes the v1 path).
  assert.equal(typeof mod.captureGitState, "function");
});

test("plugin entry: server() returns an event hook that writes state (opencode contract)", async () => {
  const mod = await import("../plugin/breadcrumb.ts");
  const home = await tmpDir("bc-entry-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const hooks = await mod.default.server({ directory: "/ctx/dir" } as never);
    const event = hooks.event as (i: { event: unknown }) => Promise<void>;
    assert.equal(typeof event, "function");
    await event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_contract", title: "contract", directory: "/ctx/dir" } },
      },
    } as never);
    const parsed = await readStateFile(path.join(home, ".local", "share", "breadcrumb"));
    assert.equal(parsed.sessions[0].session_id, "ses_contract");
    assert.equal(parsed.hostname, (await import("node:os")).hostname());
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("installer: installed layout loads and resolves shared/state.ts (TECH-010/030)", async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dest = await tmpDir("bc-install-");
  const r = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "install.mjs"), "--dest", dest], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok((await fs.stat(path.join(dest, "breadcrumb.ts"))).isFile());
  assert.ok((await fs.stat(path.join(dest, "shared", "state.ts"))).isFile());

  // Load the installed plugin (not the repo copy): it must find the shared
  // module via the installed-layout candidate "./shared/state.ts".
  const home = await tmpDir("bc-install-home-");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await import(pathToFileURL(path.join(dest, "breadcrumb.ts")).href);
    assert.equal(mod.default.id, "breadcrumb");
    const hooks = await mod.default.server({ directory: "/smoke/proj" } as never);
    const event = hooks.event as (i: { event: unknown }) => Promise<void>;
    await event({
      event: {
        type: "session.created",
        properties: { info: { id: "ses_installed", title: "installed", directory: "/smoke/proj" } },
      },
    } as never);
    const parsed = await readStateFile(path.join(home, ".local", "share", "breadcrumb"));
    assert.equal(parsed.sessions[0].session_id, "ses_installed");
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});
