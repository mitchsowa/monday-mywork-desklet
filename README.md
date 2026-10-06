# monday.com My Work — Cinnamon desklet

Shows the monday.com items assigned to you, grouped Overdue / Today / Upcoming,
in monday's colour scheme. Done items are hidden by default, undated items are
hidden by default, and overdue rows don't show a date. Click a row to open it.

## Install

    mkdir -p ~/.local/share/cinnamon/desklets
    cp -r monday-mywork@mitch ~/.local/share/cinnamon/desklets/

Then right-click the desktop → Add Desklets → "monday.com My Work" → Add.
Right-click the desklet → Configure → paste your API token
(monday.com → your avatar → Developers → My access tokens).

## Settings

* **API** — your token. Boards are discovered automatically: every active
  board you can see that has a people column, subitem boards included, so new
  boards appear on their own. Optionally restrict to certain workspace ids,
  exclude specific board ids, and set how often the board list is rescanned
  (default every 15 minutes; the ↻ button forces a rescan).
* **Display** — show done, hide undated, hide date on overdue, max rows,
  width, font size, title.
* **Refresh** — auto-refresh on/off and interval (30 s minimum, 30 s steps).
  The ↻ button in the header refreshes on demand.

Each refresh batches 50 boards per GraphQL request, so a workspace with a few
hundred boards is a handful of calls. The `assigned_to_me` filter means it
follows whoever owns the token.

## Debugging

Errors show inline under the header. For stack traces:
`Alt+F2` → `lg` → Log tab, or `journalctl -f _COMM=cinnamon`.
After editing `desklet.js`, reload with `Alt+F2` → `r`, or:

    dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
      /org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
      string:'monday-mywork@mitch' string:'DESKLET'

Works on libsoup 2 and 3 (Cinnamon 5.x and 6.x).
