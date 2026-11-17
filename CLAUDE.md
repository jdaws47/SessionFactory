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
```

Environment: `SF_PORT` (default 4477), `SF_DATA_DIR` (default `./data`), `SF_JIRA_PROJECTS` (default `PORT,TF,BIOBK,VIDA,DQI`).

## Architecture

```
hooks/emit-event      Observe-only hook: appends the hook JSON to data/events/, always exits 0, prints nothing
scripts/hooks.mjs     Install/remove the hooks block; remove restores settings.local.json byte-for-byte
src/shared/types.ts   Crate / state types shared by server and web
src/server/
  events.ts           Hook envelope -> FactoryEvent (drops transcript_path on purpose)
  machine.ts          Pure zone state machine: (crate, event) -> crate
  labels.ts           Repo, Jira-key and label derivation; clean-room boundary check
  registry.ts         Persistent crate store (data/registry.json), session linking, archive, liveness
  ingest.ts           Drains data/events/ into the registry (fs.watch + polling)
  http.ts             Localhost-only HTTP + websocket server (Host/Origin checked)
  main.ts             Wiring, REST routes, state broadcast
web/
  layout.ts           Fixed 1600x900 floor: areas, slots, belt paths
  scene.ts            Canvas drawing and crate movement along belts
  ui.ts               Top bar, crate panel, tooltip, warehouse, returned inbox
  main.ts             Canvas loop, hit-testing, websocket subscription
```

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
- **Localhost only.** Bind `127.0.0.1` and keep the Host/Origin checks in `http.ts`.
