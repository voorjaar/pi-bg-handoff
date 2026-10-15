---
name: background-commands
description: "Rules for any command that waits, sleeps, blocks, watches, follows, retries, serves, polls, or needs a timeout. Use whenever about to run sleep, wait loops, tail -f, watchers, dev servers, test suites, builds, curl or wget with timeouts, retry loops, or anything likely to run longer than a few seconds, and whenever a foreground command looks hung, stuck, or is about to be killed by a timeout. Routes all such work through pi-background-tasks (bg_run) so the agent never blocks the foreground and never lets a command hang, and forbids foreground waiting — polling, sleeping, and waiting chatter are never allowed; host-side waits (bg_wait, bg_wait_for_task) are used only when the work must wait and nothing else is left to do."
allowed-tools: bash bg_run bg_status bg_logs bg_kill bg_wait bg_wait_for_task
---

# Background Commands

## Core rule

Never wait in the foreground. If a command sleeps, blocks, watches, or might
run long, launch it with `bg_run` immediately and keep working. A foreground
`bash` call that blocks is a hung call — it wastes the turn, risks a harness
timeout kill, and gives the user nothing while it sits there. Waiting that the
work genuinely requires is armed host-side (see `bg_wait` below), never paid for
with a blocked turn.

The question to ask before every shell command is not "will this succeed?"
but "how long will this occupy my turn?". Anything beyond a couple of seconds
belongs in the background.

## What must go to bg_run

Route these to `bg_run` (with `isAgent: false` — they are ordinary shell
commands, not LLM processes):

- Anything containing `sleep` — even `sleep 5`. A foreground sleep is pure
  dead time.
- Watchers and follow-mode — `tail -f`, `watch`, `fswatch`, hot-reload dev
  servers, `npm run dev`, `pytest --watch`, live-reload servers.
- Servers and long-lived processes — HTTP servers, databases, message brokers,
  anything that only ends when killed.
- Long jobs — test suites, builds (`npm run build`, `make -j`, Docker builds),
  installs, downloads, large `curl`/`wget` fetches, migrations.
- Retry/poll loops — `until curl ...; do sleep 2; done`, health-check loops,
  "wait for the server to come up" scripts.
- Commands that need their own timeout — `timeout 120 ...`, curl with a long
  `--max-time`, anything guarded so it cannot run forever. Put the timeout in
  `bg_run`'s `timeoutSeconds` instead of (or alongside) an in-shell `timeout`.
- Commands that may block on network or stdin and therefore hang — interactive
  CLIs, `git` over a flaky remote, `ssh` to a slow host.

Short deterministic commands (ls, grep, `git status`, a fast unit test) still
use plain `bash`. The rule is about blocking time, not importance.

## How to launch

```text
bg_run {
  name: "pytest suite",          # 2-6 human-readable words, not the raw command
  command: "cd /path && uv run pytest -q",
  isAgent: false,
  timeoutSeconds: 600            # optional hard cap so it can never hang forever
}
```

## Argument syntax: write the JSON literal

Every argument is JSON, and `bg_run` validates it strictly before it runs. A
boolean must be the lowercase JSON literal `true` or `false` — not a string, not
capitalised, not a number.

Bad — each of these is a hard tool error, and the command never starts:

```text
isAgent: False          ← capitalised, Python style
isAgent: True
isAgent: "false"        ← quoted string
isAgent: "False"
isAgent: 0              ← number, not boolean
isAgent: no
isAgent: null
timeoutSeconds: "600"   ← quoted number
notifyOnCompletion: "true"
```

Good:

```text
isAgent: false
isAgent: true
timeoutSeconds: 600
notifyOnCompletion: true
```

`isAgent` is required and has no default: omitting it is the same failure as
writing it wrong. `true` only when the command launches an LLM/agent process (a
child `pi -p ...` or `pi --mode json ...`); `false` for scripts, tests, servers,
sleeps, and ordinary shell commands.

If a call comes back with `bg_run requires isAgent boolean`, the value that
reached the tool was a string — re-issue the **same call** with the lowercase
literal. Do not switch to a different tool, and do not drop the argument.

`bg_run` returns immediately with a task id and an output path. From then on:

- Do not poll. With the default `notifyOnCompletion: true` and
  `triggerOnCompletion: true`, the terminal state (completed / failed / killed)
  arrives as a `<background-task-notification>` and wakes a follow-up turn
  automatically.
- After launching, continue only with work that is genuinely independent of
  the result. If there is none, briefly acknowledge the launch and end the
  turn — the notification will bring you back.
- Treat the notification as durable truth. Do not call `bg_status` to
  re-confirm it; call `bg_logs` only when you need the output itself.

## Waiting: `bg_wait` and `bg_wait_for_task`

Waiting is host-side and yield-only: there is no blocking mode. Both tools arm a
wake and return in the same call — the timer or task watcher runs in the host
while no model is running, and a later turn wakes when it resolves.

Use a wait tool **only** when the work genuinely must wait **and you have no
other useful work left in this turn**. If any independent work remains, do that
work instead of calling a wait tool — that is the normal case.

```text
bg_wait { seconds: 30, reason: "let the dev server finish booting" }
bg_wait_for_task { taskId: "b12ab34c", timeoutSeconds: 600, reason: "next step needs the suite result" }
```

- `bg_wait` arms a timer (`seconds` 1-300).
- `bg_wait_for_task` resolves from the task's own terminal event — it is
  event-driven, not a poll — and `timeoutSeconds` (1-900) is a budget, not a
  duration that must elapse: a terminal state always wakes early. Run `bg_run`
  first and pass the id it returned; sibling calls in one batch can race the id.
- A watch never cancels the task it watches; it only observes terminal state.
- Both return immediately. After arming, either continue with independent work
  or end the turn.
- Consecutive unattended waits are capped. If a call is refused with a message
  about too many unattended waits, report the state to the user instead of
  arming another wait.
- If the wait tools are absent or refuse with "waiting is disabled", the user
  turned this fork off (`"wait": false` in `pi-bg-handoff.json`,
  `PI_BG_HANDOFF_WAIT=0`, `/bg-wait off`, or `/bg-handoff wait off`): end the
  turn and let the task's own completion notification wake you.
- While anything is armed, the only waiting chrome is `⠋ waiting` plus what is
  being waited on (seconds left for a timer, the task label for a watch) inside
  the footer's ` bg … ` status line (a static `waiting` while you work on
  something else). There is no panel above the editor and no progress bar. The
  user arms a wait from the keyboard with `/bg-wait <seconds> [reason]`, inspects
  state with `/bg-wait status`, and switches the family off or back on with
  `/bg-wait off` / `/bg-wait on`. Pressing Enter during a wait moves it
  to the background so the user can redirect the agent.

### No waiting chatter

Never render waiting in your own output. Banned in replies and tool arguments:
`sleep`, `sleep N`, spinner or braille characters, `…`/`waiting…` prose, "I'll
wait for it", "polling", and repeated `bg_status`/`bg_logs` calls standing in for
a wait. The host already shows the spinner plus `waiting`; your output says nothing about it.

Polling is not a wait primitive: `bg_status` and `bg_logs` are point-in-time
inspection tools, and calling them in a loop to pass time is the exact behaviour
this skill forbids.

## Timeout policy

- Automatic handoff runs underneath every `bash` call: known-slow commands are
  handed to a background task before they run, and anything else is probed with
  an injected `timeout` and re-run in the background if it exceeds that window.
  With `windowSeconds: 0` (or `/bg-handoff timeout 0`) there is no probe at all:
  every `bash` call starts as a tracked background task, so take the task id from
  the blocked result and never re-run the command.
- A `timeout` argument you pass on `bash` is a budget, not a way to stay in the
  foreground: it bounds the probe, and exceeding it still hands the command off.
  Only the user keeps a command foreground, with `/bg-handoff patterns`,
  `/bg-handoff off`, or `/bg-handoff explicit-timeout foreground` (the older
  contract where an explicit timeout was honored verbatim).
- Every `bg_run` launch of something that could spin forever gets a
  `timeoutSeconds`. When exceeded, the task is failed and killed — that is the
  anti-hang backstop, and the notification tells you it happened.
- Do not use foreground `bash` timeouts as your hang protection. A foreground
  kill loses the running process and its partial output; `bg_run` keeps the
  output file and a clean terminal state.
- If a command genuinely needs a short bounded wait inside itself (e.g. a
  script that sleeps between retries), that sleep lives inside a `bg_run`
  command — not in your own tool calls.

## Handling hangs and leftovers

- If a previously launched task is no longer needed, `bg_kill` it. Do not
  leave dev servers and watchers running across the session.
- If a foreground command is already stuck (rare — you should have used
  `bg_run`), do not re-run it in the foreground hoping for the best. Re-run it
  via `bg_run` with a `timeoutSeconds` and inspect with `bg_logs`.
- To inspect a running task on deliberate request: `bg_status` (state) and
  `bg_logs` with a modest `maxBytes` (output). Both are point-in-time
  inspection tools, never wait loops.

## Worked patterns

**Wait for a server to become ready.**
Bad: `bash "sleep 10 && curl localhost:8080/health"` (blocks 10s, fragile).
Good: `bg_run` the server itself (no timeout, it is long-lived), then a second
short `bg_run` running `until curl -sf localhost:8080/health; do sleep 1; done`
with `timeoutSeconds: 60`, and end the turn — its completion notification
means the server is up.

**Run the test suite.**
Bad: foreground `bash "pytest"` that dies at the harness timeout mid-run.
Good: `bg_run { name: "test suite", command: "pytest -q", timeoutSeconds: 900 }`,
end turn, read results from the notification plus `bg_logs` if needed.

**Follow a log while working elsewhere.**
Good: `bg_run { name: "follow app log", command: "tail -f app.log" }` with no
timeout; check content later with `bg_logs`; `bg_kill` when done.

**The very next step needs the test suite's result.**
Good: launch the suite with `bg_run`. If independent work remains, do it and end
the turn — the completion notification brings you back. If nothing else is left
to do, arm `bg_wait_for_background { taskId: "<id>" }` and end the turn. Either
way: no sleep, no `bg_status` loop, no waiting text.
Bad: sleeping, polling `bg_status`, or otherwise blocking in this turn for the
suite to finish.

## Why this matters

Foreground blocking turns the agent into a stopwatch — the user watches an idle
spinner, harness timeouts silently kill useful work, and long pipelines become
one fragile tool call. Background tasks give every long command a name, a
timeout, a log file, and an event that wakes you exactly when it matters, and
host-side waits let the model sit idle instead of paying for polls. The agent
stays responsive, says nothing about waiting, and resumes on a wake.
