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
  truncatePrompt,
} from "../shared/state.ts";

const DEFAULT_DEADLINE_MS = 10_000; // FR-PROBE-030 (OI-3)
const DEFAULT_CONNECT_MS = 3_000; // FR-PROBE-021 (OI-3)
const STALE_AFTER_MS = 60 * 60 * 1000; // FR-PROBE-070 (OI-3)
const READ_MARKER = "__BC_READ__";
const READ_SEP = "__BC_SEP__";
const READ_END = "__BC_END__";

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
// Local target: this machine, read directly from the filesystem (no SSH).
//
// crumb works with no host list at all — the machine where it runs is always
// reachable. A local target reads ~/.local/share/breadcrumb/state.json and the
// opencode.db mtime straight off disk, and resumes with a plain child process
// instead of `ssh -t`. Reads are shaped identically to the SSH read command's
// output so classifyReads treats local and remote machines the same way.

export const LOCAL_HOST = "local";
const LOCAL_ALIASES = new Set(["local", "localhost", "(local)"]);

export function isLocalHost(host: string): boolean {
  return LOCAL_ALIASES.has(host.toLowerCase());
}

export function localStatePaths(home: string): { state: string; db: string } {
  return {
    state: path.join(home, ".local", "share", "breadcrumb", "state.json"),
    db: path.join(home, ".local", "share", "opencode", "opencode.db"),
  };
}

/** Read the local state file + opencode.db mtime, formatted like the SSH read. */
export async function readLocalState(home: string = homedir()): Promise<SshResult> {
  const { state, db } = localStatePaths(home);
  let stateText = "";
  try {
    stateText = await fs.readFile(state, "utf8");
  } catch {
    // no state file yet — treated as "no state" downstream
  }
  let mtimeLine = "";
  try {
    const st = await fs.stat(db);
    mtimeLine = `${Math.floor(st.mtimeMs / 1000)}\n`;
  } catch {
    // no opencode.db — liveness stays undetermined
  }
  return { code: 0, stdout: `${READ_MARKER}\n${stateText}\n${READ_SEP}\n${mtimeLine}${READ_END}\n`, stderr: "" };
}

/** Run a shell command on this machine, capturing output (local precheck). */
export type LocalExec = (command: string) => Promise<SshResult>;

export function systemLocalExec(): LocalExec {
  return (command) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err: Error) => resolve({ code: -1, stdout, stderr: (stderr ? stderr + "\n" : "") + err.message }));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

/** Run the launch command on this machine with an inherited TTY (local resume). */
export function systemLocalResume(): (command: string) => Promise<number> {
  return (command) =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { stdio: "inherit" });
      child.on("error", (err: Error) => {
        console.error(`crumb: launch failed: ${err.message}`);
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
}

// ---------------------------------------------------------------------------
// Read fan-out (FR-PROBE-021/030/031, FR-PROBE-070's same-round db mtime)

export function buildReadCommand(): string {
  return [
    `printf '${READ_MARKER}\\n'`,
    "cat \"$HOME/.local/share/breadcrumb/state.json\" 2>/dev/null",
    `printf '\\n${READ_SEP}\\n'`,
    "{ stat -c %Y \"$HOME/.local/share/opencode/opencode.db\" 2>/dev/null || stat -f %m \"$HOME/.local/share/opencode/opencode.db\" 2>/dev/null || true; }",
    `printf '${READ_END}\\n'`,
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
  const start = `${READ_MARKER}\n`;
  const separator = `\n${READ_SEP}\n`;
  // Strip only the end marker + its own trailing newline; the newline *before*
  // it belongs to the separator (or the mtime line) and must be kept — when a
  // host reports no db mtime the separator and end marker share that newline.
  const endMark = `${READ_END}\n`;
  if (!raw.startsWith(start) || !raw.endsWith(endMark)) return { stateText: null, dbMtime: null };
  const framed = raw.slice(start.length, raw.length - endMark.length);
  const sep = framed.indexOf(separator);
  if (sep === -1 || sep !== framed.lastIndexOf(separator)) return { stateText: null, dbMtime: null };
  const text = framed.slice(0, sep).trim();
  const tail = framed.slice(sep + separator.length).trim();
  if (text === "" || tail.includes("\n")) return { stateText: null, dbMtime: null };
  const mtime = tail === "" ? NaN : Number(tail);
  return { stateText: text, dbMtime: Number.isFinite(mtime) ? mtime : null };
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

/** One picker row: machine, age, branch + dirty marker, directory, title, gist. */
export function formatSessionLine(s: MergedSession, nowMs: number = Date.now()): string {
  const branch = s.git_branch ?? "no-branch";
  const dirty = s.git_dirty ? "*" : "";
  const title = s.title ?? "(untitled)";
  const machine = s.hostname !== "" ? s.hostname : s.host;
  const gist = s.last_prompt ? `  » ${truncatePrompt(s.last_prompt, 80)}` : "";
  return `${machine}  ${relativeAge(s.updated_at, nowMs)}  ${branch}${dirty}  ${s.directory}  ${title}${gist}`;
}

/**
 * A session matches when every term appears (case-insensitively) somewhere in
 * its searchable text: machine, title, branch, directory, and the prompt gist.
 * All terms must match (AND) so extra terms narrow the result.
 */
export function sessionMatches(s: MergedSession, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = [s.hostname, s.host, s.title ?? "", s.git_branch ?? "", s.directory, s.last_prompt ?? ""]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t.toLowerCase()));
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

/**
 * Run a command under an *interactive login* shell, replicating the
 * environment you get from a plain `ssh host`. `ssh host cmd` and tmux use a
 * non-login, non-interactive shell that sources none of the files where a tool
 * like `opencode` is added to PATH — profiles are skipped, and ~/.bashrc/~/.zshrc
 * usually guard themselves to a no-op when non-interactive. `-lic` sources both
 * the login profile and the interactive rc, so PATH matches your normal shell.
 * $SHELL is resolved on the target at runtime; falls back to bash.
 */
export function loginShell(command: string): string {
  return `"\${SHELL:-/bin/bash}" -lic ${shQuote(command)}`;
}

/** tmux session name, sanitized to tmux's allowed character set. */
export function tmuxSessionName(sessionId: string): string {
  return "bc_" + sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** FR-RESUME-030: wrap in a named tmux session so drops detach, not kill. */
export function buildRemoteCommand(dir: string, sessionId: string, useTmux: boolean): string {
  // Always run the launch via a login shell so opencode is found on PATH.
  const launch = loginShell(buildLaunchCommand(dir, sessionId));
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
  /** True when --hosts was given explicitly (so a missing file is an error, not local fallback). */
  hostsFileExplicit: boolean;
  /** Force local-only: read this machine directly, never SSH. */
  local: boolean;
  /** Exclude this machine; read only the hosts in the list. */
  noLocal: boolean;
  plain: boolean;
  noTmux: boolean;
  deadlineMs: number;
  connectMs: number;
  /** Keyword filter applied to the merged sessions (repeatable; all must match). */
  match: string[];
  help: boolean;
}

export function parseArgs(argv: string[]): CrumbOptions {
  const opts: CrumbOptions = {
    health: false,
    hostsFile: defaultHostsFile(),
    hostsFileExplicit: false,
    local: false,
    noLocal: false,
    plain: false,
    noTmux: false,
    deadlineMs: DEFAULT_DEADLINE_MS,
    connectMs: DEFAULT_CONNECT_MS,
    match: [],
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
        opts.hostsFileExplicit = true;
        break;
      case "--local":
        opts.local = true;
        break;
      case "--no-local":
        opts.noLocal = true;
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
      case "--match":
        opts.match.push(next());
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
  crumb search <terms>  resume, but only among sessions matching every term
  crumb health          show per-machine health (reachability, staleness)
  crumb install         enroll the breadcrumb plugin on this machine
  crumb clean           prune stale/invalid entries from this machine's state
  crumb hosts [list]    show the SSH target list
  crumb hosts add <target…>     add one or more SSH targets
  crumb hosts remove <target…>  remove SSH targets (alias: rm)
  crumb hosts path      print the host-list file path
  crumb --help

Resume options:
  --hosts <file>        host list file (default ~/.config/breadcrumb/hosts)
  --local               read only this machine, directly (no SSH)
  --no-local            read only the hosts; exclude this machine
  --plain               numbered list from stdin instead of fzf
  --no-tmux             do not wrap the resume in a tmux session
  --deadline <ms>       overall read deadline (default 10000)
  --connect <ms>        per-host SSH ConnectTimeout (default 3000)
  --match <term>        keep only sessions matching <term> (repeatable; all
                        must match). Searches machine, title, branch,
                        directory, and the last-prompt gist. "crumb search"
                        is shorthand for positional terms.

Install options:
  --dest <dir>          plugin directory (default ~/.config/opencode/plugins)

Clean options (operates on this machine's state file only):
  --all                 remove every session entry (full reset)
  --dry-run, -n         show what would be removed, write nothing
  (default: remove only entries that are not real opencode sessions)

Hosts options:
  --hosts <file>        operate on an alternate host list
  (targets are SSH destinations: hostname, user@host, or ~/.ssh/config alias;
   a "local" target means this machine, read directly)

Host list format: one SSH target per line; # comments and blank lines ok.
crumb always reads this machine too (directly, no SSH) alongside the hosts, so
you see local and remote sessions together; use --no-local to exclude it, or
--local for this machine only.
Exit codes: 0 ok/resumed; 1 cancelled, no selection, or resume failed;
2 configuration error. crumb health exits 1 if any host is unreachable.
(--health is accepted as an alias for the health command.)`;

export interface CrumbDeps {
  ssh?: SshRunner;
  resume?: ResumeRunner;
  /** Read the local machine's state (defaults to reading the filesystem). */
  readLocal?: (home: string) => Promise<SshResult>;
  /** Run a local precheck command (defaults to `sh -c`). */
  localExec?: LocalExec;
  /** Resume locally with an inherited TTY (defaults to `sh -c`). */
  localResume?: (command: string) => Promise<number>;
  pick?: (lines: string[]) => Promise<number | null>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  ask?: (prompt: string) => Promise<string | null>;
  fzfAvailable?: () => boolean;
  now?: () => number;
  home?: string;
}

/**
 * Decide which machines to read. Precedence:
 *  - `--local` → this machine only.
 *  - otherwise read the host list and, unless `--no-local`, include this
 *    machine alongside it (deduped) so local and remote sessions show together.
 * A *missing default* file just means "no hosts" (→ local only); an explicit
 * `--hosts <file>` that cannot be read is an error (returns null, msg printed).
 */
export async function resolveTargets(
  opts: CrumbOptions,
  home: string,
  err: (s: string) => void,
): Promise<string[] | null> {
  if (opts.local) return [LOCAL_HOST];
  let hosts: string[] = [];
  try {
    hosts = parseHosts(await fs.readFile(expandHome(opts.hostsFile, home), "utf8"));
  } catch (e) {
    if (!((e as NodeJS.ErrnoException).code === "ENOENT" && !opts.hostsFileExplicit)) {
      err(`crumb: cannot read host list ${expandHome(opts.hostsFile, home)}: ${(e as Error).message}`);
      err("crumb: create it with one SSH target per line (see README), or use --local.");
      return null;
    }
    // Default file simply doesn't exist yet — treat as no remote hosts.
  }
  if (opts.noLocal) return hosts;
  // Always include this machine unless the list already names it.
  return hosts.some(isLocalHost) ? hosts : [LOCAL_HOST, ...hosts];
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
interface StdinReader {
  ask: (prompt: string) => Promise<string | null>;
  /**
   * Tear down the interface and hand the TTY back. Must be called before we
   * spawn an interactive child (resume): readline holds stdin in raw mode, and
   * a live interface would fight the child for keystrokes and re-render the
   * line — dropped keys and flicker. Interface.close() disables raw mode and
   * pauses stdin, so the child gets exclusive control.
   */
  close: () => void;
}

function makeStdinReader(): StdinReader {
  // `output` is required for terminal mode: in a TTY readline switches stdin to
  // raw mode, and without an output stream it has nowhere to echo keystrokes or
  // drive line editing — typed input appears to do nothing. Harmless for pipes.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const buffered: string[] = [];
  let pending: ((a: string | null) => void) | null = null;
  let closed = false;
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
  return {
    ask: (prompt) =>
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
      }),
    close: () => {
      if (closed) return;
      closed = true;
      settle(null); // resolve any in-flight question so nothing hangs
      rl.close(); // restores cooked mode + pauses stdin (Interface.close)
    },
  };
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
  let stdinReader: StdinReader | undefined;
  const ask = (prompt: string) => (deps.ask ? deps.ask(prompt) : (stdinReader ??= makeStdinReader()).ask(prompt));
  // Release stdin before handing the TTY to an interactive child (resume), so
  // our readline doesn't fight the child for keystrokes.
  const releaseStdin = () => {
    stdinReader?.close();
    stdinReader = undefined;
  };
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

  const hosts = await resolveTargets(opts, home, err);
  if (hosts === null) return 2;

  const readLocal = deps.readLocal ?? readLocalState;
  const wantLocal = hosts.some(isLocalHost);
  const remoteHosts = hosts.filter((h) => !isLocalHost(h));
  const remoteReads = remoteHosts.length
    ? await readAllHosts(remoteHosts, { connectMs: opts.connectMs, deadlineMs: opts.deadlineMs, ssh })
    : [];
  const localReads: HostRead[] = wantLocal ? [{ host: LOCAL_HOST, result: await readLocal(home) }] : [];
  const statuses = classifyReads([...localReads, ...remoteReads], now());

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

  const list = opts.match.length > 0 ? sessions.filter((s) => sessionMatches(s, opts.match)) : sessions;
  if (list.length === 0) {
    out(`no sessions match: ${opts.match.join(" ")}`);
    return 1;
  }

  const lines = buildPickerLines(list, now());
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
  const sel = list[choice - 1];
  const local = isLocalHost(sel.host);
  const where = local ? "this machine" : sel.host;

  out(`resuming ${sel.session_id} on ${where} — ${sel.directory}`);

  const localExec = deps.localExec ?? systemLocalExec();
  const pre = local
    ? await localExec(buildPrecheckCommand(sel.directory))
    : await ssh(precheckArgs(sel.host, sel.directory, opts.connectMs));
  if (pre.code !== 0) {
    if (local) err(`crumb: local pre-check failed: ${firstLine(pre.stderr) ?? `exit ${pre.code}`}`);
    else {
      err(`crumb: cannot reach ${sel.host} to pre-check: ${firstLine(pre.stderr) ?? `ssh exit ${pre.code}`}`);
      err(`crumb: manual: ssh -t ${shQuote(sel.host)} ${shQuote(buildRemoteCommand(sel.directory, sel.session_id, false))}`);
    }
    return 1; // FR-RESUME-060
  }
  const pc = parsePrecheck(pre.stdout);
  if (!pc.dirOk) {
    err(`crumb: directory ${sel.directory} does not exist on ${where}`);
    if (!local) err(`crumb: manual (from ${sel.host}'s home): ssh -t ${shQuote(sel.host)}`);
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
  // Hand the terminal to the resumed session with no readline in the way.
  releaseStdin();
  const code = local
    ? await (deps.localResume ?? systemLocalResume())(remote)
    : await resume(resumeArgs(sel.host, remote));
  if (code !== 0) {
    err(`crumb: resume exited with code ${code}`);
    err(`crumb: manual: ${local ? remote : `ssh -t ${shQuote(sel.host)} ${shQuote(remote)}`}`); // FR-RESUME-060
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
// Clean: prune crumb's own local state file
//
// Operates on this machine only — crumb never writes another machine's files
// (to clean a remote, run `crumb clean` there). Default mode drops entries that
// are not real opencode sessions (e.g. artifacts a buggy plugin version wrote);
// --all wipes every session, keeping the file and machine id.

/** opencode session ids look like `ses_…`; anything else in state is an artifact. */
export function isOpencodeSessionId(id: string): boolean {
  return id.startsWith("ses_");
}

export interface CleanOptions {
  all: boolean;
  dryRun: boolean;
  help: boolean;
}

export function parseCleanArgs(argv: string[]): CleanOptions {
  const opts: CleanOptions = { all: false, dryRun: false, help: false };
  for (const a of argv) {
    switch (a) {
      case "--all":
        opts.all = true;
        break;
      case "--dry-run":
      case "-n":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  return opts;
}

/** Partition sessions into those kept and those removed for the given mode. */
export function planClean(
  sessions: SessionSnapshot[],
  all: boolean,
): { kept: SessionSnapshot[]; removed: SessionSnapshot[] } {
  if (all) return { kept: [], removed: sessions.slice() };
  const kept: SessionSnapshot[] = [];
  const removed: SessionSnapshot[] = [];
  for (const s of sessions) (isOpencodeSessionId(s.session_id) ? kept : removed).push(s);
  return { kept, removed };
}

/** Owner-only atomic write (temp + fsync + rename); creates parent dirs. */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${process.pid}.${Date.now()}`);
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

async function writeStateFileAtomic(file: string, state: BreadcrumbState): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
}

export async function runClean(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const home = deps.home ?? homedir();
  let opts: CleanOptions;
  try {
    opts = parseCleanArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (opts.help) {
    out(HELP_TEXT);
    return 0;
  }
  const { state: file } = localStatePaths(home);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      out("crumb: no state file on this machine — nothing to clean.");
      return 0;
    }
    err(`crumb: cannot read ${file}: ${(e as Error).message}`);
    return 1;
  }
  let parsed: BreadcrumbState;
  try {
    parsed = parseState(text, { skipBadEntries: true });
  } catch (e) {
    err(`crumb: cannot parse ${file}: ${(e as Error).message}`);
    return 1;
  }
  const { kept, removed } = planClean(parsed.sessions, opts.all);
  const plural = (n: number) => (n === 1 ? "y" : "ies");
  if (removed.length === 0) {
    out(`crumb: nothing to clean (${kept.length} session${kept.length === 1 ? "" : "s"}).`);
    return 0;
  }
  if (opts.dryRun) {
    out(`crumb: would remove ${removed.length} entr${plural(removed.length)}, keep ${kept.length}:`);
    for (const s of removed) out(`  - ${s.session_id}  ${s.directory}  ${s.title ?? "(untitled)"}`);
    return 0;
  }
  await writeStateFileAtomic(file, { ...parsed, sessions: kept });
  out(`crumb: removed ${removed.length} entr${plural(removed.length)}, kept ${kept.length}.`);
  if (!opts.all) out("crumb: if removed entries reappear, restart opencode so the current plugin is loaded.");
  return 0;
}

// ---------------------------------------------------------------------------
// Hosts: manage the SSH target list (~/.config/breadcrumb/hosts)

export type HostsAction = "list" | "add" | "remove" | "path";

const HOSTS_ACTIONS: Record<string, HostsAction> = {
  list: "list",
  add: "add",
  remove: "remove",
  rm: "remove",
  path: "path",
};

export interface HostsOptions {
  action: HostsAction;
  targets: string[];
  file: string;
  help: boolean;
}

/** A target is one token `ssh` accepts: no whitespace, not a comment. */
function validateTarget(t: string): void {
  if (t === "" || /\s/.test(t) || t.startsWith("#")) {
    throw new Error(`invalid host target: ${JSON.stringify(t)}`);
  }
}

export function parseHostsArgs(argv: string[], home: string = homedir()): HostsOptions {
  const opts: HostsOptions = { action: "list", targets: [], file: defaultHostsFile(home), help: false };
  let actionSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hosts") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      opts.file = expandHome(v, home);
    } else if (a === "--help" || a === "-h") {
      opts.help = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    } else if (!actionSet) {
      const act = HOSTS_ACTIONS[a];
      if (act === undefined) throw new Error(`unknown hosts action: ${a} (use list, add, remove, path)`);
      opts.action = act;
      actionSet = true;
    } else {
      opts.targets.push(a);
    }
  }
  return opts;
}

export async function runHosts(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s + "\n"));
  const err = deps.err ?? ((s: string) => process.stderr.write(s + "\n"));
  const home = deps.home ?? homedir();
  let opts: HostsOptions;
  try {
    opts = parseHostsArgs(argv, home);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  if (opts.help) {
    out(HELP_TEXT);
    return 0;
  }
  if (opts.action === "path") {
    out(opts.file);
    return 0;
  }

  let raw = "";
  let exists = true;
  try {
    raw = await fs.readFile(opts.file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else {
      err(`crumb: cannot read ${opts.file}: ${(e as Error).message}`);
      return 1;
    }
  }

  if (opts.action === "list") {
    const hosts = parseHosts(raw);
    if (hosts.length === 0) {
      out(`no hosts in ${opts.file} — crumb reads this machine only (add one with: crumb hosts add <target>).`);
      return 0;
    }
    hosts.forEach((h, i) => out(`${i + 1}) ${h}`));
    return 0;
  }

  if (opts.targets.length === 0) {
    err(`crumb: hosts ${opts.action} needs at least one target`);
    return 2;
  }
  try {
    opts.targets.forEach(validateTarget);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  if (opts.action === "add") {
    const existing = new Set(parseHosts(raw));
    const toAdd = opts.targets.filter((t) => !existing.has(t));
    const dupes = opts.targets.filter((t) => existing.has(t));
    if (toAdd.length === 0) {
      out(`crumb: already present: ${dupes.join(", ")}`);
      return 0;
    }
    let text = raw;
    if (text !== "" && !text.endsWith("\n")) text += "\n";
    text += toAdd.map((t) => t + "\n").join("");
    await writeFileAtomic(opts.file, text);
    out(`crumb: added ${toAdd.join(", ")}${dupes.length ? ` (already present: ${dupes.join(", ")})` : ""} → ${opts.file}`);
    return 0;
  }

  // remove
  if (!exists) {
    out(`crumb: no host list at ${opts.file} — nothing to remove.`);
    return 0;
  }
  const remove = new Set(opts.targets);
  const removed: string[] = [];
  const kept = raw.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#") && remove.has(trimmed)) {
      removed.push(trimmed);
      return false;
    }
    return true;
  });
  if (removed.length === 0) {
    out(`crumb: not found in ${opts.file}: ${opts.targets.join(", ")}`);
    return 0;
  }
  const text = kept.join("\n");
  await writeFileAtomic(opts.file, text.endsWith("\n") ? text : text + "\n");
  const notFound = opts.targets.filter((t) => !removed.includes(t));
  out(`crumb: removed ${removed.join(", ")}${notFound.length ? ` (not found: ${notFound.join(", ")})` : ""} → ${opts.file}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Command dispatch

export const SUBCOMMANDS = new Set(["resume", "health", "install", "search", "clean", "hosts"]);

/** Peel off a leading subcommand; default to `resume` when none is given. */
export function splitCommand(argv: string[]): { cmd: string; rest: string[] } {
  const first = argv[0];
  if (first !== undefined && SUBCOMMANDS.has(first)) return { cmd: first, rest: argv.slice(1) };
  return { cmd: "resume", rest: argv };
}

/**
 * Split `crumb search <terms…> [flags]` into search terms and passthrough flags:
 * everything up to the first `-…` token is a term, the rest are resume flags.
 */
export function parseSearchArgs(rest: string[]): { terms: string[]; flags: string[] } {
  const firstFlag = rest.findIndex((a) => a.startsWith("-"));
  if (firstFlag === -1) return { terms: rest, flags: [] };
  return { terms: rest.slice(0, firstFlag), flags: rest.slice(firstFlag) };
}

export async function main(argv: string[], deps: CrumbDeps = {}): Promise<number> {
  const { cmd, rest } = splitCommand(argv);
  if (cmd === "install") return runInstall(rest, deps);
  if (cmd === "clean") return runClean(rest, deps);
  if (cmd === "hosts") return runHosts(rest, deps);
  // `crumb health` is sugar for the resume path's --health (kept as an alias).
  if (cmd === "health") return runCrumb(["--health", ...rest], deps);
  if (cmd === "search") {
    const { terms, flags } = parseSearchArgs(rest);
    if (terms.length === 0) {
      (deps.err ?? ((s: string) => process.stderr.write(s + "\n")))("crumb: search needs at least one term");
      return 2;
    }
    // Route terms through the resume path's repeatable --match filter.
    return runCrumb([...terms.flatMap((t) => ["--match", t]), ...flags], deps);
  }
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
