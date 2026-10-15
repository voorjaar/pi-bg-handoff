# pi-bg-handoff

Keeps long-running Bash commands from blocking the agent by handing them to a bundled, patched fork of
[ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) through its
EventBus v1 API. Routing is automatic — no in-band command markers.

One package: the handoff extension, the `background-commands` skill, and two vendored forks
(`pi-background-tasks`, `pi-agent-wait`).

## How routing works

Two paths, picked automatically:

- **Known-slow commands** — dev/watch servers (`npm run dev`, `tsc -w`), followers (`tail -f`,
  `docker compose up`), slow installs/builds (`npm ci`, `cargo build`, `pytest`) — go straight to a background
  task before the Bash call runs. The call is blocked and the result names the task id.
- **Everything else** runs in the foreground with a Bash `timeout` injected (default **120 s**). Finish in
  time and nothing changes. Run over and the partial output is kept while the command is re-run as a
  background task, whose id is appended to the result.

A command already seen exceeding the window goes straight to the background from then on.

To keep a command in the foreground, pass an explicit `timeout`: it is used as given and never handed off.

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

/bg-wait 30 let the server settle # arm a host-side wait from the keyboard
/bg-wait status                   # armed waits + remaining unattended waits
```

`/jobs` and `/logs <task-id>` (and `bg_status` / `bg_logs`) inspect handed-off tasks.

## Waiting: `bg_wait` and `bg_wait_for_task`

Host-side and yield-only, from the vendored `pi-agent-wait` fork — no blocking mode.

| Tool | Arms | Wakes a later turn when |
| --- | --- | --- |
| `bg_wait` | a timer (`seconds`, 1–300) | the timer elapses |
| `bg_wait_for_task` | a watcher on one task (`taskId`, budget 1–900 s) | the task reaches `completed` / `failed` / `killed`, or the budget runs out |

Both return immediately, so inference ends instead of hanging in a pending tool call; the timer/watcher runs
in the host while no model is running. Watches are event-driven, never poll `bg_status`, and never cancel
the task. On screen it is one `waiting …` spinner line, or a `waiting … 04:12 left` footer while the agent
works elsewhere. Enter hands control back to the user without cancelling the timer; Esc cancels the turn.
Only a bounded number of consecutive unattended waits is allowed. `PI_BG_HANDOFF_WAIT=0` registers nothing.

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
  "extraPatterns": ["^make\\b", "gradlew"]
}
```

Bad JSON, an unknown field, an out-of-range number, or a pattern that does not compile is **not fatal**:
defaults stay in force and the problems are reported once at session start. `/bg-handoff ...` overrides
everything for the session; `PI_BG_HANDOFF_CONFIG=<path>` relocates the file.

## Vendored forks

Each dependency is an ordinary upstream clone under `fork/` (gitignored) plus one patch file, built into
`dist/`. Upstream's `package.json`, `tsconfig*`, and docs are never edited, so a reviewer can clone the
pinned commit, apply the patch, and get the same source.

**`pi-background-tasks`** ([ismailsaleekh](https://github.com/ismailsaleekh/pi-background-tasks), MIT):
`bg_run` rejected quoted booleans (`"False"`, `0`) for `isAgent` inside `prepareArguments`, which Pi runs
*before* any extension hook and without logging it — the "bg_run is broken" symptom — so the fork coerces it
with upstream's own `coerceToolBooleanArgument`. A same-name `bg_run` override from here would lose upstream
behavior, `/bg-update` advertised registry installs for a vendored fork, and upstream enables every feature
by default, so the fork defaults `PI_BG_FEATURES` to `process`. The blue dock block became theme text colors.

**`pi-agent-wait`** ([AledHe/pi-agent-wait](https://github.com/AledHe/pi-agent-wait), MIT): pinned to
`yield` (blocking keeps a tool call pending inside the turn — the polling-shaped stall this project exists to
remove), renamed into the `bg_*` family so it cannot collide with another extension's generic `wait`, its
progress-bar panel replaced by one spinner line, plus `/bg-wait`. The blocking code stays in the source but
is unreachable, which keeps the patch small.

| Patch | Changes |
| --- | --- |
| `patches/pi-background-tasks.patch` | `core/common.ts` boolean coercion; `core/config.ts` feature default `process`; `extension.ts` coerce `isAgent`/`timeoutSeconds`, drop `/bg-update`; `ui/background-tasks-manager.ts` theme colors |
| `patches/pi-agent-wait.patch` | `src/index.ts` rename to `bg_wait`/`bg_wait_for_task`, pin yield, `PI_BG_HANDOFF_WAIT=0`, add `/bg-wait`; `src/wait-ui.ts` spinner + compact footer; `test-support/pi-coding-agent.d.ts` stub gains `registerCommand`/`ui.notify`; three waiting-UI tests |

After an upstream update:

```bash
npm run fork:pull && npm run fork:patch:check   # fails loudly if the patch no longer fits
npm run fork:patch:generate                     # re-export the patch after adjusting the sources
npm run verify:patches                          # clone each pinned upstream commit and apply --check
```

Also `fork:clone`, `fork:patch`, `fork:pristine`, and `verify:patches:offline` (the patch must reverse
cleanly inside each fork, whose HEAD is the pinned commit).

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

The build honors the same tokens (`node scripts/build.mjs --features=process,delegate`), so keep build-time
and runtime settings consistent — a feature enabled at runtime whose modules were trimmed cannot load.

## Verification

```bash
npm test             # selftest.mjs: fakes the Pi extension API + EventBus, drives real src/index.ts
npm run test:forks   # each fork's own suite against its patched tree
npm run build        # patches apply, entrypoints emitted, dist/ complete
npm run verify:patches
```

`selftest.mjs` covers handoff by pattern and by window, learned pre-empts, explicit `timeout` honored and
never handed off, fall-through when the manager is missing, the duplicate guard and its release, each
`/bg-handoff` switch, hidden guidance injected once per distinct content, the shipped skill path, and config
defaults plus degradation with every problem reported. Waiting is covered by the wait fork's own tests.
