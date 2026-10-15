# pi-bg-handoff

A Pi extension that keeps long-running Bash commands from blocking the agent: it hands them to a
bundled, patched fork of
[ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) through that
package's EventBus v1 API. Routing is automatic — there are no in-band command markers.

It ships three things in one package: the handoff extension, the `background-commands` skill, and two
vendored forks (`pi-background-tasks`, `pi-agent-wait`).

## How routing works

**1. Pre-emptive handoff.** Commands matching built-in long-running patterns — dev/watch servers
(`npm run dev`, `vite`, `next dev`, `tsc -w`), followers (`tail -f`, `docker compose up`), sparse-output
jobs (`npm ci`, `cargo build`, `pytest`, `playwright test`) — are started as background tasks *before*
the foreground Bash call runs. The call is blocked with a message carrying the task id. Waiting out a
probe window for an unbounded command is pointless, so these skip the probe. Commands the fingerprint
cache already saw exceed the window are handed off the same way.

**2. Timeout detection (everything else).** The command runs in the foreground with the Bash tool's own
`timeout` injected (default **120 s**). Finishing inside the window changes nothing. Exceeding it lets
the Bash tool kill it and keep the partial output; this extension then re-runs the command as a tracked
background task and appends the task id, so the agent sees both the partial output and where the live
run went. Pi cannot migrate a running foreground process, so the timeout path re-executes; the
fingerprint cache means each distinct command pays that probe only once.

**Keeping a command in the foreground:** pass an explicit `timeout` — it is honored verbatim and never
routed to the background, even for a pattern-matched command.

```python
bash(command="pytest -q", timeout=600)   # stays foreground, bounded at 600s
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

`/jobs` and `/logs <task-id>` (and the `bg_status` / `bg_logs` tools) inspect handed-off tasks.

## Waiting: `bg_wait` and `bg_wait_for_task`

Host-side and yield-only, from the vendored `pi-agent-wait` fork. There is no blocking mode.

| Tool | Arms | Wakes a later turn when |
| --- | --- | --- |
| `bg_wait` | a timer (`seconds`, 1–300) | the timer elapses |
| `bg_wait_for_task` | a watcher on one task (`taskId`, `timeoutSeconds` budget 1–900) | the task reaches `completed` / `failed` / `killed`, or the budget runs out |

Both return immediately, so inference ends instead of sitting in a pending tool call; the timer/watcher
runs in the host while no model is running. Task watches are event-driven (resolved from the manager's
terminal frame), never polling `bg_status`. A watch never cancels the task, and `timeoutSeconds` is a
budget rather than a duration.

What the user sees is one line — `waiting …` with a spinner, or a compact `waiting … 04:12 left` footer
while the agent works elsewhere. Enter during a wait hands control back to the user without cancelling
the timer; Esc cancels the turn. A bounded number of consecutive unattended waits is allowed, after
which the host refuses another. `PI_BG_HANDOFF_WAIT=0` registers nothing from this fork.

## Configuration

Defaults live in `~/.pi/agent/pi-bg-handoff.json`, read once at load (restart or `/reload` after
editing). Every field is optional; a missing file is the normal case.

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
the built-in default stays in force and the problems are reported once at session start.
`/bg-handoff ...` still overrides everything for the session; `PI_BG_HANDOFF_CONFIG=<path>` relocates
the file.

## Details worth knowing

- **A blocked or timed-out Bash result is an error result.** Commands that finish in the window are not
  touched at all.
- **Re-execution is not idempotent-safe.** A command killed at the window may already have side effects
  and the background run starts over — pass an explicit `timeout` for non-atomic commands.
- **Pattern matching is textual.** A command that merely *contains* a pattern (a heredoc mentioning
  `npm run dev`) matches; an explicit `timeout` keeps it foreground.
- **Duplicate guard.** An identical command (same cwd) already handed off is blocked with the existing
  task id; the guard is released at the terminal state.
- **Fail open.** If the manager is unavailable, pattern-matched commands fall through to timeout
  detection.
- **Legacy `#bg ` / `#foreground ` prefixes** are no longer markers: they are stripped (so they cannot
  become a shell comment) with a one-time notice.
- **Not a sandbox.** Background tasks run with Pi's own permissions and session cwd (the manager's
  `run` payload has no `cwd` field).
- **The fingerprint cache is in-memory per session.**
- **The guidance message is model-facing and hidden.** Injected as a custom message with
  `display: false` (a boolean in Pi's contract — `"none"` is truthy and renders it every turn), once per
  distinct content, re-injected after a window change, compaction, or tree navigation, never while `off`.

## Fork strategy

Neither dependency is used as published. Each is carried as an ordinary upstream clone under `fork/`
(gitignored) plus one patch file, and built into `dist/`. Upstream's `package.json`, `tsconfig*`, tests,
and docs are never edited.

**Why fork `pi-background-tasks`** ([ismailsaleekh](https://github.com/ismailsaleekh/pi-background-tasks),
MIT) — four behaviors are unreachable from a companion extension:

1. **`bg_run` argument lexing.** `isAgent` was a strictly validated boolean, but model-written argument
   JSON regularly arrives as `"False"`, `"True"`, `"false"`, or `0`. Upstream rejected it inside
   `prepareArguments`, which Pi runs **before** `tool_call`, so no hook could see or repair the call —
   and the rejection was unlogged, which is why it looked like "bg_run is broken". The fix reuses
   upstream's own `coerceToolBooleanArgument`.
2. **A same-name override is not viable.** Registering another `bg_run` collides with the manager's
   registration and loses upstream behavior (`surviveReload`, task-result rendering).
3. **Presentation/commands that do not apply here.** The blue footer block, and `/bg-update` printing
   registry install instructions for a vendored fork.
4. **The feature default.** Upstream enables every feature unless `PI_BG_FEATURES` is set; the fork
   changes only the *default* to `process`, so this package serves the background-task core and nothing
   else (and the build can prune the rest). Any token can be re-enabled.

**Why fork `pi-agent-wait`** ([AledHe/pi-agent-wait](https://github.com/AledHe/pi-agent-wait), MIT):
only the yielding half of its design fits this workflow (blocking keeps a tool call pending inside the
turn — the polling-shaped stall this project exists to remove); the tools are renamed into the `bg_*`
family so they cannot collide with another extension's generic `wait`; its progress-bar panel is replaced
by one spinner line; and `/bg-wait` arms the same wait from the keyboard. The blocking code stays in the
source but is unreachable, which keeps the patch small.

| Patch | Files changed |
| --- | --- |
| `patches/pi-background-tasks.patch` | `core/common.ts` (boolean coercion, drop the removed command from the update segment), `core/config.ts` (`PI_BG_DEFAULT_FEATURES = process`), `extension.ts` (coerce `isAgent`/`timeoutSeconds` in `prepareArguments`, drop `/bg-update`), `ui/background-tasks-manager.ts` (theme text colors instead of the blue block) |
| `patches/pi-agent-wait.patch` | `src/index.ts` (rename to `bg_wait`/`bg_wait_for_task`, pin `mode: yield`, `PI_BG_HANDOFF_WAIT=0`, add `/bg-wait`), `src/wait-ui.ts` (one spinner line + compact footer), `test-support/pi-coding-agent.d.ts` (stub gains `registerCommand`, `ui.notify`), and three waiting-UI tests |

After an upstream update:

```bash
npm run fork:pull && npm run fork:patch:check   # fails loudly if the patch no longer fits
# adjust the sources, then:
npm run fork:patch:generate                     # re-export the patch from the working tree
npm run verify:patches                          # clone each pinned upstream commit and apply --check
```

Also: `fork:clone`, `fork:patch`, `fork:pristine`, `verify:patches:offline` (same claim without network
— the patch must reverse cleanly inside each fork, whose HEAD is the pinned commit).

## Build and install

```bash
cd /path/to/pi-bg-handoff
npm install        # runtime dep of the bundled manager + local dev toolchain
npm run build      # reset forks to pristine, re-apply patches, build, serve dist/
pi install ./pi-bg-handoff
pi remove npm:pi-background-tasks   # otherwise the manager loads twice (load-order winner)
```

`dist/` is what gets served:

```text
dist/
├── index.js                          # compiled src/index.ts
├── background-tasks/                 # patched manager, built by upstream's own build
│   ├── extensions/background-tasks.js
│   ├── src/**
│   └── package.json                  # name/version marker the compiled code reads
└── agent-wait/                       # patched pi-agent-wait (TypeScript, as upstream ships it)
```

`package.json` → `pi.extensions` points at those three entries. The skill is contributed by the
extension through `resources_discover`, so installing the extension enables the skill too.

The build trims `dist/` to what can actually load: every `*.js.map` (62 files, 2.6 MB of the 4 MB
compiled tree) and the subsystems behind disabled `PI_BG_FEATURES` tokens. Trimming is a reachability
walk over static imports plus dynamic `import()` edges (skipping disabled subsystems), followed by a
re-check that no kept module statically imports a dropped file — otherwise a wrong prune would appear
only at runtime. Default feature set: 40 files, 772 KB instead of 4.0 MB (924 KB for `dist/`).

For a throwaway session without installing:

```bash
pi -e ./dist/index.js -e ./dist/background-tasks/extensions/background-tasks.js
```

Restart Pi or `/reload` — extension code loads at session start, so edits to `src/index.ts` or a rebuilt
`dist/` do not apply to a running session.

## Feature switches

| Switch | Default | Effect |
| --- | --- | --- |
| `PI_BG_FEATURES` | `process` (fork patch; upstream defaults to all five) | `process` (bg_run/bg_status/bg_logs/bg_kill/jobs), `delegate` (bg_delegate, bg_result), `fusion` (fusion_*), `attested` (bg_run_pi_attested), `attribution` (Anthropic attribution rendering). `process` is mandatory; a bad token fails the load. |
| `PI_BG_HANDOFF_WAIT` | unset | `0` registers nothing from the wait fork: no `bg_wait`, no `bg_wait_for_task`, no `/bg-wait`. |

The build honors the same tokens (`node scripts/build.mjs --features=process,delegate`), so keep
build-time and runtime settings consistent: a feature enabled at runtime whose modules were trimmed
cannot load.

## Verification

```bash
npm test          # selftest.mjs: fakes the Pi extension API + the EventBus, drives real src/index.ts
npm run test:forks  # each fork's own suite against its patched tree
npm run build       # packaging check: patches apply, entrypoints emitted, dist/ complete
npm run verify:patches
```

`selftest.mjs` covers: fast commands keep a normal result; a command over the window becomes a background
task with partial output preserved; learned pre-emptive handoff; pattern pre-empt; a model-supplied
shorter timeout honored and not handed off; explicit timeout outranking pattern routing; legacy markers
stripped without semantics; fall-through when the manager is missing; the duplicate guard and its
release; `/bg-handoff timeout`, `learn off`, `off`; hidden guidance injected once per distinct content
(re-injected on window change/compaction, never while `off`); the shipped skill path; config defaults and
degradation with every problem reported. Waiting is covered by the wait fork's own tests.
