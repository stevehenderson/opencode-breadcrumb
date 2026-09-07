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
work. opencode exits, the plugin exits. Nothing new ever listens on a work
machine.

**2. A probe, on your laptop: `crumb`.** One run reads every machine — the one
it runs on directly, the rest over SSH — merges the answers into a single
picker sorted newest-first, and resumes your pick on its original machine.
Remote resumes go over an interactive `ssh -t` inside a named tmux session, so
a dropped connection *detaches* instead of kills; a local resume is just a
child process. With no host list, crumb still works — against this machine.

```console
# ── Enroll the plugin on every machine (each runs it locally, once) ──────────
$ crumb install                                    # this laptop
installed breadcrumb.ts
installed shared/state.ts
Done — enrolled into ~/.config/opencode/plugins.

$ ssh build-01 'cd ~/src/breadcrumb && crumb install'
installed breadcrumb.ts
installed shared/state.ts

$ ssh gpu-2 'cd ~/src/breadcrumb && crumb install'
installed breadcrumb.ts
installed shared/state.ts

# ── Tell crumb which machines to read: this one + two remotes ────────────────
$ crumb hosts add local build-01 gpu-2
crumb: added local, build-01, gpu-2 → ~/.config/breadcrumb/hosts
$ crumb hosts list
1) local
2) build-01
3) gpu-2

# ── Later, from the laptop: one command reads all three, newest first ────────
$ crumb
 1) omlx      2m   fix-auth-refresh*  ~/dev/app         Refactor auth   » extract the token refresh into its own module
 2) build-01  18m  main               ~/src/platform    Ingress triage  » why is staging returning 502 on /api/orders
 3) gpu-2     1h   train-run-7        ~/ml/experiments  Eval sweep      » kick off the 7B eval on the new checkpoint
 4) omlx      3h   no-branch          ~/tmp/scratch     (untitled)
 5) build-01  1d   hotfix-logging     ~/src/platform    Log spam        » silence the debug logging in prod
select [1-5] (empty cancels): 2

resuming ses_9x82ndk3 on build-01 — /home/dev/src/platform
# crumb re-checks git over SSH (no drift), then opens the session in tmux on
# build-01 — you're back where you left off, working tree and all.
```

`*` marks a dirty working tree at last observation; `»` is the session's gist
(your last prompt). Rows 1 and 4 are this laptop (read directly, no SSH); the
rest are the remotes.

Each machine keeps two files: `state.json` (the plugin's snapshot) and
opencode's own `opencode.db`. crumb reads `state.json` for the sessions and
stats `opencode.db` to tell whether the plugin is still live.

Three constraints shaped the design:

- **SSH is the only channel to other machines.** No new listener, no new
  service, no new attack surface on work machines. Every remote access is
  initiated from the laptop with your own credentials (the local machine is
  read straight off disk). Freshness is pull-model: as fresh as your last
  `crumb` run.
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

Full specification: [`docs/breadcrumb-spec-v2.md`](docs/breadcrumb-spec-v2.md).
This repository implements the plugin and probe with live reads only; a local
cache, timeline UI, and remote dispatch are not built yet.

## Architecture

![Breadcrumb architecture](docs/readme-architecture.svg)

The `crumb` probe reads each machine's `state.json` (and stats `opencode.db`
for liveness): directly for the machine it runs on, over SSH for the rest. The
breadcrumb plugin writes `state.json`; opencode writes `opencode.db`. Resume is
an interactive `ssh -t` for remotes, or a plain child process locally.

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
shared/state.ts       state file types + parse/merge — single schema source
plugin/breadcrumb.ts  opencode plugin, one file
probe/crumb.ts        the `crumb` CLI (resume, health, install)
scripts/install.mjs   enrollment wrapper (same as `crumb install`)
test/                 node:test suite (unit + fake-ssh end-to-end)
docs/                 the spec and its figures
```

## Setup

### The `crumb` command (once, wherever you run it)

`crumb` is the single entry point for every operation — resume, health, and
plugin install. Put it on your `PATH`:

```sh
git clone https://github.com/stevehenderson/opencode-breadcrumb
cd opencode-breadcrumb
npm install
npm link            # or: npm install -g .   → `crumb` on PATH
```

Now `crumb`, `crumb health`, and `crumb install` all work. Prefer not to
install globally? Every example below also runs as `npm run crumb -- <args>`
or `node probe/crumb.ts <args>` (Node ≥ 23.6 or Bun; no build step).

### Each work machine (minutes)

1. Enroll the plugin (from a checkout on that machine):

   ```sh
   crumb install                   # or: node scripts/install.mjs
   ```

   This copies `plugin/breadcrumb.ts` to `~/.config/opencode/plugins/breadcrumb.ts`
   and `shared/state.ts` to `~/.config/opencode/plugins/shared/state.ts`.
   (opencode's plugin discovery is non-recursive, hence the two files; the
   plugin locates the shared module at runtime and needs no build step.)
   Pass `--dest <dir>` to enroll into a non-default plugin directory.

2. Start opencode once in any project. The plugin creates
   `~/.local/share/breadcrumb/` (mode 0700), the machine id (UUID, stable
   across hostname changes and reinstalls), and the first `state.json`.
   Every session start, idle, prompt, and end rewrites the file atomically
   (temp + fsync + rename), newest-first, capped at 200 entries. Each message
   you send updates that session's gist (its `last_prompt`).

### Your laptop (once)

crumb needs no host list to see the machine it runs on — `crumb`, `crumb
search`, and `crumb health` work immediately against this machine (read
directly, no SSH). The host list is only for reaching *other* machines.

1. To add other machines, manage the host list with `crumb hosts` (each target
   is anything `ssh` accepts — a hostname, `user@host`, or a `~/.ssh/config`
   alias; a `local` target means this machine, read directly):

   ```sh
   crumb hosts add build-01 office-mac devbox
   crumb hosts add local          # include this machine alongside the rest
   crumb hosts list               # 1) build-01  2) office-mac  …
   crumb hosts remove office-mac  # (alias: rm)
   crumb hosts path               # where the list lives
   ```

   It's just a text file (`~/.config/breadcrumb/hosts`, one target per line,
   `#` comments ok) if you'd rather edit it directly.

2. Verify key-based, non-interactive access:

   ```sh
   ssh -o BatchMode=yes build-01 echo ok
   ```

3. Optional but nice: `brew install fzf tmux` on the laptop; `tmux` on the
   work machines so a dropped connection detaches instead of kills a session.

### SSH configuration

Breadcrumb stores identity, not connectivity. Each line in the host list is an
opaque SSH *target* — a bare hostname, `user@host`, or a `~/.ssh/config` alias
— and crumb never parses a user, port, key, or proxy out of it. All connection
behaviour is delegated to your system `ssh` client and `~/.ssh/config`:
`HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, multiplexing,
`known_hosts`, and so on.

The only options crumb adds to `ssh` are `BatchMode=yes` (never prompt),
a per-host `ConnectTimeout` (`--connect`), and `-t` for the interactive resume.
It invokes `ssh` directly with an argument vector — no shell in between — so a
target is passed through verbatim and is never re-interpreted. Put anything
beyond the destination (jump hosts, non-default ports, specific keys) in
`~/.ssh/config`; a host line is a single token and cannot carry inline flags.

## Usage

```sh
crumb                           # read all hosts (or just this one), pick, resume
crumb search ingress 502        # same, but only sessions matching every term
crumb --local                   # this machine only, no SSH
crumb health                    # per-machine health, then exit
crumb install                   # enroll the plugin on this machine
crumb clean                     # prune stale/invalid entries on this machine
crumb hosts add build-01        # manage the SSH target list (list/add/remove)
```

- **No host list needed for the local machine.** With no `~/.config/breadcrumb/hosts`
  (or with `--local`, or a `local` entry in the list), crumb reads this
  machine's `state.json` straight off disk and resumes with a plain child
  process — no SSH involved. Add hosts to fan out to other machines.
- Reads every host concurrently (per-host `ConnectTimeout=3s`, overall
  deadline 10s); unreachable hosts never block the run.
- Merges all sessions, most-recent first, and shows a picker
  (`fzf` when present, numbered list otherwise):

  ```
   1) build-01  3m  fix-ingress-502*  /home/dev/src/platform  untitled  » fix the ingress 502 on staging
   2) office-mac  2h  main  /Users/me/dev/app  refactor auth  » extract the token refresh into its own module
   3) build-01  1d  no-branch  /home/dev/scratch  untitled
  select [1-3] (empty cancels):
  ```

  `*` marks a dirty working tree at last observation. `»` is the session's
  gist — the last prompt you sent — which the plugin records automatically.
- **Search** (`crumb search <terms>` or `--match <term>`, repeatable) keeps
  only sessions where every term appears — case-insensitively — in the machine,
  title, branch, directory, or the gist. With `fzf` you can also just type to
  filter the full list interactively; `search` narrows before the picker even
  opens (and works with `--plain`/scripts).
- Before resuming, `crumb` re-checks the directory and git state over SSH.
  If branch or commit differ from the snapshot, it shows the difference and
  asks for confirmation — it never checks out, stashes, or cleans anything.
- Resume is a single interactive `ssh -t <host>` call:
  `cd <dir> && opencode -s <session_id>`, wrapped in
  `tmux new -A -s bc_<session_id>` when the host has tmux (so `crumb` again
  reattaches instead of duplicating).
- Cancelling the picker exits 1 with no side effects.

### Options

Resume options (also accepted after `crumb health`, where relevant):

| Flag | Default | Meaning |
|---|---|---|
| `--hosts <file>` | `~/.config/breadcrumb/hosts` | alternate host list |
| `--local` | — | read only this machine, directly (no SSH) |
| `--plain` | — | force the numbered list even if `fzf` is installed |
| `--no-tmux` | — | resume without the tmux wrapper |
| `--deadline <ms>` | `10000` | overall read deadline |
| `--connect <ms>` | `3000` | per-host SSH `ConnectTimeout` |
| `--match <term>` | — | keep only sessions matching `<term>`; repeatable, all must match (`crumb search <terms>` is shorthand) |

`crumb install` takes `--dest <dir>` (default `~/.config/opencode/plugins`).
`crumb health` prints reachability, last write, live/STALE, and plugin version,
then exits 1 if any host is unreachable. (`crumb --health` is an accepted alias.)

`crumb clean` prunes **this machine's** state file (crumb never writes another
machine's files — to clean a remote, run it there). By default it removes only
entries that are not real opencode sessions — stray artifacts, e.g. from an
older plugin version; `--all` wipes every entry (a full reset), and `--dry-run`
shows what would go without writing. If pruned entries reappear, restart
opencode so the current plugin is the one running.

`crumb hosts` manages the SSH target list: `list` (default), `add <target…>`,
`remove <target…>` (alias `rm`), and `path`. Adds are de-duplicated and removes
preserve your comments and blank lines. Pass `--hosts <file>` to manage a list
other than the default `~/.config/breadcrumb/hosts`.

Exit codes: `0` resumed / all reachable; `1` cancelled, no sessions, resume
failed, or (for `crumb health`) some host unreachable; `2` configuration error.

### Liveness

For each reachable host the probe compares `state.json`'s `written_at` with
the mtime of `~/.local/share/opencode/opencode.db` read in the same SSH
round. If the database is more than an hour newer than the state file, the
plugin is presumed dead and the machine is flagged `STALE` in `crumb health`.

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
      "last_prompt": "fix the ingress 502 on staging",
      "updated_at": "2026-09-05T14:22:31Z"
    }
  ]
}
```

`last_prompt` is the session's gist — the most recent user prompt, whitespace
collapsed and clipped to 200 characters. The plugin captures it from opencode's
`chat.message` hook each time you send a message; it holds no other transcript
content. It is optional: state files written before the field, and sessions the
plugin never saw a prompt for, simply omit it (read as absent).

Both sides share one typed schema in `shared/state.ts`; the probe rejects
unknown `schema` values and warns instead of misparsing. A plugin that cannot
read an existing file (e.g. a newer schema) refuses to clobber it.

## Security

- No listener or new service is ever started on work machines; SSH is the
  only channel, initiated from the laptop with your own credentials.
- State file and its directory are owner-only (0700/0600). The file holds
  titles, paths, git refs, and a one-line gist (your last prompt, clipped to
  200 chars) — no full transcripts.
- All state-derived values are shell-quoted when composing remote commands
  (a tampered state file cannot inject commands at resume time).
- Residual risk: an attacker who already owns a machine's user account could
  plant a misleading state file on that machine only.

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

### Implementation notes

- `opencode -s <session_id>` is the resume flag on 1.18.29 (`--session`,
  "session id to continue"); the default launch is
  `cd <dir> && opencode -s <session_id>`.
- On 1.18.x the general `event` hook receives `session.created` /
  `session.updated` / `session.deleted` (`properties.info: Session {id, title,
  directory, …}`), `session.idle` (`properties.sessionID`), `message.updated`
  (`properties.info: Message`), and `message.part.updated`
  (`properties.part: Part`). The plugin uses the general hook and extracts
  defensively, because event shapes have changed across opencode versions.
- The tunable numbers are constants in the source — 5 s message-write throttle,
  3 s `ConnectTimeout`, 10 s run deadline, 1 h staleness — most adjustable via
  CLI flags.
- The probe uses only `node:` builtins, so it runs identically on Bun or
  Node ≥ 23.6 (no build step either way).
