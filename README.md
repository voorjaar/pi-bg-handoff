# pi-bg-handoff

A Pi extension that keeps long-running Bash commands from blocking the agent. It routes them to
**ismailsaleekh/pi-background-tasks** through that package's documented EventBus v1 API.

Routing is fully automatic. There are no in-band command markers.

## What it does

### 0. It ships the `background-commands` skill

`skills/background-commands/SKILL.md` lives inside this extension and is contributed through the
`resources_discover` event, so installing the extension enables the skill too — one artifact, one
enable switch.

```text
pi-bg-handoff/
├── index.ts
└── skills/background-commands/SKILL.md
```

It used to live in `~/.agents/skills/background-commands/`; that copy was moved here so the two are
not two different files with the same skill name (Pi keys skills by name, and one copy would be
dropped). Because the skill is discovered at startup/reload, `/bg-handoff off` silences the guidance
message but does not unload the skill until the next reload.

### 1. Pre-execution handoff

These commands are started as background tasks **before** the foreground Bash call runs, and the
original call is blocked with a message containing the task id:

- Commands matching built-in long-running patterns: dev/watch servers (`npm run dev`, `vite`,
  `next dev`, `nodemon`, `tsc watch`, …), followers (`tail -f`, `journalctl -f`,
  `docker compose up`), and sparse-output slow jobs (`npm ci`, `pnpm|yarn|bun install`,
  `cargo build|test`, `go test`, `pytest`, `playwright test`).
- Commands the fingerprint cache already saw exceed the window.

Waiting out a probe window for an unbounded command is pointless, so these skip the probe.

### 2. Timeout detection (every other Bash call)

The command runs in the foreground, but this extension injects the Bash tool's own `timeout`
argument first (default **120s**).

- Finishes inside the window → nothing changes. Normal result, normal exit code, no rewrite.
- Exceeds the window → the Bash tool kills it and keeps its partial output. This extension then
  **re-runs the command from the start as a tracked background task** and appends the task id to
  the result, so the agent sees the partial output plus where the live run went.

Pi cannot take an already-running foreground process and migrate it to the background, so the
timeout path re-executes rather than adopting the killed attempt. The cost is one bounded probe per
distinct command: the fingerprint cache (`learn`) remembers commands that exceeded the window, so an
identical command is handed off immediately afterwards without paying the probe again.

## Keeping a command in the foreground

Pass the Bash tool's own `timeout` argument. An explicit `timeout` is a foreground contract: it is
honored verbatim and **never** routed to the background, even for a pattern-matched command.

```python
bash(command="pytest -q", timeout=600)   # stays foreground, bounded at 600s
```

Deliberate backgrounding:

- Model: the `bg_run` tool (name, `isAgent`, `timeoutSeconds`, notification flags).
- Human: `/bg <command>`.

## Commands

```text
/bg-handoff status
/bg-handoff auto          # patterns + timeout detection (default)
/bg-handoff patterns      # patterns only, no timeout detection
/bg-handoff off           # disable this extension's hooks
/bg-handoff timeout 120   # foreground detection window, 1..3600s (default 120, or windowSeconds)
/bg-handoff task-timeout 14400   # hard timeout for handed-off tasks, 1..86400s (default 4h)
/bg-handoff policy wake|notify|silent
/bg-handoff learn on|off  # remember commands that exceeded the window (default on)
```

`/jobs` and `/logs <task-id>` (plus the `bg_status` / `bg_logs` tools) inspect handed-off tasks.

## Configuration file

Persistent defaults live in `~/.pi/agent/pi-bg-handoff.json` (the Pi agent directory). It is read
once when the extension loads, so edit it and restart or `/reload`. Every field is optional; a
missing file is the normal case.

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

| Field | Meaning | Range / values |
| --- | --- | --- |
| `windowSeconds` | foreground detection window (the injected Bash `timeout`) | integer `1..3600` |
| `taskTimeoutSeconds` | hard timeout handed to background tasks | integer `1..86400` |
| `mode` | `auto` (patterns + window), `patterns`, or `off` | one of those three |
| `policy` | `wake` (completion starts a turn), `notify`, `silent` | one of those three |
| `learn` | remember commands that exceeded the window so identical ones skip it | boolean |
| `guidance` | inject the model-facing guidance message at all | boolean |
| `extraPatterns` | extra regular expressions (case-insensitive), matched before the probe | array of strings |

Rules:

- Bad JSON, a non-object root, an unknown field, an out-of-range number, or a pattern that does not
  compile is **not fatal**. Each problem is skipped, the built-in default stays in force for it, and
  a warning naming every problem is shown once at session start. `/bg-handoff status` prints the
  config path and the number of ignored fields.
- `/bg-handoff ...` still overrides everything for the current session; the file only sets defaults.
- `PI_BG_HANDOFF_CONFIG=<path>` points the extension at a different file (useful for tests).
- The agent directory is computed locally (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) rather than
  imported from the Pi package, so `selftest.mjs` runs under plain `node`.

## Behavior details worth knowing

- **A blocked or timed-out Bash result is an error result.** Pi turns a blocked `tool_call` into an
  error tool result, and a timed-out command is already an error. The text explains the state
  unambiguously; commands that finish inside the window are not touched at all.
- **Re-execution is not idempotent-safe.** A command killed mid-flight at the window may already
  have applied side effects, and the background run starts over. For non-atomic commands, pass an
  explicit `timeout`.
- **Pattern matching is textual.** A command that merely *contains* a pattern string (for example a
  heredoc mentioning `npm run dev`) is matched. Pass an explicit `timeout` to keep such a call in
  the foreground.
- **Duplicate guard.** An identical command (same cwd) that is already handed off is blocked with
  the existing task id instead of being launched twice. The guard is released when the task reaches
  a terminal state.
- **Fail open.** If the manager is unavailable, pattern-matched commands fall through to timeout
  detection and `patterns` mode runs in the foreground.
- **Legacy `#bg ` / `#foreground ` prefixes** are no longer markers. They are stripped (so they
  cannot become a shell comment that silently swallows the command) and a one-time notice is shown.
- **Not a sandbox.** A background task runs with the same local permissions and environment as Pi.
  The manager's EventBus v1 `run` payload has no `cwd` field; tasks use the manager's current
  session context/cwd.
- **The fingerprint cache is in-memory per session.** It is not persisted to disk.
- **The guidance message is model-facing and injected once.** `before_agent_start` injects a custom
  message (`pi-bg-handoff-guidance`) with `display: false`, so the agent sees the routing contract
  while the transcript stays clean. Identical content is injected only once per session rather than
  once per turn; it is re-injected when the window changes or after a compaction or tree navigation,
  and never injected while `mode` is `off`. `display` is a boolean in Pi's `CustomMessage` contract —
  a non-boolean value such as `"none"` is truthy and renders the message on every turn.

## Install the correct manager first

```bash
pi install npm:pi-background-tasks@latest
```

Or the current GitHub main branch if you intentionally want the latest repository state:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@main
```

Then install this extension from the extracted directory:

```bash
pi install /absolute/path/to/pi-bg-handoff
```

Restart Pi or run `/reload` — extension code is loaded at session start, so edits to `index.ts` do
not apply to a running session.

## Verification

`selftest.mjs` fakes the Pi extension API and the pi-background-tasks EventBus, then drives the real
`index.ts`:

```bash
node --experimental-strip-types selftest.mjs
```

It asserts 39 behaviours: a fast command keeps a normal result, a command that exceeds the window
becomes a background task with its partial output preserved, the learned pre-emptive handoff, a
pattern pre-empt, a model-supplied shorter timeout honored and not handed off, an explicit timeout
outranking pattern routing, legacy markers stripped without semantics, a pattern command falling
through to the window when the manager is missing, the duplicate guard plus its release on terminal
state, `/bg-handoff timeout`, `learn off`, `off`, a hidden guidance message, guidance injected once
per distinct content (re-injected on a window change or after compaction, never while `off`), the
shipped skill path plus its `SKILL.md`, config-file defaults (window, task timeout, mode, policy,
guidance, extra patterns), an invalid config degrading to defaults with every problem reported, and
a missing config producing no warnings.
