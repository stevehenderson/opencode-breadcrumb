# Breadcrumb

**Find and resume your [OpenCode](https://opencode.ai) sessions across machines.**

Breadcrumb gives a developer with a laptop, devbox, build server, or GPU box a
single place to find recent opencode work. It remembers the workspace, branch,
commit, dirty state, and a short gist of the last prompt, then opens the saved
session on the machine where it started.

Breadcrumb is an excellent map and safe teleporter — "where is work happening, in what state, and let me (or an operator) get back into it without wrecking the tree."

```text
crumb = a searchable map of your distributed opencode work
```

## Why Breadcrumb?

Opencode sessions are local by design. A session belongs to the machine and
directory where it was created, and its useful context is split across two
places: the saved conversation and the working tree around it.

That is fine until work moves between machines. Then the questions become:

- Which machine has the session I was working on?
- Was it in `~/src/api` or `~/src/platform`?
- What branch was checked out, and did I leave uncommitted changes?
- What was I trying to do when I stopped?
- How do I get back into the same session without searching through terminals?

Breadcrumb turns those questions into one command. It is especially useful for
developers who:

- move between a local laptop and persistent remote workstations;
- leave long-running debugging, refactoring, or evaluation sessions on servers;
- keep multiple repositories or worktrees active at once; or
- want remote access without adding another daemon or service to every machine.

The key idea is simple: **the conversation is only half of the context.** The
branch, commit, directory, and dirty working tree explain what that conversation
means. Breadcrumb captures both sides without trying to manage your Git state
for you.

## See It In Action

Install the plugin on each machine where you run opencode, add those machines
to your host list, and run `crumb` from wherever you want to browse:

```console
$ crumb
  1) laptop    2m  fix-auth-refresh*  ~/dev/app       Refactor auth  » extract token refresh
  2) build-01 18m  main               ~/src/platform  Ingress triage  » investigate staging 502
  3) gpu-2     1h  train-run-7        ~/ml/evals      Eval sweep      » run the 7B evaluation
  4) laptop    3h  no-branch          ~/tmp/scratch   (untitled)
select [1-4] (empty cancels): 2

resuming ses_9x82ndk3 on build-01 — /home/dev/src/platform
```

Select a row and Breadcrumb re-checks the remote directory and Git state before
launching `opencode -s <session_id>`. If the workspace has drifted, it shows
you the difference and asks before continuing. It never checks out, stashes, or
cleans anything automatically.

`*` means the working tree was dirty at the last observation. The `»` text is a
compact, searchable version of your last prompt, not a transcript.

## The Architecture

Breadcrumb is intentionally small. There are two project components and no
service to operate:

![Breadcrumb architecture](docs/readme-architecture.svg)

### 1. An in-process plugin

`plugin/breadcrumb.ts` runs inside opencode on each enrolled machine. It listens
to session lifecycle and message events, captures the session metadata and Git
state, and atomically rewrites one small JSON snapshot at
`~/.local/share/breadcrumb/state.json`.

The plugin only runs while opencode runs. It opens no socket, starts no daemon,
and does not read or modify opencode's database. A machine stores at most 200
recent session snapshots, so state stays bounded and easy to inspect.

### 2. A laptop-side probe

`probe/crumb.ts` is the `crumb` CLI. It reads the local snapshot directly and
remote snapshots through the system `ssh` command, concurrently and with
deadlines. It validates and merges the snapshots, sorts them newest-first, and
offers an `fzf` picker or numbered fallback.

When you choose a session, the probe resumes it on its origin machine through
an interactive `ssh -t` command. Remote sessions use a named `tmux` session when
available, so a dropped connection detaches instead of killing your work.

### The contract between them

`shared/state.ts` is the single typed schema used by both writer and reader.
There is no queue, event broker, database migration, or synchronization
protocol. The state file is a current snapshot, written atomically with
temporary-file + `fsync` + rename.

That design gives Breadcrumb a useful property: it can be installed on a
machine without changing how opencode works, and it can be removed without
leaving a resident process behind.

## What You Get

### One command for distributed work

`crumb` aggregates sessions from every configured host into one list. The local
machine works immediately, even without a host file. Remote machines are
anything your existing SSH configuration accepts: a hostname, `user@host`, or a
`~/.ssh/config` alias.

### Context instead of opaque session IDs

Every row can include the machine, age, title, directory, branch, dirty marker,
and last-prompt gist. Search matches terms across those fields:

```sh
crumb search ingress 502
crumb search auth refresh
```

### Safe resume

Breadcrumb restores the opencode conversation, not your filesystem. It checks
the current remote Git state, reports changes from the saved snapshot, and lets
you decide whether to proceed. Your branch and working tree remain yours to
manage.

### Health without background monitoring

`crumb health` reports reachability, last write, plugin version, and whether a
machine looks stale. A host that is offline or slow does not block the rest of
the list: reads have a per-host connection timeout and an overall deadline.

### A small, security-conscious footprint

SSH remains the only inter-machine channel. Breadcrumb adds no listener or
network service. State files are owner-only, contain metadata rather than full
transcripts, and state-derived values are shell-quoted before being used in a
remote command. Unknown schema versions are rejected rather than guessed at.

## Install

### Requirements

- [opencode](https://opencode.ai) on every enrolled machine
- Node.js >= 23.6 or Bun for the probe
- `ssh` and `git` on every machine
- `fzf` for a richer picker and `tmux` on remote machines for detach-on-drop
  resume (both optional)

### Install the CLI

The probe is plain TypeScript. There is no build step and no runtime package
dependency:

```sh
git clone https://github.com/stevehenderson/opencode-breadcrumb
cd opencode-breadcrumb
npm install
npm link
```

This puts `crumb` on your `PATH`. If you do not want a global link, use
`npm run crumb -- <args>` or `node probe/crumb.ts <args>` instead.

### Enroll a work machine

Run this on each machine where opencode sessions should be discoverable:

```sh
crumb install
```

The installer copies the plugin and its shared schema to
`~/.config/opencode/plugins`. Start opencode once in a project to create the
machine identity and first state snapshot. The plugin then updates the snapshot
as sessions start, idle, end, and receive prompts.

### Add remote machines

The host list is just one SSH target per line at
`~/.config/breadcrumb/hosts`:

```sh
crumb hosts add local build-01 gpu-2
crumb hosts list
ssh -o BatchMode=yes build-01 echo ok
```

Use your normal `~/.ssh/config` for ports, identities, jump hosts, and proxy
settings. Breadcrumb delegates connection behavior to the system SSH client.

## Commands

```sh
crumb                           # browse this machine + all configured hosts
crumb --local                   # browse only this machine, without SSH
crumb --no-local                # browse only the remote hosts
crumb search <terms...>         # filter by machine, title, branch, path, or gist
crumb health                    # show reachability, freshness, and versions
crumb install                   # enroll the plugin on this machine
crumb clean                     # remove invalid entries from this machine
crumb hosts add build-01        # add SSH targets
crumb hosts remove build-01    # remove SSH targets
```

Useful options include:

| Option | Default | Purpose |
|---|---:|---|
| `--hosts <file>` | `~/.config/breadcrumb/hosts` | Use another host list |
| `--local` | off | Read and resume only on this machine |
| `--no-local` | off | Exclude this machine; read only the hosts |
| `--plain` | automatic | Force the numbered picker |
| `--no-tmux` | off | Resume without the remote tmux wrapper |
| `--connect <ms>` | `3000` | Per-host SSH connection timeout |
| `--deadline <ms>` | `10000` | Overall read deadline |
| `--match <term>` | none | Repeatable search filter |

`crumb clean` only writes the local machine's state file. Use `--dry-run` to
preview changes or `--all` for a full local reset.

## Design Boundaries

Breadcrumb is deliberately not:

- a replacement for opencode's session storage;
- a shell-history or Git-event recorder;
- a multi-user collaboration or sharing service;
- a system that migrates a session to a different machine; or
- an automatic Git cleanup, checkout, or stash tool.

Freshness follows the pull model: the list is as current as the last time you
ran `crumb`. This avoids polling and keeps work machines free of a new resident
service. A local cache, timeline UI, and remote dispatch are future
possibilities, not part of the current implementation.

## Development

```sh
npm install
npm test
npm run typecheck
```

The test suite exercises the real CLI as a subprocess with a fake SSH binary,
including read, merge, picker, pre-check, and resume behavior without a
network. The plugin is tested against temporary homes and real Git repositories.

The repository is organized around the small architecture:

```text
shared/state.ts       typed state schema and merge/parse helpers
plugin/breadcrumb.ts  in-process opencode plugin
probe/crumb.ts        laptop-side CLI
scripts/install.mjs   plugin enrollment wrapper
docs/                 specification and architecture figures
```

For the complete state format, event behavior, security model, and requirements,
see [`docs/breadcrumb-spec-v2.md`](docs/breadcrumb-spec-v2.md).
