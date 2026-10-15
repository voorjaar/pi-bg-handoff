import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { unrefTimer } from "./runtime.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const UI_TICK_MS = 500;
const WIDGET_KEY = "pi-agent-wait:waiting";
const STATUS_KEY = "pi-agent-wait:waiting-status";

export type WaitUiKind = "duration" | "background-task";
export type WaitUiMode = "block" | "yield";
export type WaitUiPhase = "foreground" | "background";

export interface WaitUiOptions {
  key: string;
  kind: WaitUiKind;
  mode: WaitUiMode;
  phase: WaitUiPhase;
  title: string;
  detail?: string | undefined;
  startedAt: number;
  totalMs: number;
  tokenIdle?: boolean | undefined;
}

export interface WaitUiController {
  refresh(): void;
  setPhase(phase: WaitUiPhase): void;
  stop(): void;
}

interface WaitUiEntry {
  ctx: ExtensionContext;
  options: WaitUiOptions;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

/**
 * One renderer for every wait owned by this extension instance.
 *
 * Presentation has two states:
 * - prominent: the agent is actually blocked/yielded and waiting, so a single
 *   animated widget shows every wait;
 * - compact: the agent is doing useful work while detached waits remain in the
 *   host, so the widget disappears and only a static footer summary remains.
 *
 * This prevents both the old multi-spinner flicker and the misleading case
 * where Pi says "Waiting" while the model is actively working on another task.
 * UI operations are host-side only and never invoke an LLM provider.
 */
export class WaitUiCoordinator {
  private readonly entries = new Map<string, WaitUiEntry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private tick = 0;
  private renderedCtx: ExtensionContext | undefined;
  private agentActive = false;

  start(ctx: ExtensionContext, options: WaitUiOptions): WaitUiController {
    let stopped = false;
    const entry: WaitUiEntry = { ctx, options: { ...options } };
    this.entries.set(options.key, entry);
    this.reconcileTimer();
    this.render();

    return {
      refresh: () => this.render(),
      setPhase: (phase) => {
        if (stopped) return;
        const current = this.entries.get(options.key);
        if (!current || current.options.phase === phase) return;
        current.options = { ...current.options, phase };
        this.reconcileTimer();
        this.render();
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.entries.delete(options.key);
        this.reconcileTimer();
        if (this.entries.size === 0) {
          this.clearRenderedUi();
          return;
        }
        this.render();
      },
    };
  }

  /** Mark whether a Pi agent run is currently processing a prompt. */
  setAgentActive(active: boolean): void {
    if (this.agentActive === active) return;
    this.agentActive = active;
    this.reconcileTimer();
    this.render();
  }

  stopAll(): void {
    this.entries.clear();
    this.stopTimer();
    this.clearRenderedUi();
  }

  get activeCount(): number {
    return this.entries.size;
  }

  get isAgentActive(): boolean {
    return this.agentActive;
  }

  refresh(): void {
    this.render();
  }

  private hasForegroundWait(): boolean {
    return [...this.entries.values()].some((entry) => entry.options.phase === "foreground");
  }

  private shouldRenderProminent(): boolean {
    if (this.entries.size === 0) return false;
    // A foreground block means the current agent run really is waiting inside a
    // tool Promise, even though agent_start has already fired for that run.
    if (this.hasForegroundWait()) return true;
    // Detached/yielded waits become prominent only while Pi itself is idle.
    return !this.agentActive;
  }

  private reconcileTimer(): void {
    if (this.shouldRenderProminent()) this.ensureTimer();
    else this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== undefined || this.entries.size === 0) return;
    // Pure repaint work must never be the reason a Pi process stays alive.
    this.timer = unrefTimer(setInterval(() => this.render(), UI_TICK_MS));
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private uiContext(): ExtensionContext | undefined {
    const values = [...this.entries.values()];
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const entry = values[index];
      if (entry?.ctx.hasUI) return entry.ctx;
    }
    return undefined;
  }

  private switchRenderedContext(ctx: ExtensionContext): void {
    if (this.renderedCtx && this.renderedCtx !== ctx && this.renderedCtx.hasUI) {
      this.renderedCtx.ui.setWidget(WIDGET_KEY, undefined);
      this.renderedCtx.ui.setStatus(STATUS_KEY, undefined);
    }
    this.renderedCtx = ctx;
  }

  private clearRenderedUi(): void {
    if (!this.renderedCtx?.hasUI) {
      this.renderedCtx = undefined;
      return;
    }
    this.renderedCtx.ui.setWidget(WIDGET_KEY, undefined);
    this.renderedCtx.ui.setStatus(STATUS_KEY, undefined);
    this.renderedCtx = undefined;
  }

  private renderCompact(ctx: ExtensionContext, entries: WaitUiEntry[], now: number): void {
    // No above-editor widget and no spinner while the agent is working. This is
    // intentionally static: background waits should not visually compete with
    // active inference/tool execution.
    ctx.ui.setWidget(WIDGET_KEY, undefined);

    const first = entries[0];
    if (!first) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const elapsed = Math.min(Math.max(0, now - first.options.startedAt), first.options.totalMs);
    const remaining = Math.max(0, first.options.totalMs - elapsed);
    const extra = entries.length > 1 ? ` +${entries.length - 1}` : "";
    ctx.ui.setStatus(STATUS_KEY, `waiting … ${formatClock(remaining)} left${extra}`);
  }

  private renderProminent(ctx: ExtensionContext, entries: WaitUiEntry[], _now: number): void {
    // pi-bg-handoff fork: the foreground wait is one spinner line. Enter still
    // detaches the wait to the background (index.ts owns that behaviour); there
    // is no progress bar, no per-wait breakdown, and no block/yield jargon.
    const frame = spinnerFrame(this.tick++);
    const lines: string[] = [`${frame} waiting …`];
    if (entries.length > 1) lines.push(`  ${entries.length} waits in flight`);
    lines.push("  Enter moves the wait to the background · Esc cancels the current turn");
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
    ctx.ui.setStatus(STATUS_KEY, `${frame} waiting …`);
  }

  private render(): void {
    if (this.entries.size === 0) return;
    const ctx = this.uiContext();
    if (!ctx) return;
    this.switchRenderedContext(ctx);

    const entries = [...this.entries.values()];
    const now = Date.now();
    if (this.shouldRenderProminent()) this.renderProminent(ctx, entries, now);
    else this.renderCompact(ctx, entries, now);
  }
}
