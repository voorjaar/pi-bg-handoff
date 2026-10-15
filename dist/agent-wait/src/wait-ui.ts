import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { unrefTimer } from "./runtime.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const UI_TICK_MS = 500;
const STATUS_KEY = "pi-agent-wait:waiting-status";
/**
 * Footer handshake with the vendored pi-background-tasks fork. It owns the ` bg … ` status
 * segment, so waits are published into that same segment instead of adding a widget above the
 * editor or a second status of their own.
 */
const FOOTER_SLOT = Symbol.for("pi-bg-handoff.footer:v1");

type FooterHandoff = {
  setWaitingSegment(segment: string | undefined): void;
  requestRefresh(): void;
};

function footerHandoff(): FooterHandoff | undefined {
  const value = (globalThis as Record<symbol, unknown>)[FOOTER_SLOT];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<FooterHandoff>;
  if (typeof candidate.setWaitingSegment !== "function" || typeof candidate.requestRefresh !== "function") return undefined;
  return candidate as FooterHandoff;
}

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

function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

/**
 * One renderer for every wait owned by this extension instance.
 *
 * Presentation has two states, both published into the background-tasks footer segment:
 * - prominent: the agent is actually waiting, so an animated spinner segment shows the waits;
 * - compact: the agent is doing useful work while detached waits remain in the host, so the
 *   segment stays static and the repaint timer stops.
 *
 * There is no widget above the editor and no per-wait panel: one footer segment carries every
 * wait, and Enter/Esc keep working without on-screen jargon. UI operations are host-side only and
 * never invoke an LLM provider.
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
      this.renderedCtx.ui.setStatus(STATUS_KEY, undefined);
    }
    this.renderedCtx = ctx;
  }

  private clearRenderedUi(): void {
    footerHandoff()?.setWaitingSegment(undefined);
    footerHandoff()?.requestRefresh();
    if (!this.renderedCtx?.hasUI) {
      this.renderedCtx = undefined;
      return;
    }
    this.renderedCtx.ui.setStatus(STATUS_KEY, undefined);
    this.renderedCtx = undefined;
  }

  /** Publish one footer segment, falling back to a status of our own when the manager is absent. */
  private publishSegment(text: string | undefined): void {
    const slot = footerHandoff();
    if (slot) {
      slot.setWaitingSegment(text);
      slot.requestRefresh();
      return;
    }
    const ctx = this.renderedCtx ?? this.uiContext();
    if (!ctx?.hasUI) return;
    this.renderedCtx = ctx;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  /**
   * What is being waited on, in the footer: a timer shows the seconds left, a task watch shows the
   * task id it is watching. Labels stay short because they share one line with the task counts.
   */
  private labelFor(entry: WaitUiEntry, now: number): string {
    if (entry.options.kind === "background-task") {
      const id = entry.options.title.replace(/\s+/gu, " ").trim();
      return id.length > 32 ? id.slice(0, 32) : id;
    }
    const remainingMs = Math.max(0, entry.options.totalMs - (now - entry.options.startedAt));
    return `${String(Math.ceil(remainingMs / 1000))}s`;
  }

  private labelsFor(entries: WaitUiEntry[]): string {
    const now = Date.now();
    const labels = entries.slice(-2).map((entry) => this.labelFor(entry, now));
    if (entries.length > 1) labels.push(`×${String(entries.length)}`);
    return labels.join(" · ");
  }

  private renderCompact(entries: WaitUiEntry[]): void {
    // Static while the agent works: a spinner that animates nothing would compete with active
    // inference/tool execution.
    this.publishSegment(`waiting ${this.labelsFor(entries)}`);
  }

  private renderProminent(entries: WaitUiEntry[]): void {
    // pi-bg-handoff fork: the whole waiting UI is one animated spinner in the footer. Enter still
    // detaches the wait to the background (index.ts owns that behaviour); there is no progress bar,
    // no per-wait breakdown, and no block/yield jargon.
    const frame = spinnerFrame(this.tick++);
    this.publishSegment(`${frame} waiting ${this.labelsFor(entries)}`);
  }

  private render(): void {
    if (this.entries.size === 0) return;
    const ctx = this.uiContext();
    if (!ctx) return;
    this.switchRenderedContext(ctx);

    const entries = [...this.entries.values()];
    if (this.shouldRenderProminent()) this.renderProminent(entries);
    else this.renderCompact(entries);
  }
}
