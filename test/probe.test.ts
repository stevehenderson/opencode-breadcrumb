import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOCAL_HOST,
  PLUGIN_SOURCES,
  buildLaunchCommand,
  buildPickerLines,
  buildPrecheckCommand,
  buildReadCommand,
  buildRemoteCommand,
  classifyReads,
  collectSessions,
  defaultPluginDir,
  formatHealth,
  formatSessionLine,
  gitDiffs,
  installPlugin,
  isLocalHost,
  isOpencodeSessionId,
  main,
  parseArgs,
  parseCleanArgs,
  parseHosts,
  parseHostsArgs,
  parseInstallArgs,
  parsePrecheck,
  parseReadOutput,
  parseSearchArgs,
  planClean,
  runClean,
  pickWithFzf,
  readAllHosts,
  readHostArgs,
  readLocalState,
  resolveTargets,
  resumeArgs,
  runHosts,
  sessionMatches,
  shQuote,
  splitCommand,
  tmuxSessionName,
  type CrumbOptions,
  type HostRead,
  type SshResult,
} from "../probe/crumb.ts";
import { type BreadcrumbState, type MergedSession, type SessionSnapshot } from "../shared/state.ts";

function merged(overrides: Partial<MergedSession> = {}): MergedSession {
  return {
    session_id: "ses_1",
    title: "refactor auth",
    directory: "/home/dev/app",
    git_branch: "main",
    git_commit: "a1b2c3d4",
    git_dirty: false,
    last_prompt: "fix the ingress 502",
    updated_at: "2026-09-05T12:00:00Z",
    host: "build-01",
    machine_id: "m1",
    hostname: "build-01",
    plugin_version: "0.1.0",
    ...overrides,
  };
}

function stateFor(overrides: Partial<BreadcrumbState> = {}, sessionOverrides: Record<string, unknown> = {}): BreadcrumbState {
  return {
    schema: 1,
    machine_id: "m1",
    hostname: "host-a",
    written_at: "2026-09-05T12:00:00Z",
    plugin_version: "0.1.0",
    sessions: [
      {
        session_id: "ses_1",
        title: "t",
        directory: "/d",
        git_branch: "main",
        git_commit: "a1b2c3d4",
        git_dirty: false,
        updated_at: "2026-09-05T12:00:00Z",
        ...sessionOverrides,
      },
    ],
    ...overrides,
  };
}

function readOutput(stateText: string | null, dbMtime: number | null): string {
  let out = "__BC_READ__\n";
  if (stateText !== null) out += stateText;
  out += "\n__BC_SEP__\n";
  if (dbMtime !== null) out += String(dbMtime) + "\n";
  out += "__BC_END__\n";
  return out;
}

function ok(result: SshResult): HostRead {
  return { host: "alpha", result };
}

// -- host list (FR-PROBE-010) -----------------------------------------------

test("parseHosts skips comments/blanks, trims, dedupes", () => {
  assert.deepEqual(parseHosts("# fleet\nalpha\n\n  beta  \nalpha\n# another\n"), ["alpha", "beta"]);
  assert.deepEqual(parseHosts(""), []);
});

// -- read command (FR-PROBE-020/021/070) -------------------------------------

test("read command is non-interactive, time-bounded, and grabs db mtime in the same round", () => {
  const args = readHostArgs("myhost", 3000);
  assert.deepEqual(args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"]);
  assert.equal(args[4], "myhost");
  const cmd = args[5];
  assert.ok(cmd.includes("__BC_READ__"));
  assert.ok(cmd.includes('cat "$HOME/.local/share/breadcrumb/state.json"'));
  assert.ok(cmd.includes('stat -c %Y "$HOME/.local/share/opencode/opencode.db"'));
  assert.ok(cmd.includes('stat -f %m "$HOME/.local/share/opencode/opencode.db"')); // macOS remotes
});

test("parseReadOutput splits state and db mtime", () => {
  const state = JSON.stringify(stateFor());
  const parsed = parseReadOutput(readOutput(state, 1725500000));
  assert.equal(parsed.stateText, state);
  assert.equal(parsed.dbMtime, 1725500000);

  const noDb = parseReadOutput(readOutput(state, null));
  assert.equal(noDb.stateText, state);
  assert.equal(noDb.dbMtime, null);

  const noState = parseReadOutput(readOutput(null, null));
  assert.equal(noState.stateText, null);
  assert.equal(noState.dbMtime, null);

  assert.deepEqual(parseReadOutput("complete garbage"), { stateText: null, dbMtime: null });
});

// -- classification (FR-PROBE-031/040/070) ------------------------------------

test("classifyReads marks unreachable hosts with a detail, not silent (FR-PROBE-031)", () => {
  const [s] = classifyReads([{ host: "beta", result: { code: 255, stdout: "", stderr: "beta: Connection timed out" } }]);
  assert.equal(s.reachable, false);
  assert.equal(s.state, null);
  assert.equal(s.detail, "beta: Connection timed out");
});

test("classifyReads reports reachable host with no state file", () => {
  const [s] = classifyReads([ok({ code: 0, stdout: readOutput(null, null), stderr: "" })]);
  assert.equal(s.reachable, true);
  assert.equal(s.state, null);
  assert.equal(s.stateError, "no state file");
});

test("classifyReads rejects unknown schema (FR-PROBE-040)", () => {
  const bad = JSON.stringify(stateFor({ schema: 99 }));
  const [s] = classifyReads([ok({ code: 0, stdout: readOutput(bad, null), stderr: "" })]);
  assert.equal(s.reachable, true);
  assert.equal(s.state, null);
  assert.match(s.stateError ?? "", /unsupported schema/);
});

test("classifyReads flags stale when opencode.db is >1h newer than the state file (FR-PROBE-070)", () => {
  const written = Date.parse("2026-09-05T12:00:00Z");
  const now = written + 2 * 3600 * 1000;
  const stale = classifyReads(
    [ok({ code: 0, stdout: readOutput(JSON.stringify(stateFor()), now / 1000), stderr: "" })],
    now,
  )[0];
  assert.equal(stale.stale, true);

  const live = classifyReads(
    [ok({ code: 0, stdout: readOutput(JSON.stringify(stateFor()), (written + 10 * 60 * 1000) / 1000), stderr: "" })],
    now,
  )[0];
  assert.equal(live.stale, false);

  const undetermined = classifyReads([ok({ code: 0, stdout: readOutput(JSON.stringify(stateFor()), null), stderr: "" })], now)[0];
  assert.equal(undetermined.stale, null);
});

test("collectSessions merges across machines sorted newest-first (FR-PROBE-041)", () => {
  const a = stateFor({ hostname: "a" }, { session_id: "ses_old", updated_at: "2026-09-04T00:00:00Z" });
  const b = stateFor({ hostname: "b" }, { session_id: "ses_new", updated_at: "2026-09-05T00:00:00Z" });
  const statuses = classifyReads([
    { host: "alpha", result: { code: 0, stdout: readOutput(JSON.stringify(a), null), stderr: "" } },
    { host: "beta", result: { code: 0, stdout: readOutput(JSON.stringify(b), null), stderr: "" } },
  ]);
  const sessions = collectSessions(statuses);
  assert.deepEqual(
    sessions.map((s) => s.session_id),
    ["ses_new", "ses_old"],
  );
  assert.equal(sessions[0].host, "beta");
});

// -- read fan-out (FR-PROBE-030) ----------------------------------------------

test("readAllHosts reads concurrently and preserves order", async () => {
  const calls: string[] = [];
  const ssh = async (args: string[]) => {
    calls.push(args[4]);
    await new Promise((r) => setTimeout(r, 10));
    return { code: 0, stdout: readOutput(JSON.stringify(stateFor()), null), stderr: "" };
  };
  const reads = await readAllHosts(["h1", "h2", "h3"], { ssh });
  assert.deepEqual(reads.map((r) => r.host), ["h1", "h2", "h3"]);
  assert.equal(calls.length, 3);
});

test("readAllHosts honors the overall deadline and degrades to what responded (FR-PROBE-030)", async () => {
  const ssh = (args: string[]) => {
    const host = args[4];
    if (host === "slow") return new Promise<SshResult>(() => {}); // never resolves
    return Promise.resolve({ code: 0, stdout: readOutput(JSON.stringify(stateFor()), null), stderr: "" });
  };
  const t0 = Date.now();
  const reads = await readAllHosts(["fast", "slow"], { ssh, deadlineMs: 50 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `deadline not honored (took ${elapsed}ms)`);
  assert.equal(reads[0].result.code, 0);
  assert.equal(reads[1].result.code, -1);
  assert.match(reads[1].result.stderr, /deadline exceeded/);
});

test("readAllHosts captures runner errors per host without aborting (NFR-020)", async () => {
  const ssh = (args: string[]) => (args[4] === "bad" ? Promise.reject(new Error("spawn failed")) : Promise.resolve({ code: 0, stdout: "", stderr: "" }));
  const reads = await readAllHosts(["bad", "good"], { ssh, deadlineMs: 500 });
  assert.equal(reads[0].result.code, -1);
  assert.match(reads[0].result.stderr, /spawn failed/);
  assert.equal(reads[1].result.code, 0);
});

// -- health view (FR-PROBE-071) -------------------------------------------------

test("formatHealth shows reachability, last write, state, plugin version", () => {
  const a = stateFor({ written_at: "2026-09-05T11:55:00Z" });
  const text = formatHealth(
    [
      { host: "alpha", reachable: true, state: a, stateError: null, dbMtime: null, stale: false, detail: null },
      { host: "beta", reachable: false, state: null, stateError: null, dbMtime: null, stale: null, detail: "Connection timed out" },
      { host: "gamma", reachable: true, state: null, stateError: "unsupported schema", dbMtime: null, stale: null, detail: null },
    ],
    Date.parse("2026-09-05T12:00:00Z"),
  );
  assert.match(text, /HOST\s+REACHABLE\s+LAST WRITE\s+STATE\s+PLUGIN/);
  assert.match(text, /alpha\s+yes\s+2026-09-05T11:55:00Z \(5m\)\s+live\s+0\.1\.0/);
  assert.match(text, /beta\s+no/);
  assert.match(text, /gamma/);
  assert.match(text, /bad state/);
  assert.match(text, /Connection timed out/);
});

// -- picker ---------------------------------------------------------------------

test("buildPickerLines shows machine, age, branch + dirty marker, directory, title", () => {
  const lines = buildPickerLines(
    [
      {
        ...stateFor().sessions[0],
        host: "alpha",
        hostname: "alpha-host",
        machine_id: "m",
        plugin_version: "0.1.0",
        git_branch: "fix-502",
        git_dirty: true,
        updated_at: "2026-09-05T11:57:00Z",
      },
    ],
    Date.parse("2026-09-05T12:00:00Z"),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "1) alpha-host  3m  fix-502*  /d  t");
});

// -- fzf picker (FR-PROBE-080) ---------------------------------------------------

test("pickWithFzf maps the selected row back to its number; cancel gives null", async () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "bc-fzf-"));
  const bin = path.join(tmp, "bin");
  fsSync.mkdirSync(bin);
  const oldPath = process.env.PATH;
  try {
    // Selection: fake fzf echoes back the second input line.
    fsSync.writeFileSync(
      path.join(bin, "fzf"),
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nsed -n '2p'\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldPath}`;
    const choice = await pickWithFzf(["1) alpha  now  main  /a  t", "2) beta  2h  dev  /b  u", "3) gamma  1d  main  /c  v"]);
    assert.equal(choice, 2);

    // Cancel: fake fzf exits 130 with no output.
    fsSync.writeFileSync(path.join(bin, "fzf"), "#!/bin/sh\nexit 130\n", { mode: 0o755 });
    const cancelled = await pickWithFzf(["1) x"]);
    assert.equal(cancelled, null);
  } finally {
    process.env.PATH = oldPath;
    fsSync.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- shell quoting (FR-RESUME-040) ------------------------------------------------

test("shQuote single-quotes and escapes embedded single quotes", () => {
  assert.equal(shQuote("plain"), "'plain'");
  assert.equal(shQuote("a b"), "'a b'");
  assert.equal(shQuote("a'b"), `'a'\\''b'`);
  assert.equal(shQuote("$HOME `id` $(rm -rf ~)"), "'$HOME `id` $(rm -rf ~)'");
  assert.equal(shQuote("line\nbreak"), "'line\nbreak'");
});

test("launch and remote commands compose quoted values", () => {
  assert.equal(
    buildLaunchCommand("/home/dev/src/platform", "ses_9x82ndk3"),
    "cd '/home/dev/src/platform' && opencode -s 'ses_9x82ndk3'",
  );
  const dir = "/a b/c'd";
  const launch = buildLaunchCommand(dir, "ses $1 `x`");
  assert.equal(launch, "cd '/a b/c'\\''d' && opencode -s 'ses $1 `x`'");
  const remote = buildRemoteCommand(dir, "ses $1 `x`", true);
  assert.equal(remote, `tmux new -A -s ${shQuote(tmuxSessionName("ses $1 `x`"))} ${shQuote(launch)}`);
  assert.deepEqual(resumeArgs("myhost", remote), ["-t", "myhost", remote]);
});

test("composed launch command is data-safe when executed by a real shell", () => {
  // Prove the quoting survives a real sh execution: a directory full of
  // metacharacters must arrive verbatim to `opencode` as arguments.
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), "bc-quote-"));
  const dir = path.join(tmp, "my dir/it's $(boom) `tick`");
  fsSync.mkdirSync(dir, { recursive: true });
  const bin = path.join(tmp, "bin");
  fsSync.mkdirSync(bin);
  const fakeOpencode = path.join(bin, "opencode");
  fsSync.writeFileSync(
    fakeOpencode,
    "#!/bin/sh\nprintf 'CWD:%s\\nARGS:%s\\n' \"$(pwd)\" \"$*\"\n",
    { mode: 0o755 },
  );
  const sessionId = "ses_9 `id` 'quo'te";
  const remote = buildLaunchCommand(dir, sessionId);
  const r = spawnSync("sh", ["-c", remote], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines[0], `CWD:${dir}`);
  assert.equal(lines[1], `ARGS:-s ${sessionId}`);
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test("tmuxSessionName sanitizes to tmux-safe characters", () => {
  assert.equal(tmuxSessionName("ses_9x82ndk3"), "bc_ses_9x82ndk3");
  assert.equal(tmuxSessionName("weird/thing:1.2"), "bc_weird_thing_1_2");
});

// -- pre-resume git check (FR-RESUME-050/060) -------------------------------------

test("precheck command probes directory, git state, and tmux availability", () => {
  const cmd = buildPrecheckCommand("/d with space");
  assert.ok(cmd.includes("test -d '/d with space'"));
  assert.ok(cmd.includes("git -C '/d with space' rev-parse --abbrev-ref HEAD"));
  assert.ok(cmd.includes("command -v tmux"));
});

test("parsePrecheck parses the marker output", () => {
  const pc = parsePrecheck("DIR_OK\nBRANCH=main\nCOMMIT=abc123\nTMUX_OK\n");
  assert.deepEqual(pc, { dirOk: true, branch: "main", commit: "abc123", tmux: true });
  const gone = parsePrecheck("DIR_GONE\nBRANCH=\nCOMMIT=\n");
  assert.deepEqual(gone, { dirOk: false, branch: null, commit: null, tmux: false });
  const detached = parsePrecheck("DIR_OK\nBRANCH=HEAD\nCOMMIT=abc\n");
  assert.equal(detached.branch, null);
});

test("gitDiffs reports branch/commit drift, tolerates short commits (FR-RESUME-050)", () => {
  assert.deepEqual(gitDiffs({ git_branch: "main", git_commit: "a1b2c3d4" }, { branch: "main", commit: "a1b2c3d4e5f6" }), []);
  assert.deepEqual(gitDiffs({ git_branch: "main", git_commit: "a1b2c3d4e5f6" }, { branch: "main", commit: "a1b2c3d4" }), []);
  assert.deepEqual(
    gitDiffs({ git_branch: "main", git_commit: "a1b2c3d4" }, { branch: "develop", commit: "a1b2c3d4" }),
    ["branch: snapshot=main  current=develop"],
  );
  assert.deepEqual(
    gitDiffs({ git_branch: "main", git_commit: "a1b2c3d4" }, { branch: "main", commit: "deadbeef" }),
    ["commit: snapshot=a1b2c3d4  current=deadbeef"],
  );
  assert.deepEqual(
    gitDiffs({ git_branch: "main", git_commit: "a1b2c3d4" }, { branch: "main", commit: null }),
    ["commit: snapshot=a1b2c3d4  current=unavailable (not a git repo?)"],
  );
  assert.deepEqual(gitDiffs({ git_branch: null, git_commit: null }, { branch: null, commit: null }), []);
});

// -- CLI args ------------------------------------------------------------------------

test("parseArgs handles all flags", () => {
  const opts = parseArgs(["--health", "--hosts", "/h/file", "--plain", "--no-tmux", "--deadline", "5000", "--connect", "1500"]);
  assert.equal(opts.health, true);
  assert.equal(opts.hostsFile, "/h/file");
  assert.equal(opts.plain, true);
  assert.equal(opts.noTmux, true);
  assert.equal(opts.deadlineMs, 5000);
  assert.equal(opts.connectMs, 1500);
});

test("parseArgs rejects unknown flags and bad numbers", () => {
  assert.throws(() => parseArgs(["--wat"]), /unknown option/);
  assert.throws(() => parseArgs(["--hosts"]), /missing value/);
  assert.throws(() => parseArgs(["--deadline", "abc"]), /--deadline/);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("buildReadCommand is deterministic", () => {
  assert.equal(buildReadCommand(), buildReadCommand());
});

// -- keyword search ------------------------------------------------------------------

test("sessionMatches ANDs terms across machine/title/branch/dir/gist (case-insensitive)", () => {
  const s = merged();
  assert.ok(sessionMatches(s, []), "no terms matches everything");
  assert.ok(sessionMatches(s, ["ingress"]), "matches the gist");
  assert.ok(sessionMatches(s, ["auth"]), "matches the title");
  assert.ok(sessionMatches(s, ["build-01"]), "matches the machine");
  assert.ok(sessionMatches(s, ["/home/dev"]), "matches the directory");
  assert.ok(sessionMatches(s, ["INGRESS", "Auth"]), "case-insensitive AND");
  assert.ok(!sessionMatches(s, ["ingress", "kubernetes"]), "one missing term fails the AND");
  assert.ok(!sessionMatches(merged({ last_prompt: null }), ["ingress"]), "no gist, no match");
});

test("formatSessionLine appends the prompt gist only when present", () => {
  const nowMs = Date.parse("2026-09-05T12:00:00Z");
  assert.match(formatSessionLine(merged({ last_prompt: "fix ingress 502" }), nowMs), /» fix ingress 502/);
  assert.ok(!formatSessionLine(merged({ last_prompt: null }), nowMs).includes("»"));
});

test("parseArgs collects repeatable --match", () => {
  assert.deepEqual(parseArgs(["--match", "foo", "--match", "bar"]).match, ["foo", "bar"]);
  assert.deepEqual(parseArgs([]).match, []);
});

test("parseSearchArgs splits leading terms from trailing flags", () => {
  assert.deepEqual(parseSearchArgs(["ingress", "502", "--plain"]), { terms: ["ingress", "502"], flags: ["--plain"] });
  assert.deepEqual(parseSearchArgs(["auth"]), { terms: ["auth"], flags: [] });
  assert.deepEqual(parseSearchArgs(["--plain"]), { terms: [], flags: ["--plain"] });
  assert.deepEqual(parseSearchArgs([]), { terms: [], flags: [] });
});

const SEARCH_STATE = JSON.stringify({
  schema: 1,
  machine_id: "m",
  hostname: "alpha",
  written_at: "2026-09-05T12:00:00Z",
  plugin_version: "0.1.0",
  sessions: [
    { session_id: "ses_hit", title: "work", directory: "/a", git_branch: "main", git_commit: null, git_dirty: false, last_prompt: "fix the ingress 502", updated_at: "2026-09-05T12:00:00Z" },
    { session_id: "ses_miss", title: "other", directory: "/b", git_branch: "main", git_commit: null, git_dirty: false, last_prompt: "update the readme", updated_at: "2026-09-05T11:00:00Z" },
  ],
});
const SEARCH_READ = `__BC_READ__\n${SEARCH_STATE}\n__BC_SEP__\n${Math.floor(Date.parse("2026-09-05T12:00:00Z") / 1000)}\n__BC_END__\n`;
const searchNow = () => Date.parse("2026-09-05T12:00:00Z");

async function hostsFileWith(prefix: string): Promise<string> {
  const f = path.join(await fs.mkdtemp(path.join(os.tmpdir(), prefix)), "hosts");
  await fs.writeFile(f, "alpha\n");
  return f;
}

test("main search shows only matching sessions in the picker, then resumes", async () => {
  const hostsFile = await hostsFileWith("bc-search-");
  const picked: string[][] = [];
  let resumed: string[] | null = null;
  const code = await main(["search", "ingress", "--hosts", hostsFile, "--no-tmux"], {
    ssh: async (args) =>
      args.some((a) => a.includes("__BC_READ__"))
        ? { code: 0, stdout: SEARCH_READ, stderr: "" }
        : { code: 0, stdout: "DIR_OK\nBRANCH=main\nCOMMIT=\n", stderr: "" },
    pick: async (lines) => {
      picked.push(lines);
      return 1;
    },
    resume: async (args) => {
      resumed = args;
      return 0;
    },
    out: () => {},
    err: () => {},
    now: searchNow,
  });
  assert.equal(code, 0);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].length, 1, "only the matching session is offered");
  assert.match(picked[0][0], /ingress/);
  assert.ok(resumed, "resume was invoked for the match");
  assert.ok((resumed as unknown as string[]).some((a) => a.includes("ses_hit")), "resumed the matching session");
});

test("main search with no matches exits 1 with a clear message", async () => {
  const hostsFile = await hostsFileWith("bc-search-none-");
  const out: string[] = [];
  const code = await main(["search", "kubernetes", "--hosts", hostsFile], {
    ssh: async () => ({ code: 0, stdout: SEARCH_READ, stderr: "" }),
    out: (s) => out.push(s),
    err: () => {},
    now: searchNow,
  });
  assert.equal(code, 1);
  assert.match(out.join("\n"), /no sessions match: kubernetes/);
});

test("main search with no terms is a configuration error (exit 2)", async () => {
  const err: string[] = [];
  const code = await main(["search", "--plain"], { err: (s) => err.push(s) });
  assert.equal(code, 2);
  assert.match(err.join("\n"), /search needs at least one term/);
});

// -- local target (no host file / --local) -------------------------------------------

test("isLocalHost recognizes the local aliases, case-insensitively", () => {
  for (const h of ["local", "LOCAL", "localhost", "(local)"]) assert.ok(isLocalHost(h), h);
  for (const h of ["build-01", "user@host", "localish"]) assert.ok(!isLocalHost(h), h);
});

test("readLocalState formats state + db mtime like the SSH read; missing files degrade", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "bc-local-"));
  // Missing files: still a code-0 read, no state, no mtime.
  const empty = await readLocalState(home);
  assert.equal(empty.code, 0);
  assert.deepEqual(parseReadOutput(empty.stdout), { stateText: null, dbMtime: null });

  await fs.mkdir(path.join(home, ".local/share/breadcrumb"), { recursive: true });
  await fs.mkdir(path.join(home, ".local/share/opencode"), { recursive: true });
  await fs.writeFile(path.join(home, ".local/share/breadcrumb/state.json"), SEARCH_STATE);
  await fs.writeFile(path.join(home, ".local/share/opencode/opencode.db"), "x");
  const got = parseReadOutput((await readLocalState(home)).stdout);
  assert.ok(got.stateText?.includes("ses_hit"));
  assert.ok(typeof got.dbMtime === "number" && Number.isFinite(got.dbMtime));
});

test("resolveTargets: --local, missing default, empty file -> local; explicit missing -> error; hosts -> list", async () => {
  const base = parseArgs([]);
  const errs: string[] = [];
  const err = (s: string) => errs.push(s);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-targets-"));

  assert.deepEqual(await resolveTargets({ ...base, local: true }, dir, err), [LOCAL_HOST]);

  // Default file missing (not explicit) -> local, with a note.
  const missing = { ...base, hostsFile: path.join(dir, "nope"), hostsFileExplicit: false };
  assert.deepEqual(await resolveTargets(missing, dir, err), [LOCAL_HOST]);
  assert.ok(errs.join("\n").includes("reading this machine only"));

  // Explicit --hosts that cannot be read -> error (null).
  const explicit = { ...base, hostsFile: path.join(dir, "nope"), hostsFileExplicit: true } satisfies CrumbOptions;
  assert.equal(await resolveTargets(explicit, dir, err), null);

  // Empty file -> local.
  const emptyFile = path.join(dir, "empty");
  await fs.writeFile(emptyFile, "\n# just a comment\n");
  assert.deepEqual(await resolveTargets({ ...base, hostsFile: emptyFile }, dir, err), [LOCAL_HOST]);

  // Populated file -> its hosts.
  const listFile = path.join(dir, "hosts");
  await fs.writeFile(listFile, "alpha\nbeta\n");
  assert.deepEqual(await resolveTargets({ ...base, hostsFile: listFile }, dir, err), ["alpha", "beta"]);
});

test("main resumes a local session without ever touching SSH", async () => {
  let sshCalled = false;
  let resumedCmd: string | null = null;
  const code = await main(["--local", "--no-tmux"], {
    home: os.tmpdir(),
    readLocal: async () => ({ code: 0, stdout: SEARCH_READ, stderr: "" }),
    ssh: async () => {
      sshCalled = true;
      return { code: 0, stdout: "", stderr: "" };
    },
    localExec: async () => ({ code: 0, stdout: "DIR_OK\nBRANCH=main\nCOMMIT=\n", stderr: "" }),
    localResume: async (cmd) => {
      resumedCmd = cmd;
      return 0;
    },
    pick: async () => 1,
    out: () => {},
    err: () => {},
    now: searchNow,
  });
  assert.equal(code, 0);
  assert.equal(sshCalled, false, "local resume must not use ssh");
  assert.ok(resumedCmd && (resumedCmd as string).includes("opencode -s 'ses_hit'"), resumedCmd ?? "no resume");
});

// -- hosts (manage the SSH target list) ----------------------------------------------

test("parseHostsArgs: default list; actions, aliases, --hosts, and errors", () => {
  assert.equal(parseHostsArgs([], "/home/me").action, "list");
  assert.equal(parseHostsArgs([], "/home/me").file, path.join("/home/me", ".config", "breadcrumb", "hosts"));
  assert.deepEqual(parseHostsArgs(["add", "a", "b"]).targets, ["a", "b"]);
  assert.equal(parseHostsArgs(["add", "a"]).action, "add");
  assert.equal(parseHostsArgs(["rm", "a"]).action, "remove");
  assert.equal(parseHostsArgs(["remove", "a"]).action, "remove");
  assert.equal(parseHostsArgs(["--hosts", "/x", "list"]).file, "/x");
  assert.equal(parseHostsArgs(["--help"]).help, true);
  assert.throws(() => parseHostsArgs(["bogusaction"]), /unknown hosts action/);
  assert.throws(() => parseHostsArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseHostsArgs(["--hosts"]), /missing value/);
});

async function tmpHostsFile(prefix: string, content?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, "hosts");
  if (content !== undefined) await fs.writeFile(file, content);
  return file;
}

test("runHosts add creates the file, appends, and dedupes", async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bc-hosts-add-")), "sub", "hosts");
  const out: string[] = [];
  assert.equal(await runHosts(["add", "build-01", "office-mac", "--hosts", file], { out: (s) => out.push(s) }), 0);
  assert.deepEqual(parseHosts(await fs.readFile(file, "utf8")), ["build-01", "office-mac"]);
  out.length = 0;
  assert.equal(await runHosts(["add", "build-01", "devbox", "--hosts", file], { out: (s) => out.push(s) }), 0);
  assert.deepEqual(parseHosts(await fs.readFile(file, "utf8")), ["build-01", "office-mac", "devbox"]);
  assert.match(out.join("\n"), /added devbox \(already present: build-01\)/);
});

test("runHosts remove deletes matching targets and preserves comments/blanks", async () => {
  const file = await tmpHostsFile("bc-hosts-rm-", "# my machines\nbuild-01\n\noffice-mac\ndevbox\n");
  const out: string[] = [];
  assert.equal(await runHosts(["remove", "office-mac", "ghost", "--hosts", file], { out: (s) => out.push(s) }), 0);
  const raw = await fs.readFile(file, "utf8");
  assert.ok(raw.includes("# my machines"), "comment preserved");
  assert.deepEqual(parseHosts(raw), ["build-01", "devbox"]);
  assert.match(out.join("\n"), /removed office-mac \(not found: ghost\)/);
});

test("runHosts list shows targets; empty/missing explains local-only", async () => {
  const withHosts = await tmpHostsFile("bc-hosts-list-", "alpha\nbeta\n");
  const out: string[] = [];
  assert.equal(await runHosts(["list", "--hosts", withHosts], { out: (s) => out.push(s) }), 0);
  assert.deepEqual(out, ["1) alpha", "2) beta"]);

  const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bc-hosts-none-")), "hosts");
  const out2: string[] = [];
  assert.equal(await runHosts([], { out: (s) => out2.push(s), home: path.dirname(path.dirname(path.dirname(missing))) }), 0);
  // default file under a fresh home is absent → local-only message
  assert.match(out2.join("\n"), /reads this machine only/);
});

test("runHosts path prints the file location; invalid targets are rejected", async () => {
  const out: string[] = [];
  assert.equal(await runHosts(["path", "--hosts", "/tmp/x/hosts"], { out: (s) => out.push(s) }), 0);
  assert.deepEqual(out, ["/tmp/x/hosts"]);
  const err: string[] = [];
  assert.equal(await runHosts(["add", "bad host", "--hosts", "/tmp/x/hosts"], { err: (s) => err.push(s) }), 2);
  assert.match(err.join("\n"), /invalid host target/);
});

test("main hosts routes to runHosts", async () => {
  const file = await tmpHostsFile("bc-hosts-main-", "alpha\n");
  const out: string[] = [];
  assert.equal(await main(["hosts", "list", "--hosts", file], { out: (s) => out.push(s) }), 0);
  assert.deepEqual(out, ["1) alpha"]);
});

// -- clean (prune this machine's state) ----------------------------------------------

function sess(id: string): SessionSnapshot {
  return {
    session_id: id,
    title: null,
    directory: "/tmp",
    git_branch: null,
    git_commit: null,
    git_dirty: false,
    updated_at: "2026-09-06T12:00:00Z",
  };
}

async function writeLocalState(prefix: string, sessions: SessionSnapshot[]): Promise<{ home: string; file: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = path.join(home, ".local", "share", "breadcrumb");
  await fs.mkdir(dir, { recursive: true });
  const state = { schema: 1, machine_id: "m", hostname: "h", written_at: "2026-09-06T12:00:00Z", plugin_version: "0.1.0", sessions };
  const file = path.join(dir, "state.json");
  await fs.writeFile(file, JSON.stringify(state, null, 2));
  return { home, file };
}

test("isOpencodeSessionId accepts ses_ ids and rejects artifacts", () => {
  assert.ok(isOpencodeSessionId("ses_abc"));
  assert.ok(!isOpencodeSessionId("msg_abc"));
  assert.ok(!isOpencodeSessionId("prt_x"));
  assert.ok(!isOpencodeSessionId(""));
});

test("parseCleanArgs handles --all/--dry-run; rejects unknown", () => {
  assert.deepEqual(parseCleanArgs([]), { all: false, dryRun: false, help: false });
  assert.deepEqual(parseCleanArgs(["--all", "-n"]), { all: true, dryRun: true, help: false });
  assert.equal(parseCleanArgs(["--help"]).help, true);
  assert.throws(() => parseCleanArgs(["--nope"]), /unknown option/);
});

test("planClean drops non-ses_ artifacts by default; --all drops everything", () => {
  const sessions = [sess("ses_1"), sess("msg_2"), sess("ses_3"), sess("msg_4")];
  const invalid = planClean(sessions, false);
  assert.deepEqual(invalid.kept.map((s) => s.session_id), ["ses_1", "ses_3"]);
  assert.deepEqual(invalid.removed.map((s) => s.session_id), ["msg_2", "msg_4"]);
  const all = planClean(sessions, true);
  assert.equal(all.kept.length, 0);
  assert.equal(all.removed.length, 4);
});

test("runClean removes artifacts, keeps real sessions, leaves no temp files", async () => {
  const { home, file } = await writeLocalState("bc-clean-", [sess("ses_a"), sess("msg_b"), sess("ses_c"), sess("msg_d")]);
  const out: string[] = [];
  const code = await runClean([], { home, out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(after.sessions.map((s: SessionSnapshot) => s.session_id), ["ses_a", "ses_c"]);
  assert.match(out.join("\n"), /removed 2 entries, kept 2/);
  const entries = await fs.readdir(path.dirname(file));
  assert.deepEqual(entries.filter((e) => e.includes("tmp")), []);
});

test("runClean --dry-run writes nothing", async () => {
  const { home, file } = await writeLocalState("bc-clean-dry-", [sess("ses_a"), sess("msg_b")]);
  const before = await fs.readFile(file, "utf8");
  const out: string[] = [];
  const code = await runClean(["--dry-run"], { home, out: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.equal(await fs.readFile(file, "utf8"), before, "file untouched");
  assert.match(out.join("\n"), /would remove 1 entry, keep 1/);
});

test("runClean --all empties the session list", async () => {
  const { home, file } = await writeLocalState("bc-clean-all-", [sess("ses_a"), sess("ses_b")]);
  const code = await runClean(["--all"], { home, out: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).sessions, []);
});

test("runClean with no state file is a no-op (exit 0)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "bc-clean-none-"));
  const out: string[] = [];
  const code = await runClean([], { home, out: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /nothing to clean/);
});

test("main clean routes to runClean", async () => {
  const { home } = await writeLocalState("bc-clean-main-", [sess("ses_a"), sess("msg_b")]);
  const out: string[] = [];
  const code = await main(["clean", "--dry-run"], { home, out: (s) => out.push(s) });
  assert.equal(code, 0);
  assert.match(out.join("\n"), /would remove 1 entry/);
});

test("a `local` entry mixes this machine (direct) with SSH hosts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-mix-"));
  const hostsFile = path.join(dir, "hosts");
  await fs.writeFile(hostsFile, "local\nalpha\n");
  let localReads = 0;
  const sshHosts: string[] = [];
  const code = await main(["health", "--hosts", hostsFile], {
    home: dir,
    readLocal: async () => {
      localReads++;
      return { code: 0, stdout: SEARCH_READ, stderr: "" };
    },
    ssh: async (args) => {
      sshHosts.push(args[args.length - 2]); // host is second-to-last arg
      return { code: 0, stdout: SEARCH_READ, stderr: "" };
    },
    out: () => {},
    err: () => {},
    now: searchNow,
  });
  assert.equal(localReads, 1, "local read once");
  assert.deepEqual(sshHosts, ["alpha"], "alpha read over ssh, local was not");
  assert.equal(code, 0);
});

// -- command dispatch ----------------------------------------------------------------

test("splitCommand peels a leading subcommand, else defaults to resume", () => {
  assert.deepEqual(splitCommand(["health", "--hosts", "/h"]), { cmd: "health", rest: ["--hosts", "/h"] });
  assert.deepEqual(splitCommand(["install", "--dest", "/d"]), { cmd: "install", rest: ["--dest", "/d"] });
  assert.deepEqual(splitCommand(["resume", "--plain"]), { cmd: "resume", rest: ["--plain"] });
  // No subcommand: everything is resume args (flags never look like commands).
  assert.deepEqual(splitCommand(["--plain", "--no-tmux"]), { cmd: "resume", rest: ["--plain", "--no-tmux"] });
  assert.deepEqual(splitCommand(["--help"]), { cmd: "resume", rest: ["--help"] });
  assert.deepEqual(splitCommand([]), { cmd: "resume", rest: [] });
});

test("main routes `health` through the resume path's --health alias", async () => {
  let sawHealthFlag = false;
  // A fake ssh that records nothing but returns unreachable; --health prints a
  // table and exits 1 when a host is unreachable.
  const lines: string[] = [];
  const hostsFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bc-disp-")), "hosts");
  await fs.writeFile(hostsFile, "h1\n");
  const code = await main(["health", "--hosts", hostsFile], {
    ssh: async (args) => {
      if (args.some((a) => a.includes("__BC_READ__"))) sawHealthFlag = true;
      return { code: 255, stdout: "", stderr: "down" };
    },
    out: (s) => lines.push(s),
    err: () => {},
    now: () => Date.parse("2026-09-05T12:00:00Z"),
  });
  assert.equal(sawHealthFlag, true, "health must trigger the read fan-out");
  assert.equal(code, 1, "unreachable host -> exit 1");
  assert.ok(lines.join("\n").includes("HOST"), "health table printed");
});

// -- install / enrollment ------------------------------------------------------------

test("PLUGIN_SOURCES copies the plugin and the shared module it imports", () => {
  assert.deepEqual(PLUGIN_SOURCES.map(([, to]) => to), ["breadcrumb.ts", "shared/state.ts"]);
});

test("defaultPluginDir resolves under the given home", () => {
  assert.equal(defaultPluginDir("/home/me"), path.join("/home/me", ".config", "opencode", "plugins"));
});

test("parseInstallArgs handles --dest and --help; rejects unknown", () => {
  assert.deepEqual(parseInstallArgs(["--dest", "/d"]), { dest: "/d", help: false });
  assert.equal(parseInstallArgs(["--help"]).help, true);
  assert.throws(() => parseInstallArgs(["--dest"]), /missing value/);
  assert.throws(() => parseInstallArgs(["--nope"]), /unknown option/);
});

test("installPlugin copies both files into the destination (installed layout)", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "bc-inst-"));
  const log: string[] = [];
  const res = await installPlugin({ dest, log: (s) => log.push(s) });
  assert.equal(res.dest, dest);
  assert.deepEqual(res.installed, ["breadcrumb.ts", "shared/state.ts"]);
  assert.ok((await fs.stat(path.join(dest, "breadcrumb.ts"))).isFile());
  assert.ok((await fs.stat(path.join(dest, "shared", "state.ts"))).isFile());
  assert.deepEqual(log, ["installed breadcrumb.ts", "installed shared/state.ts"]);
});

test("main install routes to installPlugin and reports the destination", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "bc-main-inst-"));
  const out: string[] = [];
  const code = await main(["install", "--dest", dest], { out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  assert.ok((await fs.stat(path.join(dest, "breadcrumb.ts"))).isFile());
  assert.ok(out.join("\n").includes(dest), "reports where it enrolled");
});
