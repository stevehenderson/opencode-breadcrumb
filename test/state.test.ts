import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  MAX_PROMPT_LEN,
  SCHEMA_VERSION,
  StateParseError,
  mergeSessions,
  parseState,
  relativeAge,
  sanitizeSession,
  truncatePrompt,
} from "../shared/state.ts";

function validSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "ses_a",
    title: "a title",
    directory: "/home/dev/src",
    git_branch: "main",
    git_commit: "a1b2c3d4",
    git_dirty: false,
    updated_at: "2026-09-05T14:22:31Z",
    ...overrides,
  };
}

function validState(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    machine_id: "b3f1c2a4-5e6d-7a8b-9c0d-1e2f3a4b5c6d",
    hostname: "build-01",
    written_at: "2026-09-05T14:22:31Z",
    plugin_version: "0.1.0",
    sessions: [validSession()],
    ...overrides,
  };
}

test("parseState accepts a valid state file", () => {
  const s = parseState(JSON.stringify(validState()));
  assert.equal(s.schema, SCHEMA_VERSION);
  assert.equal(s.machine_id, "b3f1c2a4-5e6d-7a8b-9c0d-1e2f3a4b5c6d");
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].session_id, "ses_a");
  assert.equal(s.sessions[0].git_dirty, false);
});

test("parseState rejects unknown schema (FR-PROBE-040)", () => {
  assert.throws(() => parseState(JSON.stringify(validState({ schema: 2 }))), /unsupported schema/);
  assert.throws(() => parseState(JSON.stringify(validState({ schema: 0 }))), StateParseError);
});

test("parseState rejects invalid JSON, non-object, and missing/invalid fields", () => {
  assert.throws(() => parseState("definitely not json"), StateParseError);
  assert.throws(() => parseState("[1, 2, 3]"), StateParseError);
  assert.throws(() => parseState(JSON.stringify(validState({ machine_id: "" }))), /machine_id/);
  assert.throws(() => parseState(JSON.stringify(validState({ hostname: 5 }))), /hostname/);
  assert.throws(() => parseState(JSON.stringify(validState({ written_at: "yesterday" }))), /written_at/);
  assert.throws(() => parseState(JSON.stringify(validState({ sessions: "nope" }))), /sessions/);
  assert.throws(() => parseState(JSON.stringify(validState({ plugin_version: "" }))), /plugin_version/);
});

test("parseState skips bad entries when skipBadEntries, is strict otherwise", () => {
  const state = validState();
  state.sessions.push({ ...validSession(), session_id: "" });
  state.sessions.push(validSession({ session_id: "ses_rel", directory: "relative/path" }));
  assert.throws(() => parseState(JSON.stringify(state)), StateParseError);
  const lenient = parseState(JSON.stringify(state), { skipBadEntries: true });
  assert.deepEqual(
    lenient.sessions.map((s) => s.session_id),
    ["ses_a"],
  );
});

test("parseState dedupes session ids, keeping the first (newest) occurrence", () => {
  const state = validState();
  state.sessions.push(validSession({ updated_at: "2020-01-01T00:00:00Z" }));
  const s = parseState(JSON.stringify(state));
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].updated_at, "2026-09-05T14:22:31Z");
});

test("sanitizeSession coerces absent optional fields to null/false", () => {
  const s = sanitizeSession({ session_id: "s1", directory: "/d", updated_at: "2026-01-01T00:00:00Z" });
  assert.equal(s.title, null);
  assert.equal(s.git_branch, null);
  assert.equal(s.git_commit, null);
  assert.equal(s.git_dirty, false);
  assert.equal(s.last_prompt, null);
});

test("truncatePrompt collapses whitespace and clips with an ellipsis", () => {
  assert.equal(truncatePrompt("  fix   the\n\n ingress 502  "), "fix the ingress 502");
  const long = "a".repeat(MAX_PROMPT_LEN + 50);
  const t = truncatePrompt(long);
  assert.equal(t.length, MAX_PROMPT_LEN);
  assert.ok(t.endsWith("…"));
  assert.equal(truncatePrompt("hi", 10), "hi");
});

test("sanitizeSession reads and truncates last_prompt; empty/non-string -> null", () => {
  const s = sanitizeSession({
    session_id: "s1",
    directory: "/d",
    updated_at: "2026-01-01T00:00:00Z",
    last_prompt: "  refactor the\tauth module  ",
  });
  assert.equal(s.last_prompt, "refactor the auth module");
  const long = sanitizeSession({
    session_id: "s2",
    directory: "/d",
    updated_at: "2026-01-01T00:00:00Z",
    last_prompt: "x".repeat(MAX_PROMPT_LEN + 20),
  });
  assert.equal(long.last_prompt?.length, MAX_PROMPT_LEN);
  assert.equal(
    sanitizeSession({ session_id: "s3", directory: "/d", updated_at: "2026-01-01T00:00:00Z", last_prompt: "" }).last_prompt,
    null,
  );
  assert.equal(
    sanitizeSession({ session_id: "s4", directory: "/d", updated_at: "2026-01-01T00:00:00Z", last_prompt: 42 }).last_prompt,
    null,
  );
});

test("sanitizeSession rejects non-absolute directory and empty session id", () => {
  assert.throws(() => sanitizeSession({ session_id: "s", directory: "rel", updated_at: "2026-01-01T00:00:00Z" }), /absolute/);
  assert.throws(() => sanitizeSession({ session_id: "", directory: "/d", updated_at: "2026-01-01T00:00:00Z" }), /session_id/);
  assert.throws(() => sanitizeSession("nope"), StateParseError);
});

test("mergeSessions annotates with source machine and sorts by updated_at desc (FR-PROBE-041)", () => {
  const a = validState({ hostname: "alpha-host", machine_id: "ma" });
  a.sessions[0].updated_at = "2026-09-05T12:00:00Z";
  const b = validState({ hostname: "beta-host", machine_id: "mb" });
  b.sessions[0] = { ...b.sessions[0], session_id: "ses_b", updated_at: "2026-09-05T14:00:00Z" };
  const merged = mergeSessions([
    { host: "alpha", state: a },
    { host: "beta", state: b },
  ]);
  assert.deepEqual(
    merged.map((m) => m.session_id),
    ["ses_b", "ses_a"],
  );
  assert.equal(merged[0].host, "beta");
  assert.equal(merged[0].hostname, "beta-host");
  assert.equal(merged[0].machine_id, "mb");
  assert.equal(merged[0].plugin_version, "0.1.0");
});

test("relativeAge buckets", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.equal(relativeAge("2026-09-05T11:59:30Z", now), "now");
  assert.equal(relativeAge("2026-09-05T11:55:00Z", now), "5m");
  assert.equal(relativeAge("2026-09-05T10:00:00Z", now), "2h");
  assert.equal(relativeAge("2026-09-03T10:00:00Z", now), "2d");
  assert.equal(relativeAge("2026-08-29T10:00:00Z", now), "1w");
  assert.equal(relativeAge("2026-06-01T10:00:00Z", now), "3mo");
  assert.equal(relativeAge("2026-09-05T13:00:00Z", now), "now"); // future clock skew clamps
  assert.equal(relativeAge("garbage", now), "?");
});
