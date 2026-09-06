#!/usr/bin/env node
// crumb — Breadcrumb probe (BRC-SPEC-002 §7).
//
// Laptop-side CLI. One run reads every enrolled machine's state file over the
// system ssh binary (BatchMode, time-bounded, concurrent, overall deadline),
// merges and sorts the snapshots, checks liveness, presents a picker (fzf or a
// numbered fallback), and resumes the selection over an interactive SSH TTY,
// wrapped in a named tmux session when available.
//
// Runs on Node >= 23.6 (native TypeScript) or Bun. No build step, no
// dependencies beyond node: builtins and the system ssh/git/fzf/tmux binaries.

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type BreadcrumbState,
  type MergedSession,
  type SessionSnapshot,
  mergeSessions,
  parseState,
  relativeAge,
} from "../shared/state.ts";

const DEFAULT_DEADLINE_MS = 10_000; // FR-PROBE-030 (OI-3)
const DEFAULT_CONNECT_MS = 3_000; // FR-PROBE-021 (OI-3)
const STALE_AFTER_MS = 60 * 60 * 1000; // FR-PROBE-070 (OI-3)
const READ_MARKER = "__BC_READ__";
const READ_SEP = "__BC_SEP__";

// ---------------------------------------------------------------------------
// SSH transport (FR-PROBE-020/021): system ssh only.

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SshRunner = (args: string[]) => Promise<SshResult>;

export function systemSsh(): SshRunner {
  return (args) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          resolve({ code: -1, stdout, stderr: (stderr ? stderr + "\n" : "") + err.message });
        }
      });
      child.on("close", (code, signal) => {
        if (!settled) {
          settled = true;
          resolve({ code: code ?? -1, stdout, stderr: signal ? `terminated by ${signal}` : stderr });
        }
      });
    });
}

// ---------------------------------------------------------------------------
// Host list (FR-PROBE-010)

export function defaultHostsFile(home: string = homedir()): string {
  return path.join(home, ".config", "breadcrumb", "hosts");
}

export function expandHome(file: string, home: string = homedir()): string {
  if (file === "~") return home;
  if (file.startsWith("~/")) return path.join(home, file.slice(2));
  return file;
}

/** One SSH target per line; blank lines and # comments are ignored. */
export function parseHosts(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export async function readHostsFile(file: string, home: string = homedir()): Promise<string[]> {
  const text = await fs.readFile(expandHome(file, home), "utf8");
  return parseHosts(text);
}

// ---------------------------------------------------------------------------
// Read fan-out (FR-PROBE-021/030/031, FR-PROBE-070's same-round db mtime)

export function buildReadCommand(): string {
  return [
    `printf '${READ_MARKER}\\n'`,
    "cat \"$HOME/.local/share/breadcrumb/state.json\" 2>/dev/null",
    `printf '\\n${READ_SEP}\\n'`,
    "{ stat -c %Y \"$HOME/.local/share/opencode/opencode.db\" 2>/dev/null || stat -f %m \"$HOME/.local/share/opencode/opencode.db\" 2>/dev/null || true; }",
  ].join("; ");
}

export function readHostArgs(host: string, connectMs: number): string[] {
  const seconds = Math.max(1, Math.round(connectMs / 1000));
  return ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${seconds}`, host, buildReadCommand()];
}

export interface ParsedRead {
  stateText: string | null;
  dbMtime: number | null; // epoch seconds
}

export function parseReadOutput(raw: string): ParsedRead {
  const start = raw.indexOf(READ_MARKER);
  if (start === -1) return { stateText: null, dbMtime: null };
  const afterMarker = raw.slice(start + READ_MARKER.length);
  const sep = afterMarker.indexOf(READ_SEP);
  const text = (sep === -1 ? afterMarker : afterMarker.slice(0, sep)).trim();
  if (sep === -1) return { stateText: text.length > 0 ? text : null, dbMtime: null };
  const tail = afterMarker.slice(sep + READ_SEP.length).trim();
  const mtime = tail === "" ? NaN : Number(tail);
  return { stateText: text.length > 0 ? text : null, dbMtime: Number.isFinite(mtime) ? mtime : null };
}

export interface HostRead {
  host: string;
  result: SshResult;
}

export interface ReadAllOptions {
  connectMs?: number;
  deadlineMs?: number;
  ssh?: SshRunner;
}

/**
 * Read all hosts concurrently; bound total wait by the overall deadline and
 * degrade to whatever responded (FR-PROBE-030).
 */
export async function readAllHosts(hosts: string[], opts: ReadAllOptions = {}): Promise<HostRead[]> {
  const { connectMs = DEFAULT_CONNECT_MS, deadlineMs = DEFAULT_DEADLINE_MS, ssh = systemSsh() } = opts;
  const out: (HostRead | undefined)[] = hosts.map(() => undefined);
  let remaining = hosts.length;
  let finished = false;
  const flush = (): HostRead[] =>
    hosts.map((host, i) => out[i] ?? { host, result: { code: -1, stdout: "", stderr: "deadline exceeded" } });
  const result = await new Promise<HostRead[]>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(flush());
    };
    const timer = setTimeout(finish, deadlineMs);
    timer.unref?.();
    hosts.forEach((host, i) => {
      ssh(readHostArgs(host, connectMs))
        .then((r) => {
          out[i] = { host, result: r };
          if (--remaining === 0) finish();
        })
        .catch((e: unknown) => {
          out[i] = { host, result: { code: -1, stdout: "", stderr: String(e) } };
          if (--remaining === 0) finish();
        });
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Classification: reachable / parse / liveness (FR-PROBE-040/070/071/031)

export interface HostStatus {
  host: string;
  reachable: boolean;
  state: BreadcrumbState | null;
  /** Why there is no usable state on a reachable host (bad schema, no file). */
  stateError: string | null;
  dbMtime: number | null;
  /** Plugin presumed dead: opencode.db materially newer than state file. Null = undetermined. */
  stale: boolean | null;
  detail: string | null;
}

function firstLine(s: string): string | null {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
  return line ?? null;
}

export function classifyReads(reads: HostRead[], nowMs: number = Date.now()): HostStatus[] {
  void nowMs;
  return reads.map(({ host, result }) => {
    if (result.code !== 0) {
      return {
        host,
        reachable: false,
        state: null,
        stateError: null,
        dbMtime: null,
        stale: null,
        detail: firstLine(result.stderr) ?? `ssh exit ${result.code}`,
      };
    }
    const { stateText, dbMtime } = parseReadOutput(result.stdout);
    if (stateText === null) {
      return { host, reachable: true, state: null, stateError: "no state file", dbMtime, stale: null, detail: null };
    }
    let state: BreadcrumbState | null = null;
    let stateError: string | null = null;
    try {
      state = parseState(stateText, { skipBadEntries: true });
    } catch (e) {
      stateError = (e as Error).message;
    }
    let stale: boolean | null = null;
    if (state !== null && dbMtime !== null) {
      const writtenMs = Date.parse(state.written_at);
      if (!Number.isNaN(writtenMs)) stale = dbMtime * 1000 - writtenMs > STALE_AFTER_MS;
    }
    return { host, reachable: true, state, stateError, dbMtime, stale, detail: null };
  });
}

/** Merge all reachable, parseable machines into one sorted list (FR-PROBE-040/041). */
export function collectSessions(statuses: HostStatus[]): MergedSession[] {
  return mergeSessions(
    statuses.filter((s): s is HostStatus & { state: BreadcrumbState } => s.state !== null).map((s) => ({
      host: s.host,
      state: s.state,
    })),
  );
}

// ---------------------------------------------------------------------------
// Health view (FR-PROBE-071)

export function formatHealth(statuses: HostStatus[], nowMs: number = Date.now()): string {
  const header =
    "HOST\tREACHABLE\tLAST WRITE\tSTATE\tPLUGIN\n";
  const lines = statuses.map((s) => {
    const reachable = s.reachable ? "yes" : "no";
    const lastWrite =
      s.state !== null ? `${s.state.written_at} (${relativeAge(s.state.written_at, nowMs)})` : "—";
    let stateMark = "—";
    if (s.reachable) {
      if (s.state === null) stateMark = s.stateError === "no state file" ? "no state" : "bad state";
      else stateMark = s.stale === null ? "live?" : s.stale ? "STALE" : "live";
    }
    return `${s.host}\t${reachable}\t${lastWrite}\t${stateMark}\t${s.state?.plugin_version ?? "—"}`;
  });
  const notes = statuses
    .filter((s) => s.detail !== null || (s.stateError !== null && s.stateError !== "no state file"))
    .map((s) => `  ${s.host}: ${s.detail ?? s.stateError ?? ""}`);
  return header + lines.join("\n") + (notes.length > 0 ? "\n" + notes.join("\n") : "");
}

// ---------------------------------------------------------------------------
// Picker (FR-PROBE-080/081)

/** One picker row: machine, age, branch + dirty marker, directory, title. */
export function formatSessionLine(s: MergedSession, nowMs: number = Date.now()): string {
  const branch = s.git_branch ?? "no-branch";
  const dirty = s.git_dirty ? "*" : "";
  const title = s.title ?? "(untitled)";
  const machine = s.hostname !== "" ? s.hostname : s.host;
  return `${machine}  ${relativeAge(s.updated_at, nowMs)}  ${branch}${dirty}  ${s.directory}  ${title}`;
}

export function buildPickerLines(sessions: MergedSession[], nowMs: number = Date.now()): string[] {
  return sessions.map((s, i) => `${i + 1}) ${formatSessionLine(s, nowMs)}`);
}

function fzfAvailable(): boolean {
  const r = spawnSync("fzf", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0;
}

/**
 * Interactive fzf picker. Returns the 1-based row number, or null on
 * cancel/EOF (FR-PROBE-081).
 */
export function pickWithFzf(lines: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("fzf", ["--height", "40%", "--prompt", "session> "], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
      if (!line) return resolve(null);
      const m = /^\s*(\d+)\)\s/.exec(line);
      resolve(m ? Number(m[1]) : null);
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

// ---------------------------------------------------------------------------
// Resume (FR-RESUME-010…060)

/** POSIX shell single-quoting (FR-RESUME-040): values are data, never code. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** FR-RESUME-020 default launch (confirmed against opencode 1.18.x, OI-1). */
export function buildLaunchCommand(dir: string, sessionId: string): string {
  return `cd ${shQuote(dir)} && opencode -s ${shQuote(sessionId)}`;
}

/** tmux session name, sanitized to tmux's allowed character set. */
export function tmuxSessionName(sessionId: string): string {
  return "bc_" + sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** FR-RESUME-030: wrap in a named tmux session so drops detach, not kill. */
export function buildRemoteCommand(dir: string, sessionId: string, useTmux: boolean): string {
  const launch = buildLaunchCommand(dir, sessionId);
  if (!useTmux) return launch;
  return `tmux new -A -s ${shQuote(tmuxSessionName(sessionId))} ${shQuote(launch)}`;
}

export function resumeArgs(host: string, remoteCommand: string): string[] {
  return ["-t", host, remoteCommand];
}

export type ResumeRunner = (args: string[]) => Promise<number>;

export function systemResume(): ResumeRunner {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn("ssh", args, { stdio: "inherit" });
      child.on("error", (err: Error) => {
        console.error(`crumb: ssh failed: ${err.message}`);
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
}

export interface Precheck {
  dirOk: boolean;
  branch: string | null;
  commit: string | null;
  tmux: boolean;
}

export function buildPrecheckCommand(dir: string): string {
  const d = shQuote(dir);
  return [
    `test -d ${d} && printf 'DIR_OK\\n' || printf 'DIR_GONE\\n'`,
    `b=$(git -C ${d} rev-parse --abbrev-ref HEAD 2>/dev/null) || b=''`,
    `c=$(git -C ${d} rev-parse HEAD 2>/dev/null) || c=''`,
    `printf 'BRANCH=%s\\nCOMMIT=%s\\n' "$b" "$c"`,
    "command -v tmux >/dev/null 2>&1 && printf 'TMUX_OK\\n' || true",
  ].join("; ");
}

export function precheckArgs(host: string, dir: string, connectMs: number): string[] {
  const seconds = Math.max(1, Math.round(connectMs / 1000));
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${seconds}`,
    host,
    buildPrecheckCommand(dir),
  ];
}

export function parsePrecheck(raw: string): Precheck {
  const branch = /^BRANCH=(.*)$/m.exec(raw)?.[1]?.trim();
  const commit = /^COMMIT=(.*)$/m.exec(raw)?.[1]?.trim();
  return {
    dirOk: raw.includes("DIR_OK"),
    branch: branch !== undefined && branch !== "" && branch !== "HEAD" ? branch : null,
    commit: commit !== undefined && commit !== "" ? commit : null,
    tmux: raw.includes("TMUX_OK"),
  };
}

/** FR-RESUME-050: how the snapshot's git state differs from the current one. */
export function gitDiffs(
  snap: Pick<SessionSnapshot, "git_branch" | "git_commit">,
  cur: { branch: string | null; commit: string | null },
): string[] {
  const diffs: string[] = [];
  if (snap.git_branch !== cur.branch) {
    diffs.push(`branch: snapshot=${snap.git_branch ?? "—"}  current=${cur.branch ?? "—"}`);
  }
  const a = snap.git_commit;
  const b = cur.commit;
  if (a !== null && b !== null) {
    if (!(a === b || b.startsWith(a) || a.startsWith(b))) {
      diffs.push(`commit: snapshot=${a}  current=${b}`);
    }
  } else if (a !== null && b === null) {
    diffs.push(`commit: snapshot=${a}  current=unavailable (not a git repo?)`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// CLI

export interface CrumbOptions {
  health: boolean;
  hostsFile: string;
  plain: boolean;
  noTmux: boolean;
  deadlineMs: number;
  connectMs: number;
  help: boolean;
}

export function parseArgs(argv: string[]): CrumbOptions {
  const opts: CrumbOptions = {
    health: false,
    hostsFile: defaultHostsFile(),
    plain: false,
    noTmux: false,
    deadlineMs: DEFAULT_DEADLINE_MS,
    connectMs: DEFAULT_CONNECT_MS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--health":
        opts.health = true;
        break;
      case "--hosts":
        opts.hostsFile = next();
        break;
      case "--plain":
        opts.plain = true;
        break;
      case "--no-tmux":
        opts.noTmux = true;
        break;
      case "--deadline":
        opts.deadlineMs = Number(next());
        break;
      case "--connect":
        opts.connectMs = Number(next());
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  if (!Number.isFinite(opts.deadlineMs) || opts.deadlineMs <= 0) throw new Error("--deadline must be a positive number of ms");
  if (!Number.isFinite(opts.connectMs) || opts.connectMs <= 0) throw new Error("--connect must be a positive number of ms");
  return opts;
}

export const HELP_TEXT = `crumb — capture and resume opencode sessions across machines (BRC-SPEC-002)

Usage:
  crumb [resume]        read all hosts, pick a session, resume it over SSH
  crumb health          show per-machine health (reachability, staleness)
  crumb install         enroll the breadcrumb plugin on this machine
  crumb --help

Resume options:
  --hosts <file>        host list file (default ~/.config/breadcrumb/hosts)
  --plain               numbered list from stdin instead of fzf
  --no-tmux             do not wrap the resume in a tmux session
  --deadline <ms>       overall read deadline (default 10000)
  --connect <ms>        per-host SSH ConnectTimeout (default 3000)

Install options:
  --dest <dir>          plugin directory (default ~/.config/opencode/plugins)

Host list format: one SSH target per line; # comments and blank lines ok.
Exit codes: 0 ok/resumed; 1 cancelled, no selection, or resume failed;
2 configuration error. crumb health exits 1 if any host is unreachable.
(--health is accepted as an alias for the health command.)`;

export interface CrumbDeps {
  ssh?: SshRunner;
  resume?: ResumeRunner;
  pick?: (lines: string[]) => Promise<number | null>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  ask?: (prompt: string) => Promise<string | null>;
  fzfAvailable?: () => boolean;
  now?: () => number;
  home?: string;
}

/**
 * Prompting reader over stdin. One interface for the whole run:
 *  - lines are buffered if they arrive while no question is pending (piped
 *    input can land during the pre-resume SSH round),
 *  - EOF resolves the pending question with null,
 *  - a fresh interface per question is unsafe (an interface created after
 *    stdin ended never fires 'close', so the process would exit with the
 *    question unresolved).
 */
function makeStdinReader(): (prompt: string) => Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
  const buffered: string[] = [];
  let pending: ((a: string | null) => void) | null = null;
  const settle = (a: string | null) => {
    if (pending === null) return;
    const resolve = pending;
    pending = null;
    resolve(a === null || a.trim() === "" ? null : a.trim());
  };
  rl.on("line", (line) => {
    if (pending !== null) settle(line);
    else buffered.push(line);
  });
  rl.on("close", () => settle(null));
  return (prompt) =>
    new Promise<string | null>((resolve) => {
      pending = resolve;
      if (buffered.length > 0) {
        settle(buffered.shift()!);
        return;
      }
      if (process.stdin.readableEnded) {
        rl.close();
        settle(null);
        return;
      }
      process.stdout.write(prompt);
    });
}

export async function runCrumb(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const now = deps.now ?? (() => Date.now());
  const ssh = deps.ssh ?? systemSsh();
  const resume = deps.resume ?? systemResume();
  const home = deps.home ?? homedir();
  // Exactly one stdin reader per run: two readline interfaces on one stdin
  // split its lines between themselves.
  let stdinReader: ((prompt: string) => Promise<string | null>) | undefined;
  const ask = (prompt: string) => (deps.ask ?? (stdinReader ??= makeStdinReader()))(prompt);
  let opts: CrumbOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (opts.help) {
    out(HELP_TEXT);
    return 0;
  }

  let hosts: string[];
  try {
    hosts = await readHostsFile(opts.hostsFile, home);
  } catch (e) {
    err(`crumb: cannot read host list ${expandHome(opts.hostsFile, home)}: ${(e as Error).message}`);
    err("crumb: create it with one SSH target per line (see README).");
    return 2;
  }
  if (hosts.length === 0) {
    err(`crumb: host list ${expandHome(opts.hostsFile, home)} is empty`);
    return 2;
  }

  const reads = await readAllHosts(hosts, { connectMs: opts.connectMs, deadlineMs: opts.deadlineMs, ssh });
  const statuses = classifyReads(reads, now());

  if (opts.health) {
    out(formatHealth(statuses, now()));
    return statuses.every((s) => s.reachable) ? 0 : 1;
  }

  const sessions = collectSessions(statuses);
  if (sessions.length === 0) {
    out("no sessions found on any reachable host.");
    out(formatHealth(statuses, now()));
    return 1;
  }

  const lines = buildPickerLines(sessions, now());
  const pick =
    deps.pick ??
    (opts.plain || !(deps.fzfAvailable ?? fzfAvailable)()
      ? (ls: string[]) =>
          new Promise<number | null>((resolve) => {
            ls.forEach((l) => out(l));
            ask(`select [1-${ls.length}] (empty cancels): `).then((a) => {
              if (a === null) return resolve(null);
              const n = Number(a);
              if (!Number.isInteger(n) || n < 1 || n > ls.length) return resolve(null);
              resolve(n);
            });
          })
      : (ls: string[]) => pickWithFzf(ls));

  const choice = await pick(lines);
  if (choice === null) {
    err("crumb: selection cancelled");
    return 1; // FR-PROBE-081: non-zero, no side effects
  }
  const sel = sessions[choice - 1];

  out(`resuming ${sel.session_id} on ${sel.host} — ${sel.directory}`);

  const pre = await ssh(precheckArgs(sel.host, sel.directory, opts.connectMs));
  if (pre.code !== 0) {
    err(`crumb: cannot reach ${sel.host} to pre-check: ${firstLine(pre.stderr) ?? `ssh exit ${pre.code}`}`);
    err(`crumb: manual: ssh -t ${shQuote(sel.host)} ${shQuote(buildLaunchCommand(sel.directory, sel.session_id))}`);
    return 1; // FR-RESUME-060
  }
  const pc = parsePrecheck(pre.stdout);
  if (!pc.dirOk) {
    err(`crumb: directory ${sel.directory} does not exist on ${sel.host}`);
    err(`crumb: manual (from ${sel.host}'s home): ssh -t ${shQuote(sel.host)}`);
    return 1; // FR-RESUME-060
  }

  const diffs = gitDiffs(sel, pc);
  if (diffs.length > 0) {
    out("git state on the machine differs from the last snapshot:");
    diffs.forEach((d) => out(`  ${d}`));
    out("crumb will not checkout, stash, or clean anything.");
    const answer = await ask("resume anyway? [y/N]: ");
    if (answer === null || answer !== "y" && answer !== "Y") {
      err("crumb: resume cancelled");
      return 1;
    }
  }

  const useTmux = !opts.noTmux && pc.tmux;
  const remote = buildRemoteCommand(sel.directory, sel.session_id, useTmux);
  const code = await resume(resumeArgs(sel.host, remote));
  if (code !== 0) {
    err(`crumb: resume exited with code ${code}`);
    err(`crumb: manual: ssh -t ${shQuote(sel.host)} ${shQuote(remote)}`); // FR-RESUME-060
  }
  return code === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Install / enrollment
//
// Copies the plugin and the shared state module into opencode's plugin
// directory. Two files, because opencode's plugin glob is non-recursive; the
// plugin resolves the shared module from a sibling subdirectory at runtime.
// Shared by `crumb install` and scripts/install.mjs so enrollment has one
// implementation. No build step: opencode runs the TypeScript directly.

export const PLUGIN_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["plugin/breadcrumb.ts", "breadcrumb.ts"],
  ["shared/state.ts", "shared/state.ts"],
];

export function defaultPluginDir(home: string = homedir()): string {
  return path.join(home, ".config", "opencode", "plugins");
}

/** Package root that holds plugin/ and shared/ (crumb.ts lives in probe/). */
export function moduleRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export interface InstallResult {
  dest: string;
  installed: string[];
}

export async function installPlugin(
  opts: { root?: string; dest?: string; home?: string; log?: (s: string) => void } = {},
): Promise<InstallResult> {
  const root = opts.root ?? moduleRoot();
  const dest = opts.dest ?? defaultPluginDir(opts.home);
  const log = opts.log ?? (() => {});
  const installed: string[] = [];
  for (const [from, to] of PLUGIN_SOURCES) {
    const src = path.join(root, from);
    await fs.stat(src);
    const target = path.join(dest, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(src, target);
    installed.push(to);
    log(`installed ${to}`);
  }
  // Remove a stale flat copy a previous installer version may have left behind.
  await fs.rm(path.join(dest, "state.ts"), { force: true }).catch(() => {});
  return { dest, installed };
}

export interface InstallOptions {
  dest?: string;
  help: boolean;
}

export function parseInstallArgs(argv: string[]): InstallOptions {
  const opts: InstallOptions = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dest") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      opts.dest = v;
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return opts;
}

export async function runInstall(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const home = deps.home ?? homedir();
  let opts: InstallOptions;
  try {
    opts = parseInstallArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (opts.help) {
    out(HELP_TEXT);
    return 0;
  }
  const dest = opts.dest !== undefined ? path.resolve(expandHome(opts.dest, home)) : undefined;
  try {
    const res = await installPlugin({ dest, home, log: out });
    out("");
    out(`Done — enrolled into ${res.dest}. Start opencode once; the plugin creates`);
    out("~/.local/share/breadcrumb/ with the machine id and first state file.");
    return 0;
  } catch (e) {
    err(`crumb: install failed: ${(e as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Command dispatch

export const SUBCOMMANDS = new Set(["resume", "health", "install"]);

/** Peel off a leading subcommand; default to `resume` when none is given. */
export function splitCommand(argv: string[]): { cmd: string; rest: string[] } {
  const first = argv[0];
  if (first !== undefined && SUBCOMMANDS.has(first)) return { cmd: first, rest: argv.slice(1) };
  return { cmd: "resume", rest: argv };
}

export async function main(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const { cmd, rest } = splitCommand(argv);
  if (cmd === "install") return runInstall(rest, deps);
  // `crumb health` is sugar for the resume path's --health (kept as an alias).
  if (cmd === "health") return runCrumb(["--health", ...rest], deps);
  return runCrumb(rest, deps);
}

// ---------------------------------------------------------------------------
// Entry point (runs only when executed directly, not when imported by tests)

function isMain(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => {
    // Release the (possibly created) stdin reader so an interactive TTY does
    // not keep the process alive after resume.
    process.stdin.destroy();
    process.exitCode = code;
  });
}
