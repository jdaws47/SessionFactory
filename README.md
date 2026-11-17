# Session Factory

A factory floor for your Claude Code sessions. Each session started in `clean-room/` is a crate:

| Zone | Means |
|---|---|
| Intake | Session started, no prompt yet |
| Assembly hall | Claude is working (the machine shows the current tool) |
| Alert bay **!** | Permission prompt or a question for you |
| Loading dock | Turn finished; waiting for your next prompt (oldest at the front) |
| Storage | Session ended; stays until you archive it (gets a "SHIP?" tag after 3 days) |
| Freight → Warehouse | Archived. Browse, search and bring crates back from the Warehouse |

Only **Archive** removes a crate from the floor.

## Run

```bash
npm install
npm start            # http://127.0.0.1:4477
```

## How it sees your sessions

Observe-only hooks in `clean-room/.claude/settings.local.json` run `hooks/emit-event`. The script writes each hook event into `data/events/` and exits 0 without printing anything. The app reads nothing outside `clean-room/`.

```bash
npm run hooks -- status
npm run hooks -- remove   # restore settings.local.json exactly as it was
npm run hooks -- install
```

Sessions started before the hooks were installed show up after a restart.

## Known limits

- After you approve a permission prompt, the crate stays in the alert bay until that tool finishes, because Claude Code has no "permission granted" hook.
