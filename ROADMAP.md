# pi-bg-handoff roadmap

Status: **v0.5.0**, in daily use as a local Pi extension at `~/.pi/agent/extensions/pi-bg-handoff/`.

This repository starts at the v0.5.0 snapshot. Earlier versions were never in git, so the entries
below for v0.2 and v0.4 are reconstructed from project memory and from the shape of the code, not
from commit history. Each item states what it does and, where it was measured, how it was measured.

## Shipped

### v0.2 — pattern pre-empt (reconstructed)

- Handoff fired only for a hard-coded `AUTO_PATTERNS` list: dev/watch servers, followers
  (`tail -f`, `journalctl -f`, `docker compose up`), installs (`npm ci`, `pnpm|yarn|bun install`),
  and slow test/build jobs (`cargo build|test`, `go test`, `pytest`, `playwright test`).
- No duration heuristic: `tail -f /dev/null` was handed off, while `sleep 120` blocked the turn for
  the full 120 seconds in the foreground.
- Routing was driven by in-band `#bg ` / `#foreground ` command markers.
- Duplicate guard bug: terminal cleanup deleted `commandToTask.get(command)` instead of the composite
  `cwd + NUL + command` key, so an identical command stayed blocked **forever** after one handoff.

### v0.4 — automatic routing

- Pre-execution handoff for pattern matches and for commands the fingerprint cache already saw
  exceed the window.
- Timeout detection for everything else: the Bash tool's own `timeout` argument is injected
  (default 30s at the time). A command that finishes inside the window is untouched; one that
  exceeds it is killed by the Bash tool with its partial output preserved, then **re-run from the
  start** as a tracked background task by the `tool_result` handler.
- `#bg ` / `#foreground ` markers removed. A leading marker is only stripped, so it cannot become a
  shell comment that silently swallows the command.
- The model's foreground escape hatch became the Bash `timeout` argument: an explicit `timeout` is
  honored verbatim and outranks pattern routing.
- Duplicate guard fixed by storing the composite key in `taskToCommand`.
- Why re-execution instead of adoption: Pi cannot migrate an already-running foreground process to
  the background, and a blocked `tool_call` becomes an error tool result whose `tool_result` handlers
  never run. A *thrown* tool error does reach `tool_result`.
- Verified live in a real Pi session: `sleep 45 && echo ...` returned `Command timed out after 30
  seconds` plus the handoff notice naming the new task id, then completed as a normal background task
  (`status: completed`, `exit-code: 0`, output file readable with `bg_logs`). Full loop: kill →
  re-run → notification → `bg_logs`.

### v0.5 — configuration, guidance, and the bundled skill

- **Default window is 2 minutes.** `DEFAULT_WINDOW_SECONDS = 2 * 60`. `/bg-handoff timeout <1..3600>`
  still overrides it per session.
- **Guidance message fixed.** It was injected with `display: "none"`, but `display` is a **boolean**
  in Pi's `CustomMessage` contract and the TUI renders any truthy value, so the guidance block
  printed into the transcript on every turn. It is now `display: false`, which keeps the message in
  model context (`convertToLlm` maps role `custom` to a user message regardless of `display`) while
  hiding it from the UI.
- **Guidance deduplicated.** Identical content is injected once per session instead of once per turn.
  It is re-injected when the window changes or after `session_compact` / `session_tree`, and never
  while `mode` is `off` or when `messageType` is `custom`.
- **The `background-commands` skill ships inside the extension** at
  `skills/background-commands/SKILL.md`, contributed through `resources_discover` → `skillPaths`.
  It moved out of `~/.agents/skills/`, which was deleted: `loadSkills` keys skills by **name**, so a
  copy left in `~/.agents/skills` would win and the extension's copy would be silently dropped.
- **Persistent defaults** in `~/.pi/agent/pi-bg-handoff.json`: `mode`, `windowSeconds`,
  `taskTimeoutSeconds`, `policy`, `learn`, `guidance`, `extraPatterns`. Every problem (bad JSON,
  non-object root, unknown field, out-of-range number, uncompilable pattern) is non-fatal: the field
  falls back to the built-in default and the problem is reported once at `session_start`.
  `PI_BG_HANDOFF_CONFIG=<path>` overrides the location.
- The agent directory is computed locally (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`) instead of
  importing `getAgentDir()` from the Pi package: a bare package specifier is not resolvable from
  `~/.pi/agent/extensions/**` under plain `node`, only through Pi's jiti aliases, which broke
  `selftest.mjs` with `ERR_MODULE_NOT_FOUND`.
- `/bg-handoff status` now reports `guidance=`, `config=<path>`, and the ignored-field count.
- `selftest.mjs` grew from 17 to 39 assertions and was refactored into a `makeHost()` factory so a
  second fake host can exercise config loading without leaking the real user config into other tests.

## Verified behaviour (live measurements, 2026-10-13)

| Scenario | Result |
| --- | --- |
| `echo` fast command | Normal result, no injection, no rewrite |
| `sleep 15` with a 20s window | Normal foreground completion |
| `sleep 30` with a 20s window | Killed at 20s, partial output kept, re-run from the start as a task |
| Re-run of the identical command | Blocked with `already handed off as background task <id>` while running; after the task went terminal, `already exceeded the 20s window earlier in this session` with no probe |
| `tail -f /dev/null` | Pre-empted with zero probe, reason names the matched pattern |
| `bg_kill` on a handed-off task | `status: killed`, `exit-code: null`, duplicate guard released |
| Config `{"windowSeconds": 20}` + reload | Guidance text and every injected timeout said 20s |
| Fingerprint cache key | Byte-identical command text only; appending `; date +%F` defeated it and paid the probe again |
| Handed-off task name | The raw command string, not a 2-6 word label (the extension builds the task itself) |

## Known limits

- **Re-execution is not idempotent-safe.** A command killed mid-window may already have applied side
  effects, and the background run starts over.
- **Pattern matching is textual.** A command that merely contains a pattern string (a heredoc
  mentioning `npm run dev`) is matched. An explicit `timeout` keeps such a call in the foreground.
- **Human `!` commands are not routed.** A `tool_call` handler only sees model-issued Bash calls;
  `!cmd` goes through the `user_bash` event. Humans already have `/bg`, `/jobs`, `/logs`, `/kill`.
- **Skills are discovered at startup and `/reload` only.** `/bg-handoff off` silences the guidance
  message but cannot unload the bundled skill mid-session.
- **Caches are in-memory per session**: the fingerprint cache and the duplicate guard are not
  persisted.
- **Handed-off tasks get a 4h default timeout**, so a handed-off `tail -f` must be killed explicitly.
- **No cwd in the manager request.** The EventBus v1 `run` payload has no `cwd` field; tasks use the
  manager's session context.
- **Not a sandbox.** Background tasks run with the same local permissions and environment as Pi.

## Roadmap

Next, in rough order of value:

1. **Persist the fingerprint cache** across sessions so a known-slow command never pays the probe
   again, with a bounded store and an obvious opt-out.
2. **Per-project config** (`<cwd>/.pi/pi-bg-handoff.json`) layered over the global file, so a repo
   with slow builds can carry its own window.
3. **Pattern allow/deny lists in config** (`extraPatterns` exists; `ignorePatterns` does not) so a
   project can stop a built-in pattern from pre-empting its own commands.
4. **Better task names for handed-off tasks.** They currently take the raw command as their name,
   which makes the footer dock unreadable for long commands. A short deterministic label (first
   executable plus a hash) would fix that without changing semantics.
5. **A `/bg-handoff config` subcommand** that prints the resolved config path and the values that
   came from the file versus the built-in defaults.
6. **Optional idempotency prompt**: when a command that already wrote side effects is re-run after a
   window kill, ask before re-executing (or mark it `reRunAllowed` in config).
7. **Integration test against the real manager** instead of only the fake EventBus, behind a flag so
   the default selftest stays hermetic.

Not planned:

- Adopting the killed foreground process instead of re-executing — Pi has no such primitive.
- Sandboxing or permission controls for background tasks.
- Covering human `!` commands through a marker syntax; `/bg` already exists.

## Verification

```bash
node --experimental-strip-types selftest.mjs   # 39 assertions, fake pi host + fake manager
```

The harness pins `PI_BG_HANDOFF_CONFIG` to an absent path for the main instance so the real user
config cannot leak into assertions, and declares `const WINDOW = 120` mirroring
`DEFAULT_WINDOW_SECONDS` — change both together.
