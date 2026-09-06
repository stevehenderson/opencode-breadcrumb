import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLaunchCommand,
  buildPickerLines,
  buildPrecheckCommand,
  buildReadCommand,
  buildRemoteCommand,
  classifyReads,
  collectSessions,
  formatHealth,
  gitDiffs,
  parseArgs,
  parseHosts,
  parsePrecheck,
  parseReadOutput,
  pickWithFzf,
  readAllHosts,
  readHostArgs,
  resumeArgs,
  shQuote,
  tmuxSessionName,
  type HostRead,
  type SshResult,
} from "../probe/crumb.ts";
import { type BreadcrumbState } from "../shared/state.ts";

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
