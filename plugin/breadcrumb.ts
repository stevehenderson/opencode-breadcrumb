// Breadcrumb plugin (BRC-SPEC-002 §6, §8).
//
// Loaded into opencode on every enrolled machine. Observes session lifecycle
// events via opencode's general `event` hook (FR-PLUGIN-010) and rewrites the
// machine's state file whole, atomically. Runs only while opencode runs,
// opens no sockets, starts no background work (C1), and swallows every
// failure so it can never degrade a coding session (FR-PLUGIN-060).
//
// Installation: copy this file to ~/.config/opencode/plugins/breadcrumb.ts
// and shared/state.ts to ~/.config/opencode/plugins/shared/state.ts
// (see scripts/install.mjs). No build step; opencode runs TypeScript directly.

import type { BreadcrumbState, SessionSnapshot } from "../shared/state.ts";
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, hostname } from "node:os";
import * as path from "node:path";

export const PLUGIN_VERSION = "0.1.0";

/** FR-PLUGIN-042: message-event writes are throttled to at most one per 5 s. */
export const MESSAGE_THROTTLE_MS = 5_000;
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const STALE_TMP_MS = 60 * 60 * 1000;

// In the repo this file lives at plugin/breadcrumb.ts next to shared/state.ts;
// installed it lives at plugins/breadcrumb.ts with plugins/shared/state.ts.
// opencode's plugin glob is non-recursive, so the shared module is located at
// runtime by trying both layouts.
const SHARED_CANDIDATES = ["../shared/state.ts", "./shared/state.ts"];
type SharedModule = typeof import("../shared/state.ts");
let sharedPromise: Promise<SharedModule> | undefined;

function loadShared(): Promise<SharedModule> {
  sharedPromise ??= (async () => {
    let lastError: unknown;
    for (const spec of SHARED_CANDIDATES) {
      try {
        return await import(spec);
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`breadcrumb: cannot load shared/state.ts (${String(lastError)})`);
  })();
  return sharedPromise;
}

// ---------------------------------------------------------------------------
// Event extraction (FR-PLUGIN-010/011/020)
//
// Shapes below were confirmed against @opencode-ai/sdk 1.17.13 (opencode
// 1.18.x, resolving spec OI-2): session.created/updated/deleted carry
// properties.info: Session { id, title, directory, ... }; session.idle and
// session.compacted carry properties.sessionID; message.updated carries
// properties.info: Message { sessionID, ... }; message.part.updated carries
// properties.part: Part { sessionID, ... }. Extraction stays defensive
// because event names have changed across opencode versions.

export type EventLike = { type?: unknown; properties?: unknown };

export type SessionRef =
  | { kind: "observe"; sessionID: string; title?: string; directory?: string; throttled: boolean }
  | { kind: "remove"; sessionID: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function extractSessionRef(event: EventLike, ctxDirectory: string): SessionRef | null {
  const p = asRecord(event.properties) ?? {};
  const info = asRecord(p.info);
  const part = asRecord(p.part);
  const type = typeof event.type === "string" ? event.type : "";
  const sessionID =
    asString(info?.id) ?? asString(info?.sessionID) ?? asString(p.sessionID) ?? asString(part?.sessionID);
  if (!sessionID) return null;
  switch (type) {
    case "session.created":
    case "session.updated":
      return {
        kind: "observe",
        sessionID,
        title: asString(info?.title),
        directory: asString(info?.directory) ?? asString(p.directory),
        throttled: false,
      };
    case "session.idle":
    case "session.compacted":
      return { kind: "observe", sessionID, throttled: false };
    case "session.deleted":
      return { kind: "remove", sessionID };
    case "message.updated": {
      // properties.info is a Message, whose `id` is the *message* id, not the
      // session id (that field caught `sessionID` above). Use sessionID only.
      const sid = asString(info?.sessionID) ?? asString(p.sessionID);
      return sid ? { kind: "observe", sessionID: sid, throttled: true } : null;
    }
    case "message.part.updated": {
      const sid = asString(part?.sessionID) ?? asString(p.sessionID);
      return sid ? { kind: "observe", sessionID: sid, throttled: true } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Git capture (FR-PLUGIN-030/031)

export interface GitState {
  git_branch: string | null;
  git_commit: string | null;
  git_dirty: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
}

function runGit(bin: string, dir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["-C", dir, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          const code =
            typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : -1;
          resolve({ code, stdout: stdout ?? "" });
        } else {
          resolve({ code: 0, stdout: stdout ?? "" });
        }
      },
    );
  });
}

/**
 * Capture git state for a directory at observation time. A non-git
 * directory, a detached HEAD, a missing git binary, or a timeout are all
 * non-fatal: affected fields become null/false and we continue (FR-PLUGIN-031).
 */
export async function captureGitState(dir: string, opts: { bin?: string } = {}): Promise<GitState> {
  const bin = opts.bin ?? "git";
  const [branch, commit, status] = await Promise.all([
    runGit(bin, dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(bin, dir, ["rev-parse", "HEAD"]),
    runGit(bin, dir, ["status", "--porcelain"]),
  ]);
  const b = branch.stdout.trim();
  const c = commit.stdout.trim();
  return {
    git_branch: branch.code === 0 && b !== "" && b !== "HEAD" ? b : null,
    git_commit: commit.code === 0 && c !== "" ? c : null,
    git_dirty: status.code === 0 && status.stdout.trim() !== "",
  };
}

// ---------------------------------------------------------------------------
// State file I/O (FR-PLUGIN-040/041, §5, IDN-010/011)

export function stateDirFor(home: string, dirName: string): string {
  return path.join(home, ".local", "share", dirName);
}

async function writeFileOwnerOnly(file: string, text: string): Promise<void> {
  const fh = await fs.open(file, "w", 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** FR-PLUGIN-041: create ~/.local/share/breadcrumb/ if absent, mode 0700. */
export async function ensureStateDir(home: string): Promise<string> {
  const { STATE_DIR_NAME } = await loadShared();
  const dir = stateDirFor(home, STATE_DIR_NAME);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

/** IDN-010/011: create the machine id (UUID) once; stable afterwards. */
export async function ensureMachineId(dir: string): Promise<string> {
  const { MACHINE_ID_FILE_NAME } = await loadShared();
  const file = path.join(dir, MACHINE_ID_FILE_NAME);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing !== "") return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const id = randomUUID();
  await writeFileOwnerOnly(file, id + "\n");
  return id;
}

function freshState(
  s: SharedModule,
  machineName: string,
  machineId: string,
  pluginVersion: string,
  nowMs: number,
): BreadcrumbState {
  return {
    schema: s.SCHEMA_VERSION,
    machine_id: machineId,
    hostname: machineName,
    written_at: new Date(nowMs).toISOString(),
    plugin_version: pluginVersion,
    sessions: [],
  };
}

export interface LoadedState {
  state: BreadcrumbState;
  /** File exists but is unparseable by this plugin (e.g. newer schema): do not clobber it. */
  foreign: boolean;
  exists: boolean;
}

export async function loadState(
  dir: string,
  machineName: string,
  machineId: string,
  pluginVersion: string,
  nowMs: number,
): Promise<LoadedState> {
  const s = await loadShared();
  const file = path.join(dir, s.STATE_FILE_NAME);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: freshState(s, machineName, machineId, pluginVersion, nowMs), foreign: false, exists: false };
    }
    return { state: freshState(s, machineName, machineId, pluginVersion, nowMs), foreign: true, exists: true };
  }
  try {
    return { state: s.parseState(text), foreign: false, exists: true };
  } catch {
    return { state: freshState(s, machineName, machineId, pluginVersion, nowMs), foreign: true, exists: true };
  }
}

/**
 * FR-PLUGIN-040: atomic write — sibling temp file in the same directory,
 * fsync, then rename over the target. A reader never observes a partial file.
 */
export async function writeStateAtomic(dir: string, state: BreadcrumbState): Promise<void> {
  const { STATE_FILE_NAME } = await loadShared();
  const text = JSON.stringify(state, null, 2) + "\n";
  const tmp = path.join(dir, `.${STATE_FILE_NAME}.tmp.${process.pid}.${Date.now()}`);
  const final = path.join(dir, STATE_FILE_NAME);
  const fh = await fs.open(tmp, "w", 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, final);
}

/** Best-effort removal of temp files left by a plugin killed mid-write. */
export async function cleanStaleTmpFiles(dir: string): Promise<void> {
  const { STATE_FILE_NAME } = await loadShared();
  const prefix = `.${STATE_FILE_NAME}.tmp.`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_MS;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.mtimeMs < cutoff) await fs.unlink(path.join(dir, name));
    } catch {
      // ignore
    }
  }
}

async function readLatestState(dir: string): Promise<BreadcrumbState | null> {
  const s = await loadShared();
  try {
    const text = await fs.readFile(path.join(dir, s.STATE_FILE_NAME), "utf8");
    return s.parseState(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot list management (FR-PLUGIN-050/051)

/** Replace the snapshot for session_id in place, move it to the front, cap at MAX_SESSIONS. */
export async function upsertSnapshot(state: BreadcrumbState, snap: SessionSnapshot, nowMs: number): Promise<BreadcrumbState> {
  const { MAX_SESSIONS } = await loadShared();
  const sessions = [snap, ...state.sessions.filter((s) => s.session_id !== snap.session_id)];
  sessions.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return { ...state, sessions: sessions.slice(0, MAX_SESSIONS), written_at: new Date(nowMs).toISOString() };
}

export async function removeSnapshot(state: BreadcrumbState, sessionID: string, nowMs: number): Promise<BreadcrumbState> {
  return {
    ...state,
    sessions: state.sessions.filter((s) => s.session_id !== sessionID),
    written_at: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service: wires events to state-file updates

export interface PluginServiceOptions {
  /** $HOME of the plugin process (spec §5: resolve `~` to $HOME). */
  home: string;
  /** Directory this opencode instance runs in (plugin context). */
  directory: string;
  /** Display hostname (os.hostname by default). */
  hostname?: string;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Git binary to invoke (default "git"); tests inject a stub. */
  gitBin?: string;
}

export interface PluginService {
  handleEvent(event: EventLike): Promise<void>;
  getState(): BreadcrumbState;
  readonly stateDir: string;
  readonly machineId: string;
}

export async function createService(opts: PluginServiceOptions): Promise<PluginService> {
  const s = await loadShared();
  const now = opts.now ?? (() => Date.now());
  const dir = await ensureStateDir(opts.home);
  const machineId = await ensureMachineId(dir);
  await cleanStaleTmpFiles(dir);
  const machineName = opts.hostname ?? hostname();
  const loaded = await loadState(dir, machineName, machineId, PLUGIN_VERSION, now());
  let state = loaded.state;
  let foreign = loaded.foreign;

  // Last-known context per session, so events that only carry a session id
  // (idle, message) can still produce a complete snapshot.
  const known = new Map<string, { title: string | null; directory: string }>();
  for (const snap of state.sessions) known.set(snap.session_id, { title: snap.title, directory: snap.directory });
  const lastMessageWrite = new Map<string, number>();

  async function persist(next: BreadcrumbState): Promise<void> {
    if (foreign) return; // never clobber a state file we cannot read
    state = next;
    await writeStateAtomic(dir, state);
  }

  async function observe(ref: Extract<SessionRef, { kind: "observe" }>): Promise<void> {
    const mem = known.get(ref.sessionID);
    const title = ref.title ?? mem?.title ?? null;
    const directory = ref.directory ?? mem?.directory ?? opts.directory;
    known.set(ref.sessionID, { title, directory });
    const git = await captureGitState(directory, { bin: opts.gitBin });
    const snap: SessionSnapshot = {
      session_id: ref.sessionID,
      title,
      directory,
      ...git,
      updated_at: new Date(now()).toISOString(),
    };
    // Re-read from disk per update so concurrent opencode instances on this
    // machine do not clobber each other's entries.
    const current = await readLatestState(dir) ?? state;
    await persist(await upsertSnapshot(current, snap, now()));
  }

  return {
    get stateDir() {
      return dir;
    },
    machineId,
    getState: () => state,
    async handleEvent(event: EventLike): Promise<void> {
      try {
        const ref = extractSessionRef(event, opts.directory);
        if (ref === null) return;
        if (ref.kind === "remove") {
          known.delete(ref.sessionID);
          const current = await readLatestState(dir);
          await persist(await removeSnapshot(current ?? state, ref.sessionID, now()));
          return;
        }
        if (ref.throttled) {
          const t = now();
          if (t - (lastMessageWrite.get(ref.sessionID) ?? 0) < MESSAGE_THROTTLE_MS) return;
          lastMessageWrite.set(ref.sessionID, t);
        }
        await observe(ref);
      } catch {
        // FR-PLUGIN-060: swallow all failures; never throw into opencode.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// opencode entry point (TECH-010)

const Breadcrumb: Plugin = async (ctx) => {
  try {
    const service = await createService({ home: process.env.HOME ?? homedir(), directory: ctx.directory });
    return {
      event: async ({ event }) => {
        await service.handleEvent(event as unknown as EventLike);
      },
    };
  } catch {
    return {}; // FR-PLUGIN-060: opencode keeps running without us.
  }
};

export { Breadcrumb };
export default { id: "breadcrumb", server: Breadcrumb } satisfies PluginModule;
