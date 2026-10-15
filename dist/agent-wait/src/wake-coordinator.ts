import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { unrefTimer } from "./runtime.ts";

export interface WakeEvent {
  /** Stable identity used to suppress duplicate completion publications. */
  key: string;
  content: string;
  details: Record<string, unknown>;
}

export interface WakeCoordinatorOptions {
  debounceMs?: number | undefined;
  maxWaitMs?: number | undefined;
  recentDedupeMs?: number | undefined;
  now?: (() => number) | undefined;
}

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_MAX_WAIT_MS = 500;
const DEFAULT_RECENT_DEDUPE_MS = 5_000;

/**
 * Batches host-side completion events before they are allowed to wake the LLM.
 *
 * EventBus updates, timers and UI repaints remain token-idle. Only flush() calls
 * sendMessage(... triggerTurn:true), and a burst of related completions becomes
 * one follow-up turn instead of one model turn per event.
 */
export class WakeCoordinator {
  private readonly pending = new Map<string, WakeEvent>();
  private readonly recent = new Map<string, number>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly recentDedupeMs: number;
  private readonly now: () => number;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private maxTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private agentActive = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    options: WakeCoordinatorOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.recentDedupeMs = options.recentDedupeMs ?? DEFAULT_RECENT_DEDUPE_MS;
    this.now = options.now ?? Date.now;
  }

  enqueue(event: WakeEvent): boolean {
    if (this.disposed) return false;
    this.pruneRecent();
    if (this.pending.has(event.key) || this.recent.has(event.key)) return false;

    this.pending.set(event.key, event);
    if (!this.agentActive) this.armTimers();
    return true;
  }

  flush(): void {
    if (this.agentActive) {
      this.clearTimers();
      return;
    }
    if (this.disposed || this.pending.size === 0) {
      this.clearTimers();
      return;
    }

    const events = [...this.pending.values()];
    this.pending.clear();
    this.clearTimers();
    const now = this.now();
    for (const event of events) this.recent.set(event.key, now);

    const content =
      events.length === 1
        ? events[0]!.content
        : [
            `${events.length} background events became ready:`,
            ...events.map((event, index) => `${index + 1}. ${event.content}`),
          ].join("\n");

    const details =
      events.length === 1
        ? { ...events[0]!.details, wakeKey: events[0]!.key, batched: false }
        : {
            batched: true,
            count: events.length,
            events: events.map((event) => ({ key: event.key, details: event.details })),
          };

    this.pi.sendMessage(
      {
        customType: "pi-agent-wait:wake",
        content,
        display: true,
        details,
      },
      {
        triggerTurn: true,
        deliverAs: "followUp",
      },
    );
  }


  /**
   * Hold completion wake messages while the main agent is already doing useful
   * work. When that run ends, all accumulated events are released through the
   * normal debounce window as one follow-up whenever possible.
   */
  setAgentActive(active: boolean): void {
    if (this.disposed || this.agentActive === active) return;
    this.agentActive = active;
    if (active) {
      this.clearTimers();
      return;
    }
    if (this.pending.size > 0) this.armTimers();
  }

  clearPending(): void {
    this.pending.clear();
    this.clearTimers();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    this.recent.clear();
    this.clearTimers();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private armTimers(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    this.debounceTimer = unrefTimer(setTimeout(() => this.flush(), this.debounceMs));
    if (this.maxTimer === undefined) {
      this.maxTimer = unrefTimer(setTimeout(() => this.flush(), this.maxWaitMs));
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer);
    if (this.maxTimer !== undefined) clearTimeout(this.maxTimer);
    this.debounceTimer = undefined;
    this.maxTimer = undefined;
  }

  private pruneRecent(): void {
    const cutoff = this.now() - this.recentDedupeMs;
    for (const [key, at] of this.recent) {
      if (at <= cutoff) this.recent.delete(key);
    }
  }
}
