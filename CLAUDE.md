# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Session Factory is a personal, local-only web app that shows every Claude Code session running in `clean-room/` as a crate on a factory floor. Crates ride conveyors between zones as the session's state changes. It is a TypeScript Node backend (`ws` for push, plain `http`) and a Vite-built vanilla-TS canvas front end. It is not part of the VIDA platform and is never deployed.

## Commands

```bash
# Install
npm install                      # .npmrc sets legacy-peer-deps (npm 10 peer-resolution bug)

# Run locally (builds the front end, then serves http://127.0.0.1:4477)
npm start

# Dev: backend with reload + Vite dev server (http://127.0.0.1:5173, proxies /api and /ws)
npm run dev:server
npm run dev:web

# Test / typecheck
npm test
npm run typecheck

# Observe-only hooks in clean-room/.claude/settings.local.json
npm run hooks -- status | install | remove

# Factory terminals from a shell (scrub-in, then claude, on the private tmux server)
bin/sf | bin/sf ls | bin/sf attach <slot>
```

Environment: `SF_PORT` (default 4477), `SF_DATA_DIR` (default `./data`), `SF_JIRA_PROJECTS` (default `PORT,TF,BIOBK,VIDA,DQI`).

## Architecture

```
hooks/emit-event      Observe-only hook: appends the hook JSON to data/events/, always exits 0, prints nothing
scripts/hooks.mjs     Install/remove the hooks block; remove restores settings.local.json byte-for-byte
bin/sf                Start/attach factory terminals from any shell
tmux.conf             Config for the private tmux server (socket run/tmux.sock)
src/shared/types.ts   Crate / state types shared by server and web
src/server/
  events.ts           Hook envelope -> FactoryEvent (drops transcript_path on purpose)
  machine.ts          Pure zone state machine: (crate, event) -> crate
  labels.ts           Repo, Jira-key and label derivation; clean-room boundary check
  registry.ts         Persistent crate store (data/registry.json), session linking, archive, liveness
  ingest.ts           Drains data/events/ into the registry (fs.watch + polling)
  jira.ts             Read-only Jira via the vida-jira CLI (assigned tickets, statuses); never writes
  terminals.ts        tmux bridge: start/kill factory terminals, attach via node-pty; claudeCommand() builds the scrub-in line
  http.ts             Localhost-only HTTP + websocket server (Host/Origin checked)
  main.ts             Wiring, REST routes, state broadcast
web/
  layout.ts           Fixed 1600x900 floor: areas and props
  scene.ts            Canvas drawing and crate movement along belts
  belts.ts            One-way belt network: clockwise loop; one belt per zone (loop → zone → loop); every slot is on a
                      zone belt (dock/intake queues) or has its own in/out branch (assemblers, alert, storage). travel() routes
  shapes.ts           Squircle helpers; the canvas never draws true circles or ovals
  terminal.ts         xterm.js terminal attached to /ws/term/:slot
  ui.ts               Top bar, crate window (terminal or info), new-session dialog, warehouse, returned inbox
  main.ts             Canvas loop, hit-testing, websocket subscription
```

Factory terminals: the server starts `tmux new-session -e SF_SLOT=<slot>` in clean-room and types `scrub-in; cd <clean-room> && claude`. Hooks carry `SF_SLOT`, so the session links to the crate pre-registered for that slot. The browser attaches through `/ws/term/:slot` (a node-pty running `tmux attach`).

State flow: Claude hook → `hooks/emit-event` → `data/events/*.json` → `EventIngestor` → `Registry.ingest` → `applyEvent` → websocket broadcast → `Scene.setCrates`.

Zones: `intake` (started, no prompt yet) → `working` (prompt / tool use) → `alert` (permission prompt, question, elicitation) → `dock` (turn finished) → `storage` (session ended or process gone). Archived crates leave the floor for the Warehouse.

## Testing

Vitest, tests in `test/`. The state machine and registry are tested directly with events built by `test/helpers.ts`. The hook script is tested by running a copy of it under `test/.tmp/` (gitignored). Tests write only under `test/.tmp/`.

```bash
npm test
npx vitest run test/machine.test.ts
```

## Conventions

- JSDoc `/** */` for function docs; no comments that restate code.
- The front end has no framework: HTML strings with `esc()` for every interpolated value, and click handlers registered through `Ui.act()`.
- Keep `machine.ts` pure. Side effects (fs, timers, processes) live in `registry.ts`, `ingest.ts` and `main.ts`.

## Engineering Principles

- **Everything stays inside clean-room.** Never read `~/.claude` (no session files, no transcripts), `~/.bash_aliases`, or any other path outside `clean-room/`. Hook payloads carry `transcript_path`; it is dropped in `events.ts` and must never be used.
- **Only Archive takes a crate off the floor.** Process exit, timeouts and Jira status only move a crate to Storage or add a "ready to ship" hint. Nothing deletes crates.
- **The hooks are observe-only.** `emit-event` must never print, never exit non-zero, and never make a decision.
- **Never touch other Claude config.** The only allowed config change is the `hooks` key in `clean-room/.claude/settings.local.json`; any other change must be flagged to the user first.
- **Jira is read-only.** Only `search` through the vida-jira CLI; no transitions, comments or edits.
- **Localhost only.** Bind `127.0.0.1` and keep the Host/Origin checks in `http.ts`; the terminal websocket is a shell.
- **Claude only starts from clean-room, after scrub-in.** Every launch goes through `claudeCommand()` or `bin/sf`, and only on a user click.
- **Never auto-run scrub-in in tests or smoke checks.** It logs out of AWS SSO and switches repos to `main`; test the bridge with a harmless command instead.
