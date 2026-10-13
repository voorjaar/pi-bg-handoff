---
name: background-commands
description: "Rules for any command that waits, sleeps, blocks, watches, follows, retries, serves, polls, or needs a timeout. Use whenever about to run sleep, wait loops, tail -f, watchers, dev servers, test suites, builds, curl or wget with timeouts, retry loops, or anything likely to run longer than a few seconds, and whenever a foreground command looks hung, stuck, or is about to be killed by a timeout. Routes all such work through pi-background-tasks (bg_run) so the agent never blocks the foreground and never lets a command hang, and forbids waiting for background tasks under any circumstances — always continue to the next task instead."
allowed-tools: bash bg_run bg_status bg_logs bg_kill
---

# Background Commands

## Core rule

Never wait — not in the foreground, not through a wait tool, not at all. If a
command sleeps, blocks, watches, or might run long, launch it with `bg_run`
immediately and keep working. A foreground `bash` call that blocks is a hung
call — it wastes the turn, risks a harness timeout kill, and gives the user
nothing while it sits there.

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

## Never wait for a background task

Do not wait for a launched task under any circumstances. There is no waiting
primitive to reach for — no sleep, no poll loop, no wait call. After launching
with `bg_run`:

1. Continue with the next task — any work that does not depend on the task's
   result.
2. If no such work exists, briefly acknowledge the launch and end the turn.

The completion notification wakes you automatically; the terminal notification
is durable truth, and you resume from it in a fresh turn. Dependency is never
an excuse to wait — even when the very next step needs the result, end the
turn and resume on the wake.

Never create a sleep-based wait loop. One launch, then move on.

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

**The very next step needs the test suite's result.**
Good: launch the suite with `bg_run`, do whatever independent work remains, end
the turn, resume on the completion notification. Ordering is preserved by the
wake — it only fires when the task terminates.
Bad: sleeping, polling `bg_status`, or otherwise waiting in this turn for the
suite to finish.

## Why this matters

Foreground blocking turns the agent into a stopwatch — the user watches an
idle spinner, harness timeouts silently kill useful work, and long pipelines
become one fragile tool call. Background tasks give every long command a
name, a timeout, a log file, and an event that wakes you exactly when it
matters. The agent stays responsive and never waits: it simply continues with
the next task and resumes when the notification arrives.
