---
name: klapz-run-worktrees
description: Launch klapz worktrees (klapz-server and/or klapz-web) locally on their own ports, beside the main checkout's server (32500) and web app (5180), to test a change for real. Use when a klapz change is ready to be tried, when the user asks how to test, run, restart or see a change in klapz, klapz-server or klapz-web, or asks whether the server or web app must be restarted. Offer it before launching; it builds the server and starts long-running processes.
---

# Running klapz worktrees locally

`scripts/run-worktrees.mjs`, in the klapz repository, starts a klapz-server worktree and/or a
klapz-web worktree on ports of their own, so several branches run side by side with the main
checkout. Run it from the root of the klapz repository.

## When to offer it

Offer it, in one short sentence, whenever a klapz change is ready to try in the real app: after
implementing something the user will want to click through, or when they ask how to test, or
whether to restart the server or the web app. **Ask before launching**: it compiles the server
(a minute or more the first time in a worktree) and starts processes that keep running.

Remind them, when relevant, that a change to the Rust server needs a restart of the server it
runs in, while the web dev server reloads its files by itself.

## Launching

1. Find the worktrees: the ones the task names, if it lists them, otherwise `git worktree list`
   in `klapz-server` and in `klapz-web`.
   Launch only the side(s) the change touches, plus the other one if the user wants to click
   through it: a web change alone runs against the main server by default.
2. Run it in the background (it stays in the foreground until stopped), with an instance name
   that says what is tested, such as the issue:

   ```sh
   node scripts/run-worktrees.mjs start \
     --server <klapz-server worktree> --web <klapz-web worktree> --name issue-1
   ```

3. Wait until its output holds `is running` (or `error:`), then tell the user what it printed:
   the web address to open, the server address to give on `/connect` (once per web port: the
   choice is then remembered), and that they sign in as `admin` with the `KLAPZ_ADMIN_PASSWORD`
   of their `.env`. Never print the password.
4. If it fails, read the log it names (`~/.klapz-dev/<name>/server.log` or `web.log`) and say
   what went wrong.

## Options worth knowing

- `--db copy` (default): the instance runs on its own copy of the main SQLite database, made on
  first start and kept; `--reset-db` copies it again. `--db fresh` starts empty. `--db shared`
  uses the main database itself: only with the user's agreement, since the branch's migrations
  then run on it.
- `--release` builds in release mode; `--skip-build` reuses the last build.
- `--server-url` with `--web` alone points the user at another server than the main one.
- The server inherits the main checkout's `.env` (found through git), then gets its own
  `KLAPZ_BIND`, database, `KLAPZ_TRAY=0` and the web port in `KLAPZ_CORS_ORIGINS`.

## Ports

Each instance name keeps its ports in `~/.klapz-dev/instances.json`: servers from 32510, web
apps from 5181. 32500, 5180, 32400 (Plex) and 4173 are never used, nor a port another instance
owns, nor one something else listens on (checked on 127.0.0.1, ::1 and 0.0.0.0). A port taken in
the meantime is replaced by the next free one, and the script says so. Vite runs with
`--strictPort`, so it fails rather than drift to a port the registry does not know.

## Status and stopping

```sh
node scripts/run-worktrees.mjs status
node scripts/run-worktrees.mjs stop --name issue-1
```

`stop` without `--name` stops every instance. Stop an instance before restarting it (after a
server change, say): `start` refuses to run a name that is already running. Leave instances
running at the end of a turn only when the user is about to test; say which ones are up.

## Things to tell the user when they matter

- Every instance and the main server listen on 127.0.0.1, and a browser keeps one cookie jar per
  host, not per port: signing in on one replaces the session cookie of the others. With the
  same `.env` (same session secret) and a copied database, the session stays valid on all of
  them.
- A copied database keeps the Plex pairing, and a server republishes its paired address to
  plex.tv at startup: the address stored, not the instance's, so nothing changes there.
