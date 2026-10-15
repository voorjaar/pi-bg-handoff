# Third-party notices

## pi-background-tasks (bundled fork) — ISC

`dist/background-tasks/` is a compiled build of the local fork at
`fork/pi-background-tasks`, and the local changes are `patches/pi-background-tasks.patch`.
Upstream ([ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks))
declares `ISC` in its `package.json` and ships the ISC notice reproduced in
`LICENSE.pi-background-tasks`. That notice applies to the fork's sources, to this package's
patch against them, and to the compiled tree this package serves.

## pi-agent-wait (bundled fork) — MIT

`dist/agent-wait/` is the source tree of the local fork at `fork/pi-agent-wait`, and the local changes
are `patches/pi-agent-wait.patch`. Upstream
([AledHe/pi-agent-wait](https://github.com/AledHe/pi-agent-wait), v0.6.0) declares `MIT` in its
`package.json` and ships the notice reproduced in `LICENSE.pi-agent-wait`. That notice applies to the
fork's sources and to this package's patch against them.

## Anthropic system-prompt sanitization rules (inside the fork) — MIT

Upstream's notice, reproduced because the bundled build contains the code it covers:

> The line-start prefix Anthropic system-prompt sanitization rules in
> `src/core/anthropic-attribution.ts` are derived from
> [`ravshansbox/pi-anthropic-sps`](https://github.com/ravshansbox/pi-anthropic-sps)
> at commit `3a27cb3f8a2ddf62ee6219357c09a24e33e47cfc` (earlier exact-match rules
> came from commit `17409b5615f0ec0625776bc5434f92f2c55e3fd0`).
>
> Copyright (c) 2026 Ravshan — licensed under the MIT License.

In the built package that code is served as
`dist/background-tasks/src/core/anthropic-attribution.js`.

## turndown — MIT

`turndown` 7.2.4 is a runtime dependency of the bundled manager (used by its
`src/core/fusion/web-fetch.ts`). MIT licensed: https://github.com/mixmark-io/turndown

## Pi packages — peer only

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and
`typebox` are optional peer dependencies: they are provided by the Pi runtime that loads these
extensions and are not vendored here. `@earendil-works/pi-coding-agent` is installed as a
devDependency only for typechecking `src/index.ts`.
