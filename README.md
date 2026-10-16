# pi-bg-handoff

A long Bash command should not freeze the agent. This extension spots one, moves it to a background task,
and tells the agent the task id so it can check on it later with `/jobs` and `/logs`. It decides on its own —
you never mark a command.

Installing it gives you three things:

- the handoff extension and its `/bg-handoff` command;
- the `background-commands` skill, which teaches the agent when to background, when to wait, and when not to;
- the two patched forks it builds on: **pi-background-tasks** (the task manager) and **pi-agent-wait**
  (host-side waiting).

## How routing works

Two paths, picked automatically:

- **Known-slow commands** — dev/watch servers (`npm run dev`, `tsc -w`), followers (`tail -f`,
  `docker compose up`), slow installs/builds (`npm ci`, `cargo build`, `pytest`) — go straight to a background
  task before the Bash call runs. The call is blocked and the result names the task id.
- **Everything else** runs in the foreground with a Bash `timeout` injected (default **120 s**). Finish in
  time and nothing changes. Run over and the partial output is kept while the command is re-run as a
  background task, whose id is appended to the result.

A command already seen exceeding the window goes straight to the background from then on.

A `timeout` you pass on a Bash call is a budget, not a way to stay foreground: pattern-matched
commands are handed off anyway, and exceeding the window still re-runs the command in the background.
To keep commands foreground, the user runs `/bg-handoff patterns` or `/bg-handoff off`; `/bg-handoff
explicit-timeout foreground` restores the older contract where an explicit timeout was honored verbatim.

```python
bash(command="pytest -q", timeout=600)   # foreground, bounded at 600s
```

Deliberate backgrounding: `bg_run` (model) or `/bg <command>` (human).

## Commands

```text
/bg-handoff status                # mode, windows, config path, ignored fields
/bg-handoff auto|patterns|off     # patterns + timeout | patterns only | disabled
/bg-handoff timeout 120           # foreground detection window, 1..3600s
/bg-handoff task-timeout 14400    # hard timeout for handed-off tasks, 1..86400s
/bg-handoff policy wake|notify|silent
/bg-handoff learn on|off          # remember commands that exceeded the window
/bg-handoff explicit-timeout handoff|foreground   # does an explicit Bash timeout keep it foreground?
/bg-handoff wait on|off           # toggle the host-side wait tools for this session

/bg-wait 30 let the server settle # arm a host-side wait from the keyboard
/bg-wait status                   # armed waits + remaining unattended waits
```

`/jobs` and `/logs <task-id>` (and `bg_status` / `bg_logs`) inspect handed-off tasks.

## Waiting: `bg_wait` and `bg_wait_for_task`

Waiting comes from the **pi-agent-wait** fork. It is done by the host, not the model, and every wait returns
at once — there is no blocking mode.

| Tool | Arms | Wakes a later turn when |
| --- | --- | --- |
| `bg_wait` | a timer (`seconds`, 1–300) | the timer elapses |
| `bg_wait_for_task` | a watcher on one task (`taskId`, budget 1–900 s) | the task reaches `completed` / `failed` / `killed`, or the budget runs out |

Both return immediately, so inference ends instead of hanging in a pending tool call; the timer/watcher runs
in the host while no model is running. Watches are event-driven, never poll `bg_status`, and never cancel
the task.

The only waiting chrome is a segment in the footer's ` bg … ` status line:

```text
 bg 2 running · ⠋ waiting 12s                 # a 12-second timer is armed
 bg 2 running · ⠋ waiting npm test (b12ab3)   # watching one background task
 bg 2 running · waiting 12s ×2                 # two waits, agent doing other work
```

A timer shows the seconds left, a task watch shows the task it is waiting on.

There is no widget above the editor, no progress bar, and no Enter/Esc legend — Enter still hands control
back without cancelling the timer, Esc still cancels the turn. Only a bounded number of consecutive
unattended waits is allowed. Turn waiting off with `"wait": false` in the config file,
`PI_BG_HANDOFF_WAIT=0`, `/bg-wait off`, or `/bg-handoff wait on|off` for one session.

## Configuration

Defaults live in `~/.pi/agent/pi-bg-handoff.json`, read once at load (restart or `/reload` after editing).
All fields optional; a missing file is normal.

```json
{
  "mode": "auto",
  "windowSeconds": 120,
  "taskTimeoutSeconds": 14400,
  "policy": "wake",
  "learn": true,
  "guidance": true,
  "extraPatterns": ["^make\\b", "gradlew"],
  "explicitTimeout": "handoff",
  "wait": true,
  "footerHints": false
}
```

Bad JSON, an unknown field, an out-of-range number, or a pattern that does not compile is **not fatal**:
defaults stay in force and the problems are reported once at session start. `/bg-handoff ...` overrides
everything for the session; `PI_BG_HANDOFF_CONFIG=<path>` relocates the file. The wait fork reads `wait`
from this same file, so registration does not depend on extension load order.

**`"windowSeconds": 0`** (`/bg-handoff timeout 0`) removes the foreground probe entirely: every `bash` call
starts as a tracked background task and nothing is timed out and re-run. `1..3600` is the probing range;
`"mode": "off"` turns the routing itself off.

**Footer hints are off by default** in both forks: the ` bg … ` line carries task state only, with no
`Shift↓` / `CtrlAltB` / `/tasks` hint and no `/bg-clear` hint. Shift+Down and `/bg-clear` still work; they
are simply not advertised. `"footerHints": true` publishes `{ enabled: true }` on
`Symbol.for("pi-bg-handoff.footer-hints:v1")` to get the hints back; the manager reads the slot when the
footer renders, so extension load order never changes the answer. `PI_BG_FOOTER_HINTS` decides instead of the
file when it is set.

## Vendored forks

Neither dependency is used as published. Each is a normal clone of its upstream under `fork/` (gitignored)
plus one patch file, and the build applies that patch and compiles it into `dist/`. Upstream's
`package.json` and `tsconfig*` are never edited; the manager fork's patch also carries its own tests and
docs because upstream runs a docs-freshness gate that re-derives the public-surface inventory from `src/`.
Anyone can clone the pinned commit, apply the patch, and get the same source.

**`pi-background-tasks`** ([ismailsaleekh](https://github.com/ismailsaleekh/pi-background-tasks), MIT):
`bg_run` rejected quoted booleans (`"False"`, `0`) for `isAgent` inside `prepareArguments`, which Pi runs
*before* any extension hook and without logging it — the "bg_run is broken" symptom — so the fork coerces it
with upstream's own `coerceToolBooleanArgument`. A same-name `bg_run` override from here would lose upstream
behavior, `/bg-update` advertised registry installs for a vendored fork, and upstream enables every feature
by default, so the fork defaults `PI_BG_FEATURES` to `process`. The blue dock block became theme text colors.

**`pi-agent-wait`** ([AledHe/pi-agent-wait](https://github.com/AledHe/pi-agent-wait), MIT): pinned to
`yield` (blocking keeps a tool call pending inside the turn — the polling-shaped stall this project exists to
remove), renamed into the `bg_*` family so it cannot collide with another extension's generic `wait`, its
progress-bar panel replaced by one footer segment, plus `/bg-wait` and the shared `wait` switch. The blocking
code stays in the source but is unreachable, which keeps the patch small.

The two forks share three `Symbol.for(...)` slots instead of importing each other: `pi-bg-handoff.footer:v1`
(the manager owns the ` bg … ` status line; the wait fork pushes its `⠋ waiting …` segment into it and asks
for a repaint, falling back to its own status key when the manager is absent),
`pi-bg-handoff.wait-control:v1` (the wait fork registers itself so `/bg-handoff wait off|on` can disable its
tools mid-session), and `pi-bg-handoff.footer-hints:v1` (this extension publishes the resolved `footerHints` choice, default
`false`, so the manager knows whether to advertise its hint segments; read at render time, so load order is
irrelevant).

| Patch | Changes |
| --- | --- |
| `patches/pi-background-tasks.patch` | `core/common.ts` boolean coercion; `core/config.ts` feature default `process` and the `footerHints` switch defaulting to `off`; `extension.ts` coerce `isAgent`/`timeoutSeconds`, drop `/bg-update`, own the merged footer status line as colored text (no filled background); `ui/background-tasks-manager.ts` theme colors; upstream tests + docs regenerated to the fork's surface inventory |
| `patches/pi-agent-wait.patch` | `src/index.ts` rename to `bg_wait`/`bg_wait_for_task`, pin yield, honor the `wait` switch, register the wait-control slot, add `/bg-wait` with `status | off | on`; `src/wait-ui.ts` footer segment instead of the panel; `src/shared-config.ts` reads the shared config file; `test-support/pi-coding-agent.d.ts` stub gains `registerCommand`/`ui.notify`; waiting-UI tests |

After an upstream update:

```bash
npm run fork:pull && npm run fork:patch:check   # fails loudly if the patch no longer fits
npm run fork:patch:generate               # re-export the patch after adjusting the sources
npm run verify:patches                    # clone each pinned upstream commit and apply --check
```

Also `fork:clone`, `fork:patch`, `fork:pristine`, and `verify:patches:offline` (the patch must reverse
cleanly inside each fork, whose HEAD is the pinned commit). Every reset goes through
`scripts/fork-reset.mjs`, which deletes the files a patch *creates* before applying it — plain
`git checkout -- src/` leaves them behind and the next `git apply` fails with "already exists".

## Build and install

```bash
npm install      # runtime dep of the bundled manager + dev toolchain
npm run build    # reset forks to pristine, re-apply patches, build, serve dist/
pi install ./pi-bg-handoff
pi remove npm:pi-background-tasks   # otherwise the manager loads twice (load-order winner)
```

`dist/` is what gets served; `package.json` → `pi.extensions` names its three entries (`dist/index.js`,
`dist/background-tasks/extensions/background-tasks.js`, `dist/agent-wait/index.ts`), and the skill is
contributed through `resources_discover`. The build trims `dist/` to what can load — every `*.js.map` (62
files, 2.6 MB of the 4 MB compiled tree) and the subsystems behind disabled `PI_BG_FEATURES` tokens — by
walking static imports plus dynamic `import()` edges (skipping disabled subsystems), then re-checking that no
kept module statically imports a dropped file. Default feature set: 40 files / 689 KB for the manager subtree,
817 KB for `dist/`.

Throwaway session: `pi -e ./dist/index.js -e ./dist/background-tasks/extensions/background-tasks.js`.
Extension code loads at session start, so after editing `src/index.ts` or rebuilding, restart Pi or `/reload`.

## Feature switches

| Switch | Default | Effect |
| --- | --- | --- |
| `PI_BG_FEATURES` | `process` (fork patch; upstream defaults to all five) | `process` (bg_run/bg_status/bg_logs/bg_kill/jobs), `delegate` (bg_delegate, bg_result), `fusion` (fusion_*), `attested` (bg_run_pi_attested), `attribution` (Anthropic attribution rendering). `process` is mandatory; a bad token fails the load. |
| `PI_BG_HANDOFF_WAIT` | unset | `0` registers nothing from the wait fork. |
| `PI_BG_FOOTER_HINTS` | `off` (fork patch; upstream always advertises the hints) | `off` keeps the ` bg … ` footer to task state only: the dock-entry hint (`Shift↓` / `CtrlAltB` / `/tasks`) and the `/bg-clear` hint are dropped. Shift+Down and `/bg-clear` still work; they are just not advertised. `on` advertises them, and this variable wins over `"footerHints"` in the config file when both are present. |

The build honors the same tokens (`node scripts/build.mjs --features=process,delegate`), so keep build-time
and runtime settings consistent — a feature enabled at runtime whose modules were trimmed cannot load.

## Verification

```bash
npm test             # selftest.mjs: fakes the Pi extension API + EventBus, drives real src/index.ts
npm run test:forks   # each fork's own suite against its patched tree, incl. the manager fork's docs gate
npm run build        # patches apply, entrypoints emitted, dist/ complete
npm run verify:patches
```

On macOS the manager fork's suite ends 745/748. The three failures are upstream tests written for a Linux
host, not fork damage: `tests/unit/anthropic-attribution-fixture-portability.test.ts` compares resolved paths
against `os.tmpdir()`, which macOS reports as `/private/var/...`, and one `tests/unit/pi-launch.test.ts` case
expects a manifest read it never reaches on a darwin host.

`selftest.mjs` covers handoff by pattern and by window, learned pre-empts, explicit `timeout` honored and
never handed off, fall-through when the manager is missing, the duplicate guard and its release, each
`/bg-handoff` switch, hidden guidance injected once per distinct content, the shipped skill path, and config
defaults plus degradation with every problem reported. Waiting is covered by the wait fork's own tests.
