# Breadcrumb

You left that refactor running on `build-01` with a dirty working tree. You
don't remember the branch, the directory, or the session id — but you know you
were *in* it. **Breadcrumb finds it, shows you exactly where you were, and
puts you back in.** One command, from your laptop, across all your machines.

## The problem

You develop with [opencode](https://opencode.ai) on more than one machine —
laptop, devbox, build server. Sessions live per-machine, per-directory, in a
local SQLite file, and nowhere else. So:

- **Nothing is visible.** Which sessions exist, where, in which repo, on which
  branch, dirty or clean, how stale? No view exists. You re-discover your own
  work by guessing.
- **Resuming is memory work.** SSH in, remember the directory, remember the
  session id, hope the working tree is still the way you left it.
- **The conversation is the easy half.** What made the session valuable is the
  context around it — what git said when you last looked. A resumed chat with
  no context is just a chat.

## The approach

Two parts. Zero moving pieces.

**1. A plugin, on each machine, inside opencode.** It runs only while opencode
runs, listens to session lifecycle events, and atomically rewrites one small
JSON file: recent sessions, each with the git state — branch, HEAD, dirty —
captured *at the moment you last worked*. No daemon, no listener, no background
work. opencode exits, the plugin exits. (Constraint C1: nothing new ever
listens on a work machine.)

**2. A probe, on your laptop: `crumb`.** One run fans out a time-bounded read
over SSH to every machine, merges the answers into a single picker sorted
newest-first, and resumes your pick on its original machine over an
interactive `ssh -t` — inside a named tmux session, so a dropped connection
*detaches* instead of kills.

```
laptop                      work machines (N)
┌─────────────┐   ssh ────► ┌────────────────────────────┐
│ crumb (probe)│  ssh -t ◄── │ opencode + breadcrumb plugin│
└─────────────┘  resume     │  └─ ~/.local/share/breadcrumb/state.json
                            └────────────────────────────┘
```

Three constraints shaped the design:

- **SSH is the only channel.** No new listener, no new service, no new attack
  surface on work machines. Every access is initiated from the laptop with your
  own credentials. Freshness is pull-model: as fresh as your last `crumb` run.
- **State is a snapshot, not a log.** One small file, rewritten whole and
  atomically (temp + fsync + rename), capped at 200 sessions. No spool, no
  queue, no offsets. If a machine is down, `crumb` says so and moves on.
- **Git state is captured, not reconstructed.** It is recorded at observation
  time because that is the primary value. At resume, `crumb` re-checks the
  machine over SSH, *shows* any drift, and asks — it never checks out, stashes,
  or cleans on its own. Restoring the conversation must not silently restore
  (or destroy) your working tree.

And a data posture: one shared typed schema between writer and reader,
validation on both sides, unknown schemas rejected rather than misparsed, and
every state-derived value shell-quoted before it becomes a remote command. A
tampered state file can mislead the picker; it cannot inject.

Full specification: [`docs/breadcrumb-spec-v2.md`](docs/breadcrumb-spec-v2.md)
(BRC-SPEC-002). This repository implements **M1** (plugin + probe, live-read
only). M2 (local cache), M3 (timeline UI), and M4 (dispatch) are not built yet.

## Requirements

- opencode on each enrolled machine (developed and verified against 1.18.29;
  the plugin loads via the `@opencode-ai/plugin` typed hooks and the general
  `event` hook).
- Node.js ≥ 23.6 **or** Bun, for running the probe (plain TypeScript, no build
  step, no runtime dependencies).
- `ssh` and `git` on every machine; `fzf` and `tmux` optional but recommended
  on the laptop (picker UX) and on work machines (detach-on-drop resume).

## Layout

```
shared/state.ts       state file types + parse/merge (§5) — single schema source
plugin/breadcrumb.ts  opencode plugin, one file (§6, §8)
probe/crumb.ts        the `crumb` CLI (§7)
scripts/install.mjs   enrollment: copies the plugin into ~/.config/opencode/plugins/
test/                 node:test suite (unit + fake-ssh end-to-end)
docs/                 the spec and its figures
```

## Setup

### Each work machine (minutes)

1. Install the plugin:

   ```sh
   node scripts/install.mjs        # or: npm run install:plugin
   ```

   This copies `plugin/breadcrumb.ts` to `~/.config/opencode/plugins/breadcrumb.ts`
   and `shared/state.ts` to `~/.config/opencode/plugins/shared/state.ts`.
   (opencode's plugin discovery is non-recursive, hence the two files; the
   plugin locates the shared module at runtime and needs no build step.)

2. Start opencode once in any project. The plugin creates
   `~/.local/share/breadcrumb/` (mode 0700), the machine id (UUID, stable
   across hostname changes and reinstalls), and the first `state.json`.
   Every session start, idle, and end rewrites the file atomically
   (temp + fsync + rename), newest-first, capped at 200 entries.

### Your laptop (once)

1. Create the host list, one SSH target per line (`#` comments ok; any
   destination `ssh` accepts, including `~/.ssh/config` aliases):

   ```sh
   mkdir -p ~/.config/breadcrumb
   cat > ~/.config/breadcrumb/hosts <<'EOF'
   # my machines
   build-01
   office-mac
   devbox
   EOF
   ```

2. Verify key-based, non-interactive access:

   ```sh
   ssh -o BatchMode=yes build-01 echo ok
   ```

3. Optional but nice: `brew install fzf tmux` on the laptop; `tmux` on the
   work machines so a dropped connection detaches instead of kills a session.

## Usage

```sh
node probe/crumb.ts             # or: bun probe/crumb.ts   (npm run crumb)
```

- Reads every host concurrently (per-host `ConnectTimeout=3s`, overall
  deadline 10s); unreachable hosts never block the run.
- Merges all sessions, most-recent first, and shows a picker
  (`fzf` when present, numbered list otherwise):

  ```
   1) build-01  3m  fix-ingress-502*  /home/dev/src/platform  fix ingress 502 on staging
   2) office-mac  2h  main  /Users/me/dev/app  refactor auth
   3) build-01  1d  no-branch  /home/dev/scratch  untitled
  select [1-3] (empty cancels):
  ```

  `*` marks a dirty working tree at last observation.
- Before resuming, `crumb` re-checks the directory and git state over SSH.
  If branch or commit differ from the snapshot, it shows the difference and
  asks for confirmation — it never checks out, stashes, or cleans anything.
- Resume is a single interactive `ssh -t <host>` call:
  `cd <dir> && opencode -s <session_id>`, wrapped in
  `tmux new -A -s bc_<session_id>` when the host has tmux (so `crumb` again
  reattaches instead of duplicating).
- Cancelling the picker exits 1 with no side effects.

### Options

| Flag | Default | Meaning |
|---|---|---|
| `--health` | — | print per-machine health and exit (reachability, last write, live/STALE, plugin version); exit 1 if any host is unreachable |
| `--hosts <file>` | `~/.config/breadcrumb/hosts` | alternate host list |
| `--plain` | — | force the numbered list even if `fzf` is installed |
| `--no-tmux` | — | resume without the tmux wrapper |
| `--deadline <ms>` | `10000` | overall read deadline |
| `--connect <ms>` | `3000` | per-host SSH `ConnectTimeout` |

Exit codes: `0` resumed / all reachable; `1` cancelled, no sessions, resume
failed, or (for `--health`) some host unreachable; `2` configuration error.

### Liveness

For each reachable host the probe compares `state.json`'s `written_at` with
the mtime of `~/.local/share/opencode/opencode.db` read in the same SSH
round. If the database is more than an hour newer than the state file, the
plugin is presumed dead and the machine is flagged `STALE` in `--health`
(spec FR-PROBE-070).

## State file format

`~/.local/share/breadcrumb/state.json` — a whole-file current-state snapshot
(never an append log), rewritten atomically on each update:

```json
{
  "schema": 1,
  "machine_id": "b3f1c2a4-5e6d-7a8b-9c0d-1e2f3a4b5c6d",
  "hostname": "build-01",
  "written_at": "2026-09-05T14:22:31Z",
  "plugin_version": "0.1.0",
  "sessions": [
    {
      "session_id": "ses_9x82ndk3",
      "title": "fix ingress 502 on staging",
      "directory": "/home/dev/src/platform",
      "git_branch": "fix-ingress-502",
      "git_commit": "a1b2c3d4",
      "git_dirty": true,
      "updated_at": "2026-09-05T14:22:31Z"
    }
  ]
}
```

Both sides share one typed schema in `shared/state.ts`; the probe rejects
unknown `schema` values and warns instead of misparsing. A plugin that cannot
read an existing file (e.g. a newer schema) refuses to clobber it.

## Security

- No listener or new service is ever started on work machines; SSH is the
  only channel, initiated from the laptop with your own credentials.
- State file and its directory are owner-only (0700/0600). The file holds
  titles, paths, and git refs — no transcripts.
- All state-derived values are shell-quoted when composing remote commands
  (a tampered state file cannot inject commands at resume time).
- Residual risk per spec §10: an attacker who already owns a machine's user
  account could plant a misleading state file on that machine only.

## Development

```sh
npm install          # dev deps only (typescript, @opencode-ai/plugin types)
npm test             # node --test test/*.test.ts  (unit + fake-ssh end-to-end)
npm run typecheck    # tsc --noEmit
```

The test suite runs the real `crumb` CLI as a subprocess against a fake
`ssh` binary (canned state files, real git, real stdin), so the
read→merge→pick→precheck→resume path is exercised end-to-end without any
network. The plugin is tested against a temp `$HOME` with stub and real git.

### Spec notes (resolved open items)

- **OI-1**: `opencode -s <session_id>` is the correct resume flag on
  1.18.29 (`--session`, "session id to continue"); the default launch is
  `cd <dir> && opencode -s <session_id>`.
- **OI-2**: on 1.18.x the general `event` hook receives
  `session.created` / `session.updated` / `session.deleted`
  (`properties.info: Session {id, title, directory, …}`), `session.idle`
  (`properties.sessionID`), `message.updated` (`properties.info: Message`),
  and `message.part.updated` (`properties.part: Part`). The plugin uses the
  general hook and defensive extraction, per FR-PLUGIN-010.
- **OI-3**: proposed numbers are implemented as constants — 5 s message-write
  throttle, 3 s `ConnectTimeout`, 10 s run deadline, 1 h staleness — each
  flagged in the source and most adjustable via CLI flags.
- Probe runner: the spec suggests Bun; the code uses only `node:` builtins so
  it runs identically on Bun or Node ≥ 23.6 (no build step either way).
