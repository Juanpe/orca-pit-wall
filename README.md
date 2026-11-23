# Pit Wall

A read-only Orca side panel: **who is waiting on you, who is working, and how every worktree is doing**.
Built around "one task = one worktree = one session".

## What it shows

A header with **● live · time** (it switches to "no data" if refreshing stops) and three tabs.

**Overview**
- Six counters: waiting on you, working, idle, open sessions, projects and worktrees.
- An org chart: **YOU → projects → open sessions**. Each session is a node with a dot in its
  state's colour (red permission, amber question, grey idle, green done, blue working, which
  pulses), its worktree and how long it has been in that state. Projects waiting on you come first,
  with an amber border.
- **What to do now**: the 6 sessions that have been waiting on you the longest.

**Sessions**: everything waiting on you, everything working and, collapsed, the **opened, already
seen** ones: finished or idle sessions you already opened with a click from the panel. They don't
count as pending; if the agent moves again, it shows up as new. Questions and permission prompts
are never put aside.

**Worktrees**: all of them, by latest activity, with branch, PR (`draft`, `open`, `merged`),
checks and how many agents are waiting or working.

Click a session → focuses its terminal. Click a worktree → opens it. Refreshes every 5 s while the
panel is visible, and immediately when an agent changes state. Uses Orca's theme colours and
adapts to light and dark.

## Where the data comes from

- The plugin API (`workspace.list` with status and `agents.list` per workspace) is the source of
  truth: which worktrees and agents exist, and what state they are in.
- What the API doesn't provide (PR and checks, session title, last message, tool in progress) the
  worker adds by running `orca worktree ps --json` (read-only, cached for 4 s). If it fails, the
  panel keeps working and warns that those details are missing.
- Agents with no open terminal (closed sessions) don't appear under "Waiting on you".
- `Idle`: the API sometimes still says "working" when a session was cut off without telling Orca
  (Esc, Ctrl-C, a half-finished exit). If `orca worktree ps` doesn't see that agent working, the
  panel shows it as idle and under "Waiting on you", which is where it really is.

## Permissions it asks for

`trusted-worker` (its own Node code, to read Orca and run `orca worktree ps`),
`workspace:read`, `agent:read`, `workspace:write` and `storage:own`. `workspace:write` is only used
for `terminal.focus` and `workspace.open` on click; `storage:own` only stores the list of sessions
already seen, in the plugin's own folder. The plugin changes nothing in Orca.

## Enable, disable, remove

It is currently loaded as a development plugin from this folder (`local.pit-wall`):

```sh
orca plugin open local.pit-wall --panel pit-wall   # show the panel
orca plugin disable local.pit-wall                 # disable it
orca plugin enable local.pit-wall                  # re-enable it (asks for --approve again)
orca plugin dev unload .                           # remove it entirely (from this folder)
```

To install a fixed copy instead of the development folder:
`orca plugin dev unload .` and then `orca plugin install .` (asks for approval). To remove that
copy: `orca plugin uninstall local.pit-wall`.

With the plugin unloaded or uninstalled, Orca is left as it was: it touches no settings, no other
repos, and stores nothing outside its own plugin folder (which is deleted on uninstall).

## Development

```sh
orca plugin dev watch . --check --shot .orca/shots   # reload on save
orca plugin test . --json                             # src/*.test.ts
orca plugin shot local.pit-wall --width 320 --json    # panel screenshot
orca plugin dev request . snapshot --json             # what the worker answers the panel
npx -p typescript tsc -p .                            # types (after `orca plugin types .`)
```

- `src/model.ts`: joins API and CLI and orders the sections (pure logic, tested in `model.test.ts`).
- `src/worker.ts`: reads Orca and handles `snapshot` and `open`.
- `src/view.ts`: groups by project and separates new from seen (tested in `view.test.ts`).
- `panel/index.html` and `panel/app.ts`: the visual panel (HTML, CSS and the SVG org chart).
