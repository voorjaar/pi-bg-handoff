---
name: background-commands
description: "Rules for any command that waits, sleeps, blocks, watches, follows, retries, serves, polls, or needs a timeout. Use whenever about to run sleep, wait loops, tail -f, watchers, dev servers, test suites, builds, curl or wget with timeouts, retry loops, or anything likely to run longer than a few seconds, and whenever a foreground command looks hung, stuck, or is about to be killed by a timeout. Routes all such work through pi-background-tasks (bg_run) so the agent never blocks the foreground and never lets a command hang, and forbids block mode on the wait and wait_for_background_task tools (always yield)."
allowed-tools: bash bg_run bg_status bg_logs bg_kill wait wait_for_background_task
---

# Background Commands

## Core rule

Never wait in the foreground. If a command sleeps, blocks, watches, or might
run long, launch it with `bg_run` immediately and keep working. The same rule
covers the wait tools: `mode: "block"` is banned, always `yield`. A foreground
`bash` call that blocks is a hung call — it wastes the turn, risks a harness
timeout kill, and gives the user nothing while it sits there.

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

```
bg_run {
  name: "pytest suite",          # 2-6 human-readable words, not the raw command
  command: "cd /path && uv run pytest -q",
  isAgent: false,
  timeoutSeconds: 600            # optional hard cap so it can never hang forever
}
```

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

## Waiting when you truly must

When the very next step depends on a background task finishing, prefer the
event-driven primitives over sleeping:

1. `wait_for_background_task { taskId, timeoutSeconds, mode: "yield" }` —
   ends inference now and wakes you when the task terminates (or on timeout).
   This is the only allowed mode; it costs no idle inference.
2. `wait { seconds, mode: "yield" }` only when there is no task id to wait on —
   for example "give an external service 30 seconds to settle".

### `mode: "block"` is forbidden

Never pass `mode: "block"` to `wait` or `wait_for_background_task`. There is no
exception, including "the very next step depends on the result" — that case is
exactly what `yield` is for.

Why: a blocking wait parks the entire turn inside a pending tool call. The user
watches an idle spinner they cannot steer, sibling work is stalled, and a
harness timeout can kill the run mid-wait and lose it. A yielded wait costs
zero inference and the wake brings you back on its own.

If `yield` is refused because the consecutive-yield cap was hit, do **not**
fall back to `block` — report the current state to the user and stop waiting.

Never create a sleep-based wait loop. One wait, then reassess. The host caps
consecutive unattended yields; if you hit the cap, report state to the user
instead of waiting again.

## Timeout policy

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

**Need a bounded pause with nothing to wait on.**
Good: `wait { seconds: 30, mode: "yield", reason: "rate-limit window" }` as a
standalone call, then end the turn.
Bad: the same call with `mode: "block"` — pending tool call, idle run.

**The very next step needs the test suite's result.**
Good: `wait_for_background_task { taskId: "test suite", timeoutSeconds: 900, mode: "yield" }`,
end the turn, resume on the wake. Yield still preserves the ordering — the wake
only fires when the task terminates.
Bad: `mode: "block"` even here. Dependency is not an exception.

## Why this matters

Foreground blocking turns the agent into a stopwatch — the user watches an
idle spinner, harness timeouts silently kill useful work, and long pipelines
become one fragile tool call. Background tasks give every long command a
name, a timeout, a log file, and an event that wakes you exactly when it
matters. The agent stays responsive, and "waiting" costs zero inference.
