// Breadcrumb state file types and helpers (BRC-SPEC-002 §5).
//
// This is the single source of truth for the state file schema, imported by
// both the plugin (writer) and the probe (reader). No runtime dependencies:
// it must stay loadable by both Node and Bun without a build step.

export const SCHEMA_VERSION = 1;
export const MAX_SESSIONS = 200;
export const STATE_DIR_NAME = "breadcrumb";
export const STATE_FILE_NAME = "state.json";
export const MACHINE_ID_FILE_NAME = "machine_id";

export interface SessionSnapshot {
  /** opencode session id, verbatim; the argument to `opencode -s`. */
  session_id: string;
  /** Session title as reported by opencode, or null. */
  title: string | null;
  /** Workspace the session ran in; the `cd` target on resume. Absolute path. */
  directory: string;
  /** Branch at last observation; null if not a git repo or detached. */
  git_branch: string | null;
  /** HEAD at last observation (40-hex or short), or null. */
  git_commit: string | null;
  /** Whether the working tree had uncommitted changes at last observation. */
  git_dirty: boolean;
  /** Last observation time, RFC 3339 UTC; the probe's sort key. */
  updated_at: string;
}

export interface BreadcrumbState {
  /** Format version. Must equal SCHEMA_VERSION; reject otherwise. */
  schema: number;
  /** Stable machine identity (IDN-010). */
  machine_id: string;
  /** Hostname at write time; display only. */
  hostname: string;
  /** When this file was last written, RFC 3339 UTC. Drives liveness. */
  written_at: string;
  /** Plugin version that wrote the file. */
  plugin_version: string;
  /** Recent session snapshots, newest-first, at most MAX_SESSIONS. */
  sessions: SessionSnapshot[];
}

export class StateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateParseError";
  }
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isRfc3339(v: unknown): v is string {
  return isString(v) && v.length > 0 && !Number.isNaN(Date.parse(v));
}

/** Coerce one raw session entry to a valid snapshot, or throw StateParseError. */
export function sanitizeSession(entry: unknown): SessionSnapshot {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new StateParseError("session entry is not an object");
  }
  const o = entry as Record<string, unknown>;
  if (!isString(o.session_id) || o.session_id === "") {
    throw new StateParseError("session_id must be a non-empty string");
  }
  if (!isString(o.directory) || !o.directory.startsWith("/")) {
    throw new StateParseError(`directory must be an absolute path, got: ${JSON.stringify(o.directory)}`);
  }
  if (!isRfc3339(o.updated_at)) {
    throw new StateParseError("updated_at must be an RFC 3339 timestamp");
  }
  return {
    session_id: o.session_id,
    title: isString(o.title) ? o.title : null,
    directory: o.directory,
    git_branch: isString(o.git_branch) ? o.git_branch : null,
    git_commit: isString(o.git_commit) ? o.git_commit : null,
    git_dirty: typeof o.git_dirty === "boolean" ? o.git_dirty : false,
    updated_at: o.updated_at,
  };
}

export interface ParseStateOptions {
  /**
   * Skip malformed session entries instead of failing the whole file.
   * The probe uses this so one corrupt entry cannot hide the rest of a
   * machine's sessions; the plugin uses strict mode.
   */
  skipBadEntries?: boolean;
}

/**
 * Parse and validate a state file (FR-PROBE-040). Throws StateParseError on
 * invalid JSON, unknown schema, or invalid top-level fields. Entries are
 * de-duplicated by session_id keeping the first (newest) occurrence.
 */
export function parseState(text: string, opts: ParseStateOptions = {}): BreadcrumbState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StateParseError(`invalid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StateParseError("top-level value is not an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema !== SCHEMA_VERSION) {
    throw new StateParseError(
      `unsupported schema version: ${JSON.stringify(o.schema)} (expected ${SCHEMA_VERSION})`,
    );
  }
  if (!isString(o.machine_id) || o.machine_id === "") {
    throw new StateParseError("machine_id must be a non-empty string");
  }
  if (!isString(o.hostname) || o.hostname === "") {
    throw new StateParseError("hostname must be a non-empty string");
  }
  if (!isRfc3339(o.written_at)) {
    throw new StateParseError("written_at must be an RFC 3339 timestamp");
  }
  if (!isString(o.plugin_version) || o.plugin_version === "") {
    throw new StateParseError("plugin_version must be a non-empty string");
  }
  if (!Array.isArray(o.sessions)) {
    throw new StateParseError("sessions must be an array");
  }
  const sessions: SessionSnapshot[] = [];
  const seen = new Set<string>();
  for (const entry of o.sessions) {
    let snap: SessionSnapshot;
    try {
      snap = sanitizeSession(entry);
    } catch (e) {
      if (opts.skipBadEntries) continue;
      throw e;
    }
    if (seen.has(snap.session_id)) continue;
    seen.add(snap.session_id);
    sessions.push(snap);
  }
  return {
    schema: SCHEMA_VERSION,
    machine_id: o.machine_id,
    hostname: o.hostname,
    written_at: o.written_at,
    plugin_version: o.plugin_version,
    sessions,
  };
}

/** A snapshot annotated with the machine it was read from. */
export interface MergedSession extends SessionSnapshot {
  /** SSH target the probe used to read this machine. */
  host: string;
  machine_id: string;
  hostname: string;
  plugin_version: string;
}

/**
 * Merge state files from multiple machines into one list, annotated with the
 * source machine, sorted by updated_at descending (FR-PROBE-040/041).
 */
export function mergeSessions(sources: Array<{ host: string; state: BreadcrumbState }>): MergedSession[] {
  const out: MergedSession[] = [];
  for (const { host, state } of sources) {
    for (const s of state.sessions) {
      out.push({
        ...s,
        host,
        machine_id: state.machine_id,
        hostname: state.hostname,
        plugin_version: state.plugin_version,
      });
    }
  }
  out.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return out;
}

export function nowIso(d: Date = new Date()): string {
  return d.toISOString();
}

/** Compact human-facing age for a timestamp: "now", "5m", "2h", "3d", "5w", "2mo". */
export function relativeAge(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  let s = Math.round((nowMs - t) / 1000);
  if (s < 0) s = 0;
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w`;
  return `${Math.max(1, Math.floor(d / 30))}mo`;
}
