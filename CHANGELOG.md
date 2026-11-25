# Changelog

## 0.6.2

- Added **queued launches** to the vendored manager: `bg_run` now accepts `afterTaskId` and `queue`, so a
  second task that would contend for the same GPU, port, disk, or box is held until the first reaches a
  terminal state. The call returns at once with `status: "queued"` and the real task id and output path the
  launch will use; `bg_status`, `bg_kill` (cancel before spawn), `/jobs`, the footer dock, and the
  `run`/`status`/`kill` extension-API operations all handle a queued task.
- Aligned the vendored `pi-background-tasks` fork with upstream `main` at 2.6.12 and re-derived its
  generated docs. The patch now also deletes `docs/commands/bg-update.md`, because upstream's docs-freshness
  gate rejects a doc page whose public surface the patch removed.
- Added a **stub-turn guard**: a completed turn that ran no tool and whose whole visible output is only a
  waiting stub (`等待中`, `Waiting`, ellipsis, empty) is bounced back in the same turn, capped at three bounces
  per session. On by default; `"stubGuard": false`, `PI_BG_STUB_GUARD=off`, or
  `/bg-handoff stub-guard off` disable it.
- Guidance and the bundled skill now forbid stub turns on a wake: a turn woken by a task notification or a
  host continuation must do work or arm `bg_wait` / `bg_wait_for_task`.

## 0.6.1

- Added the npm listing metadata `0.6.0` shipped without: `keywords` (including `pi-package`, which is what
  makes a package eligible for the Pi package gallery), `author`, `repository`, `bugs`, and `homepage`.
- Declared the host-provided packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) as optional peers with `"*"` instead of the upstream
  `^0.81.1 || ^0.82.1 || ^0.83.0 || ^0.84.0` ranges, which excluded the Pi 1.x line.
- Added `prepublishOnly` (`npm run build && npm test`) so a stale `dist/` cannot be published.
- Added this changelog.
- Documented `pi install npm:pi-bg-handoff`, and stated the `"windowSeconds": 0` / `/bg-handoff timeout 0`
  "everything background" mode in the routing, command, and configuration sections.

## 0.6.0

Breaking changes:

- Renamed the host-side wait tools to `bg_wait` and `bg_wait_for_task` (from `wait` / `wait_for_task`) so
  every wait belongs to the `bg_*` family, and pinned them to yield-only: a wait returns at once and the host
  wakes a later turn.
- Defaulted the bundled manager's `PI_BG_FEATURES` to `process` (upstream enables all five features).
  `bg_delegate`, `bg_result`, and the `fusion_*` tools now need
  `PI_BG_FEATURES=process,delegate,fusion`.
- Defaulted footer hints to off: the ` bg … ` line carries task state only, with no `Shift↓` / `CtrlAltB` /
  `/tasks` hint and no `/bg-clear` hint. `"footerHints": true` or `PI_BG_FOOTER_HINTS=on` restores them.
- Removed `/bg-update`, which advertised registry installs for a dependency this package vendors.
- Both dependencies are now vendored as patched forks under `fork/` and built into `dist/`, so the package no
  longer pulls the published `pi-background-tasks`. Installing it next to `npm:pi-background-tasks` loads the
  manager twice; `pi remove npm:pi-background-tasks` clears that.

Features:

- Added `"windowSeconds": 0` (`/bg-handoff timeout 0`): the foreground probe is removed and every `bash` call
  starts as a tracked background task.
- Added `/bg-wait <seconds> [reason]` to arm a host-side wait from the keyboard, plus `/bg-wait status` and
  `/bg-wait off|on`, and the `"wait": false` / `PI_BG_HANDOFF_WAIT=0` switches.
- Added `"footerHints"` (config file) and `PI_BG_FOOTER_HINTS` (environment) as the two ways to turn footer
  hints back on; the choice is read when the footer renders, so extension load order cannot change it.

Fixes:

- Fixed `bg_run` rejecting quoted booleans (`"False"`, `"True"`, `"false"`, `0`) for `isAgent` and
  `timeoutSeconds`. Pi validates tool arguments before any extension hook and logs nothing, so the failure
  looked like "bg_run is broken"; the bundled manager now coerces them.
- Replaced the waiting panel (progress bar, per-wait breakdown, Enter/Esc legend) with one segment in the
  manager's ` bg … ` footer line, and dropped the filled light-blue background from that label.
- Trimmed `dist/` by import reachability so only loadable modules are served (62 source maps and the
  subsystems behind disabled `PI_BG_FEATURES` tokens are dropped), with a post-trim check that no kept module
  imports a dropped file.

## 0.5.0

- Added automatic Bash background routing: commands matching long-running patterns (servers, watchers,
  installs, builds, tests) are handed off before execution, and every other Bash call runs with an injected
  timeout window, is killed on overflow, and is re-run from the start as a tracked background task whose id is
  reported with the partial output preserved.
- Added the `/bg-handoff` command (`status`, `auto|patterns|off`, `timeout`, `task-timeout`, `policy`,
  `learn`, `explicit-timeout`) and the config file `~/.pi/agent/pi-bg-handoff.json` with per-session
  overrides.
- Added learned pre-emption: a command seen exceeding the window goes straight to the background afterwards.
- Added the `background-commands` skill and the hidden once-per-session guidance message that states the
  routing contract.
