// End-to-end probe tests (BRC-SPEC-002 §7): run the real crumb CLI as a
// subprocess with a fake `ssh` on PATH, so the full read-fan-out -> merge ->
// picker -> precheck -> resume path executes for real (including real git on
// the pre-check round).

import { after, before, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crumbPath = path.join(repoRoot, "probe", "crumb.ts");

// Fake ssh:
//  - read round (command contains __BC_READ__): emits canned marker output
//    from env vars; "beta" is unreachable when BC_FAKE_BETA_DOWN=1.
//  - precheck round (command contains "test -d"): executes the command
//    locally, so real directories and real git answer.
//  - resume round (ssh -t <host> <cmd>): logs host+cmd, exits 0.
//  - every invocation's arg list is appended to $BC_FAKE_SSH_ARGS.
const FAKE_SSH = [
  "#!/bin/bash",
  "printf '%s\\n' \"$*\" >> \"${BC_FAKE_SSH_ARGS:-/dev/null}\"",
  "host=\"\"",
  "last=\"\"",
  "skip=0",
  "for a in \"$@\"; do",
  "  if [ \"$skip\" = \"1\" ]; then skip=0; continue; fi",
  "  case \"$a\" in",
  "    -o) skip=1 ;;",
  "    -*) ;;",
  "    *) host=\"${host:-$a}\"; last=\"$a\" ;;",
  "  esac",
  "done",
  "if [[ \"$last\" == *\"__BC_READ__\"* ]]; then",
  "  if [[ \"$host\" == \"beta\" && \"${BC_FAKE_BETA_DOWN:-0}\" == \"1\" ]]; then",
  "    echo \"beta: Connection timed out\" >&2",
  "    exit 255",
  "  fi",
  "  printf '__BC_READ__\\n'",
  "  cat \"${BC_FAKE_ALPHA_STATE:-/nonexistent}\" 2>/dev/null",
  "  printf '\\n__BC_SEP__\\n'",
  "  if [[ -n \"${BC_FAKE_DB_MTIME:-}\" ]]; then printf '%s\\n' \"$BC_FAKE_DB_MTIME\"; fi",
  "  printf '__BC_END__\\n'",
  "  exit 0",
  "fi",
  "if [[ \"$last\" == *\"test -d\"* ]]; then",
  "  exec sh -c \"$last\"",
  "fi",
  "printf 'RESUME host=%s cmd=%s\\n' \"$host\" \"$last\" >> \"${BC_FAKE_SSH_LOG:-/dev/null}\"",
  "exit 0",
].join("\n") + "\n";

interface E2EEnv {
  tmp: string;
  hostsFile: string;
  logFile: string;
  argsFile: string;
  stateFile: string;
  env: NodeJS.ProcessEnv;
}

async function makeEnv(stateJson: string, dbMtime: number | "now" | null = "now"): Promise<E2EEnv> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bc-e2e-"));
  const bin = path.join(tmp, "bin");
  await fs.mkdir(bin);
  const hostsFile = path.join(tmp, "hosts");
  const logFile = path.join(tmp, "ssh.log");
  const argsFile = path.join(tmp, "ssh.args");
  const stateFile = path.join(tmp, "alpha-state.json");
  await fs.writeFile(hostsFile, "# fleet\nalpha\nbeta\n");
  await fs.writeFile(stateFile, stateJson);
  await fs.writeFile(path.join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  const mtime = dbMtime === null ? "" : dbMtime === "now" ? String(Math.floor(Date.now() / 1000)) : String(dbMtime);
  return {
    tmp,
    hostsFile,
    logFile,
    argsFile,
    stateFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BC_FAKE_SSH_LOG: logFile,
      BC_FAKE_SSH_ARGS: argsFile,
      BC_FAKE_ALPHA_STATE: stateFile,
      BC_FAKE_DB_MTIME: mtime,
      BC_FAKE_BETA_DOWN: "1",
    },
  };
}

function runGit(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeGitRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "bc-e2e-repo-"));
  runGit(repo, ["init"]);
  runGit(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  runGit(repo, ["config", "user.email", "e2e@test.local"]);
  runGit(repo, ["config", "user.name", "e2e"]);
  await fs.writeFile(path.join(repo, "hello.txt"), "hello\n");
  runGit(repo, ["add", "hello.txt"]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

let repo: string | undefined;
let gitAvailable = true;
const now = new Date().toISOString();
const older = new Date(Date.now() - 3600_000).toISOString();

function skipIfNoGit(t: { skip: (msg?: string) => void }): boolean {
  if (!gitAvailable || !repo) {
    t.skip("git not available");
    return true;
  }
  return false;
}

before(async () => {
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    gitAvailable = false;
    return;
  }
  repo = await makeGitRepo();
});

after(async () => {
  if (repo) await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

function alphaState(opts: {
  repo: string;
  branch: string;
  commit: string;
  snapshotBranch?: string;
  schema?: number;
  goneDir: string;
}): string {
  return JSON.stringify(
    {
      schema: opts.schema ?? 1,
      machine_id: "11111111-2222-4333-8444-555555555555",
      hostname: "alpha-host",
      written_at: now,
      plugin_version: "0.1.0",
      sessions: [
        {
          session_id: "ses_new",
          title: "newer work",
          directory: opts.repo,
          git_branch: opts.snapshotBranch ?? opts.branch,
          git_commit: opts.commit,
          git_dirty: false,
          updated_at: now,
        },
        {
          session_id: "ses_old",
          title: "older work",
          directory: opts.goneDir,
          git_branch: null,
          git_commit: null,
          git_dirty: false,
          updated_at: older,
        },
      ],
    },
    null,
    2,
  );
}

function runCrumbCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [crumbPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.stdin.end(stdin);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await fs.readFile(file, "utf8")).split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

test("crumb --health: live host and unreachable host; exit 1 (FR-PROBE-071/031)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-health`);
  const e = await makeEnv(alphaState({ repo: repo!, branch: "main", commit: "", goneDir: gone }));
  const r = await runCrumbCli(["--health", "--hosts", e.hostsFile], e.env);
  assert.equal(r.code, 1, `expected exit 1 (beta down), got ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /HOST\s+REACHABLE\s+LAST WRITE\s+STATE\s+PLUGIN/);
  assert.match(r.stdout, /alpha\s+yes\s+.*\s+live\s+0\.1\.0/);
  assert.match(r.stdout, /beta\s+no\s+—/);
  assert.match(r.stdout, /Connection timed out/);
});

test("crumb --health: STALE when opencode.db is >1h newer (FR-PROBE-070)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-stale`);
  const e = await makeEnv(
    alphaState({ repo: repo!, branch: "main", commit: "", goneDir: gone }),
    Math.floor(Date.now() / 1000) + 2 * 3600,
  );
  const r = await runCrumbCli(["--health", "--hosts", e.hostsFile], e.env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /alpha\s+yes\s+.*\s+STALE\s+0\.1\.0/);
});

test("crumb: resumes selection over ssh -t with quoted launch (FR-RESUME-010/020/040)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-resume`);
  const commit = runGit(repo!, ["rev-parse", "HEAD"]);
  const e = await makeEnv(alphaState({ repo: repo!, branch: "main", commit, goneDir: gone }));
  const r = await runCrumbCli(["--plain", "--no-tmux", "--hosts", e.hostsFile], e.env, "1\n");
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(`resuming ses_new on alpha — ${repo}`), r.stdout);
  const log = await readLines(e.logFile);
  assert.equal(log.length, 1);
  assert.ok(log[0].includes(`RESUME host=alpha cmd=cd '${repo}' && opencode -s 'ses_new'`), log[0]);
});

test("crumb: read round uses BatchMode ssh with ConnectTimeout (FR-PROBE-021)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-args`);
  const e = await makeEnv(alphaState({ repo: repo!, branch: "main", commit: "", goneDir: gone }));
  await runCrumbCli(["--health", "--hosts", e.hostsFile], e.env);
  const argLines = await readLines(e.argsFile);
  const readRounds = argLines.filter((l) => l.includes("__BC_READ__"));
  assert.equal(readRounds.length, 2, `expected 2 read rounds, got: ${argLines.join(" | ")}`);
  for (const round of readRounds) {
    assert.match(round, /^-o BatchMode=yes -o ConnectTimeout=3 (alpha|beta) /, round);
  }
  assert.ok(readRounds.some((l) => l.includes(" alpha ")), "missing alpha read round");
  assert.ok(readRounds.some((l) => l.includes(" beta ")), "missing beta read round");
});

test("crumb: empty selection exits non-zero, no side effects (FR-PROBE-081)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-cancel`);
  const e = await makeEnv(alphaState({ repo: repo!, branch: "main", commit: "", goneDir: gone }));
  const r = await runCrumbCli(["--plain", "--no-tmux", "--hosts", e.hostsFile], e.env, "");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /selection cancelled/);
  assert.deepEqual(await readLines(e.logFile), []);
});

test("crumb: git drift shown and confirmed; repo untouched (FR-RESUME-050)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-drift`);
  const commit = runGit(repo!, ["rev-parse", "HEAD"]);
  const e = await makeEnv(
    alphaState({ repo: repo!, branch: "main", commit, snapshotBranch: "old-branch", goneDir: gone }),
  );
  const before = await fs.readFile(path.join(repo!, "hello.txt"), "utf8");

  const declined = await runCrumbCli(["--plain", "--no-tmux", "--hosts", e.hostsFile], e.env, "1\nn\n");
  assert.equal(declined.code, 1, `${declined.stdout}\n${declined.stderr}`);
  assert.match(declined.stdout, /git state on the machine differs from the last snapshot/);
  assert.match(declined.stdout, /branch: snapshot=old-branch  current=main/);
  assert.match(declined.stdout, /will not checkout, stash, or clean/);
  assert.deepEqual(await readLines(e.logFile), []);

  const accepted = await runCrumbCli(["--plain", "--no-tmux", "--hosts", e.hostsFile], e.env, "1\ny\n");
  assert.equal(accepted.code, 0, `${accepted.stdout}\n${accepted.stderr}`);
  const log = await readLines(e.logFile);
  assert.equal(log.length, 1);
  assert.ok(log[0].includes("RESUME host=alpha cmd=cd"), log[0]);
  assert.equal(await fs.readFile(path.join(repo!, "hello.txt"), "utf8"), before, "crumb must not mutate the repo");
});

test("crumb: gone directory reported specifically, manual fallback (FR-RESUME-060)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-gone`);
  const commit = runGit(repo!, ["rev-parse", "HEAD"]);
  const e = await makeEnv(alphaState({ repo: repo!, branch: "main", commit, goneDir: gone }));
  const r = await runCrumbCli(["--plain", "--no-tmux", "--hosts", e.hostsFile], e.env, "2\n");
  assert.equal(r.code, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, new RegExp(`directory ${gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not exist on alpha`));
  assert.match(r.stderr, /manual/);
  assert.deepEqual(await readLines(e.logFile), []);
});

test("crumb: unknown schema rejected, shown as bad state (FR-PROBE-040)", async (t) => {
  if (skipIfNoGit(t)) return;
  const gone = path.join(os.tmpdir(), `bc-e2e-gone-${process.pid}-schema`);
  const e = await makeEnv(
    alphaState({ repo: repo!, branch: "main", commit: "", schema: 2, goneDir: gone }),
  );
  const r = await runCrumbCli(["--plain", "--hosts", e.hostsFile], e.env, "");
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no sessions found on any reachable host/);
  assert.match(r.stdout, /bad state/);
  assert.match(r.stdout, /unsupported schema/);
});
