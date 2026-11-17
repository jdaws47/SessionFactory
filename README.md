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

The 🔕/🔔 button in the top bar turns on a chime when a crate enters the alert bay; if the tab is in the background you also get a desktop notification, and clicking it opens that crate. The top bar also counts finished turns today.

## Run

```bash
npm install
npm start            # http://127.0.0.1:4477
```

## Terminals

Click a crate to open its session in a terminal popup (⤢ for full screen; ✕ only detaches, and the session keeps running). This works for **factory terminals**, which are sessions started from:

- **+ New session** or the hopper on the floor
- `bin/sf` from any shell, which starts a factory terminal and attaches it right there. Detach with `Ctrl-b d` and reattach with `bin/sf attach <slot>`; list them with `bin/sf ls`

Every factory terminal opens in `clean-room/`, runs `scrub-in`, then `claude`. They run on a private tmux server (socket `run/tmux.sock`), so they survive closing the browser or restarting the app.

Sessions you start in an ordinary terminal still show up on the floor, but there's nothing to attach to. Once one ends, **Resume in a factory terminal** brings it back with full context.

The Warehouse can **Resume** an archived session or start a **New session, same label**, primed with how the last one finished.

In the terminal, Shift+drag selects text; tmux has the mouse otherwise.

## Jira

If the server starts in a shell that has run `scrub-in` (so the `JIRA_*` variables are set), **+ New session** and the hopper list your unresolved assigned tickets. **Start** opens a factory terminal primed with the ticket, and its crate carries the key. Every 5 minutes the server reads ticket statuses (read-only, through `.claude/skills/vida-jira/atlassian_cli.py`):

- A ticket that's resolved puts a **SHIP?** tag on its crate. It never archives anything.
- An archived crate whose ticket moves (reopened, back in progress…) lights up in the Warehouse and the "Returned" inbox. You decide whether to bring it back.

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
