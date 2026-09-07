# crumb — command reference

Every crumb command and flag, with a worked example. `crumb` is the single
entry point; with no subcommand it browses and resumes. See the top-level
[README](../README.md) for setup.

## A quick tour

```console
$ crumb
1) laptop  now  feature/rate-limiter*  /Users/me/dev/api  Add a rate limiter  » add a token-bucket limiter to the gateway
2) laptop  1h  main  /Users/me/dev/breadcrumb  Project review  » ok commit and push, opening a PR
3) laptop  1h  feature/readme-overhaul*  /Users/me/dev/breadcrumb  README overhaul  » overhaul the README for clarity
4) laptop  3h  no-branch  /Users/me/dev/labs  New session  » what's in this project
5) gpu-2  3h  main  /home/me/dev/vision  Deepest lunar crater  » what's the deepest crater on the moon
6) laptop  4h  no-branch  /Users/me/tmp/scratch  Quick note  » jot down tomorrow's deploy steps
7) laptop  12h  crumb-local-and-search  /Users/me/dev/breadcrumb  Repository overview  » what is in this repo
select [1-7] (empty cancels):
crumb: selection cancelled

# Narrow with a term — matches machine, title, branch, path, or gist:
$ crumb search rate
1) laptop  now  feature/rate-limiter*  /Users/me/dev/api  Add a rate limiter  » add a token-bucket limiter to the gateway
select [1-1] (empty cancels):
crumb: selection cancelled

$ crumb search readme
1) laptop  1h  feature/readme-overhaul*  /Users/me/dev/breadcrumb  README overhaul  » overhaul the README for clarity
select [1-1] (empty cancels):
crumb: selection cancelled

# Terms match remote machines too; pick 1 to resume it over SSH:
$ crumb search moon
1) gpu-2  3h  main  /home/me/dev/vision  Deepest lunar crater  » what's the deepest crater on the moon
select [1-1] (empty cancels): 1
resuming ses_9x82ndk3 on gpu-2 — /home/me/dev/vision
```

### Reading a row

```
laptop  now  feature/rate-limiter*  /Users/me/dev/api  Add a rate limiter  » add a token-bucket limiter to the gateway
  │      │    │                  │   │                  │                    └─ gist: your last prompt
  │      │    │                  │   │                  └─ session title
  │      │    │                  │   └─ working directory
  │      │    │                  └─ `*` = uncommitted changes at last observation
  │      │    └─ git branch (`no-branch` = detached/none)
  │      └─ age since last activity (now, 5m, 2h, 3d, …)
  └─ machine (this one is read directly; others over SSH)
```

## `crumb` (resume — the default)

Reads **this machine plus every configured host**, merges the sessions newest
first, shows a picker, and resumes your choice on its original machine.

- Reads run concurrently and are time-bounded; an unreachable host never blocks
  the run — it is simply skipped (see `crumb health` to find out why).
- The picker is [`fzf`](https://github.com/junegunn/fzf) when installed (type to
  fuzzy-filter, `enter` to choose, `esc` to cancel), otherwise a numbered list
  where you type a row number (empty input cancels).
- Before resuming, crumb re-checks the target over SSH: it confirms the
  directory still exists and compares the current git branch/commit with the
  snapshot. If they differ it **shows the drift and asks** — it never checks
  out, stashes, or cleans anything.
- Remote resume is an interactive `ssh -t` into a named tmux session
  (`bc_<session_id>`) so a dropped connection detaches instead of killing the
  session; a local resume is a plain child process. Either way the launch runs
  through an interactive login shell so your normal `PATH` (and `opencode`) is
  available.

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--local` | off | Read and resume only this machine (no SSH) |
| `--no-local` | off | Exclude this machine; read only the hosts |
| `--hosts <file>` | `~/.config/breadcrumb/hosts` | Use an alternate host list |
| `--match <term>` | — | Keep only sessions matching `<term>`; repeatable, all must match |
| `--plain` | auto | Force the numbered picker even when `fzf` is present |
| `--no-tmux` | off | Resume without the tmux wrapper |
| `--connect <ms>` | `3000` | Per-host SSH `ConnectTimeout` |
| `--deadline <ms>` | `10000` | Overall deadline for the read fan-out |

## `crumb search <terms…>`

Shorthand for one or more `--match` filters: keeps only sessions where **every**
term appears (case-insensitively) in the machine, title, branch, directory, or
gist, then behaves exactly like `crumb` (pick and resume). Trailing flags are
allowed, e.g. `crumb search ingress --plain`.

```console
$ crumb search vision main       # AND: must match "vision" and "main"
$ crumb --match vision --match main   # identical, using the flag form
```

## `crumb health`

Prints a per-machine status table and exits, without opening the picker. Exits
`1` if any host is unreachable. (`crumb --health` is an accepted alias.)

```console
$ crumb health
HOST     REACHABLE  LAST WRITE                       STATE  PLUGIN
laptop   yes        2026-09-07T02:20:00Z (now)       live   0.1.0
gpu-2    yes        2026-09-06T23:11:00Z (3h)        live   0.1.0
build-1  no         —
  build-1: Connection timed out
```

- **STATE** is `live`, `STALE`, `no state`, or `bad state`. `STALE` means the
  machine's `opencode.db` was modified more than an hour after the state file
  was last written — a sign the plugin isn't running (or isn't enrolled) even
  though opencode is.
- **LAST WRITE** is when the plugin last rewrote the snapshot.

## `crumb install [--dest <dir>]`

Enrolls the plugin on **this** machine by copying `breadcrumb.ts` and its shared
schema into `~/.config/opencode/plugins` (override with `--dest`). Run it on
every machine whose sessions should be discoverable, then start opencode once.

## `crumb clean [--all] [--dry-run]`

Prunes **this machine's** state file (crumb never writes another machine's
files — to clean a remote, run it there).

| Flag | Meaning |
|---|---|
| *(none)* | Remove only entries that aren't real opencode sessions (stray artifacts) |
| `--all` | Remove every entry — a full reset — keeping the file and machine id |
| `--dry-run`, `-n` | Show what would be removed; write nothing |

```console
$ crumb clean --dry-run
crumb: would remove 2 entries, keep 5:
  - msg_07af…  /Users/me/dev/api  (untitled)
  - msg_07b0…  /Users/me/dev/labs  (untitled)
```

If pruned entries reappear, restart opencode so the current plugin is the one
running.

## `crumb hosts <list|add|remove|path>`

Manages the SSH target list (`~/.config/breadcrumb/hosts`; `--hosts <file>` for
another). crumb only ever writes **this** machine's list.

```console
$ crumb hosts add build-01 gpu-2 local   # append targets (deduped)
crumb: added build-01, gpu-2, local → ~/.config/breadcrumb/hosts
$ crumb hosts list
1) build-01
2) gpu-2
3) local
$ crumb hosts remove gpu-2                # alias: rm
crumb: removed gpu-2 → ~/.config/breadcrumb/hosts
$ crumb hosts path
~/.config/breadcrumb/hosts
```

- A target is anything `ssh` accepts: a hostname, `user@host`, or a
  `~/.ssh/config` alias. Whitespace and `#`-comments are rejected as targets.
- The special target `local` (or `localhost`) means **this machine, read
  directly** — handy to keep the current box in a list of remotes.
- `remove` preserves your comments and blank lines.

## The host list & the local target

- One target per line; blank lines and `#` comments are ignored; duplicates are
  collapsed.
- crumb **always reads this machine too**, alongside the hosts, so local and
  remote sessions appear together. Use `--no-local` to exclude it or `--local`
  for this machine only.
- With no host list at all, crumb just reads this machine.
- crumb stores only the target string — never a user, port, key, or proxy. All
  connection behavior is delegated to your system `ssh` and `~/.ssh/config`.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Resumed a session, or `crumb health` found every host reachable |
| `1` | Cancelled, no sessions, resume failed, or a host was unreachable (`health`) |
| `2` | Configuration error (bad flag, unreadable explicit `--hosts`, missing search term) |
