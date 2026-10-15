import {
  BG_REQUEST_CHANNEL,
  BG_REQUEST_SCHEMA,
  BG_RESPONSE_CHANNEL,
  BG_TERMINAL_CHANNEL,
  extractStatusSnapshot,
  isBgResponse,
  isTerminalFrame,
  type BgResponse,
  type BgStatusRequest,
  type BgTaskSnapshot,
} from "./protocol.ts";

export interface EventBusLike {
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
}

export type WaitOutcome =
  | { outcome: "terminal"; task: BgTaskSnapshot; elapsedMs: number }
  | { outcome: "timeout"; task: BgTaskSnapshot; elapsedMs: number }
  | { outcome: "cancelled"; task?: BgTaskSnapshot; elapsedMs: number };

export interface RuntimeOptions {
  requestTimeoutMs?: number;
  now?: () => number;
  requestId?: () => string;
  /** Upper bound on cached terminal snapshots. Oldest entries are evicted. */
  terminalCacheLimit?: number;
  /** How long a cached terminal snapshot stays useful for race recovery. */
  terminalCacheTtlMs?: number;
}

const DEFAULT_TERMINAL_CACHE_LIMIT = 256;
const DEFAULT_TERMINAL_CACHE_TTL_MS = 30 * 60_000;

interface CachedTerminal {
  task: BgTaskSnapshot;
  at: number;
}

/**
 * Host bookkeeping timers must not, by themselves, keep a Pi process alive.
 * Foreground blocking waits are deliberately excluded: while a tool Promise is
 * genuinely pending, the process is supposed to stay up.
 */
export function unrefTimer<T>(timer: T): T {
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate?.unref === "function") candidate.unref();
  return timer;
}

/** Raised when pi-background-tasks never answered on the EventBus at all. */
export class BackgroundTasksUnavailableError extends Error {
  readonly code = "PI_BACKGROUND_TASKS_UNAVAILABLE";
}

interface PendingResponse {
  resolve: (response: BgResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
}

interface TaskWaiter {
  resolve: (task: BgTaskSnapshot) => void;
  cancel: () => void;
}

function abortError(): Error {
  const error = new Error("Wait cancelled.");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface WaitReservation {
  readonly allowedMs: number;
  settle(actualMs: number): void;
}

export class WaitBudget {
  private usedMs = 0;
  private reservedMs = 0;

  constructor(readonly limitMs: number) {
    if (!Number.isFinite(limitMs) || limitMs <= 0) {
      throw new Error("Wait budget must be a positive finite duration.");
    }
  }

  reset(): void {
    this.usedMs = 0;
    this.reservedMs = 0;
  }

  get used(): number {
    return this.usedMs;
  }

  get remaining(): number {
    return Math.max(0, this.limitMs - this.usedMs - this.reservedMs);
  }

  assertCanStart(requestedMs: number): void {
    if (this.remaining <= 0) {
      throw new Error(
        "Foreground wait budget for this agent run is exhausted. Reassess instead of chaining waits.",
      );
    }
    if (requestedMs <= 0 || !Number.isFinite(requestedMs)) {
      throw new Error("Requested wait must be a positive finite duration.");
    }
  }

  charge(actualMs: number): void {
    if (Number.isFinite(actualMs) && actualMs > 0) {
      this.usedMs = Math.min(this.limitMs, this.usedMs + actualMs);
    }
  }

  clamp(requestedMs: number): number {
    this.assertCanStart(requestedMs);
    return Math.min(requestedMs, this.remaining);
  }

  /**
   * Take the budget up front rather than at completion time. Pi may run sibling
   * tool calls concurrently, and clamp-then-charge let two simultaneous waits
   * each observe the full remaining budget.
   */
  reserve(requestedMs: number): WaitReservation {
    const allowedMs = this.clamp(requestedMs);
    this.reservedMs += allowedMs;
    let settled = false;
    return {
      allowedMs,
      settle: (actualMs: number): void => {
        if (settled) return;
        settled = true;
        this.reservedMs = Math.max(0, this.reservedMs - allowedMs);
        this.charge(Math.min(actualMs, allowedMs));
      },
    };
  }
}

export class BackgroundTaskWaitRuntime {
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly makeRequestId: () => string;

  private unsubscribeResponse: (() => void) | undefined;
  private unsubscribeTerminal: (() => void) | undefined;
  private started = false;

  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly terminalCache = new Map<string, CachedTerminal>();
  private readonly terminalCacheLimit: number;
  private readonly terminalCacheTtlMs: number;
  private readonly taskWaiters = new Map<string, Set<TaskWaiter>>();
  private readonly terminalObservers = new Map<string, Set<(task: BgTaskSnapshot) => void>>();

  constructor(
    private readonly events: EventBusLike,
    options: RuntimeOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.makeRequestId = options.requestId ?? (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.terminalCacheLimit = options.terminalCacheLimit ?? DEFAULT_TERMINAL_CACHE_LIMIT;
    this.terminalCacheTtlMs = options.terminalCacheTtlMs ?? DEFAULT_TERMINAL_CACHE_TTL_MS;
  }

  /**
   * The cache only exists to close the status->subscribe race, so it is bounded
   * in both age and size. Without this it grew once per terminal publication for
   * the whole session, including tasks nobody ever waited on.
   */
  private cacheTerminal(task: BgTaskSnapshot): void {
    const now = this.now();
    this.terminalCache.set(task.id, { task, at: now });

    const cutoff = now - this.terminalCacheTtlMs;
    for (const [id, entry] of this.terminalCache) {
      if (entry.at > cutoff) break; // Map preserves insertion order.
      this.terminalCache.delete(id);
    }
    while (this.terminalCache.size > this.terminalCacheLimit) {
      const oldest = this.terminalCache.keys().next();
      if (oldest.done) break;
      this.terminalCache.delete(oldest.value);
    }
  }

  private cachedTerminal(taskId: string): BgTaskSnapshot | undefined {
    const entry = this.terminalCache.get(taskId);
    if (!entry) return undefined;
    if (entry.at <= this.now() - this.terminalCacheTtlMs) {
      this.terminalCache.delete(taskId);
      return undefined;
    }
    return entry.task;
  }

  get terminalCacheSize(): number {
    return this.terminalCache.size;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribeResponse = this.events.on(BG_RESPONSE_CHANNEL, (data) => {
      if (!isBgResponse(data)) return;
      const pending = this.pendingResponses.get(data.request_id);
      if (!pending) return;

      this.pendingResponses.delete(data.request_id);
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.resolve(data);
    });

    this.unsubscribeTerminal = this.events.on(BG_TERMINAL_CHANNEL, (data) => {
      if (!isTerminalFrame(data)) return;
      const task = data.task;

      // pi-background-tasks documents that terminal publications may be retried.
      if (this.cachedTerminal(task.id)) return;
      this.cacheTerminal(task);

      const waiters = this.taskWaiters.get(task.id);
      if (waiters) {
        this.taskWaiters.delete(task.id);
        for (const waiter of waiters) waiter.resolve(task);
      }

      const observers = this.terminalObservers.get(task.id);
      if (observers) {
        this.terminalObservers.delete(task.id);
        for (const observer of observers) observer(task);
      }
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeResponse?.();
    this.unsubscribeTerminal?.();
    this.unsubscribeResponse = undefined;
    this.unsubscribeTerminal = undefined;

    const error = new Error("Wait runtime stopped during request.");
    for (const [id, pending] of this.pendingResponses) {
      clearTimeout(pending.timer);
      pending.cleanupAbort();
      pending.reject(error);
      this.pendingResponses.delete(id);
    }

    for (const waiters of this.taskWaiters.values()) {
      for (const waiter of [...waiters]) waiter.cancel();
    }
    this.taskWaiters.clear();
    this.terminalObservers.clear();
    this.terminalCache.clear();
  }

  /**
   * Resolve a task id, tolerating a task that has not been registered yet.
   *
   * Pi may execute sibling tool calls concurrently, so a wait can legitimately
   * reach the EventBus microseconds before bg_run has published its task. Only
   * a real ok:false answer is retried: if pi-background-tasks never responds at
   * all, that is a configuration problem and must fail fast.
   */
  async statusWithGrace(
    taskId: string,
    signal: AbortSignal | undefined,
    responseTimeoutMs: number,
    graceMs: number,
    attemptDelayMs = 400,
  ): Promise<BgTaskSnapshot> {
    const deadline = this.now() + Math.max(0, graceMs);
    for (;;) {
      try {
        return await this.status(taskId, signal, responseTimeoutMs);
      } catch (error) {
        const err = asError(error);
        if (err instanceof BackgroundTasksUnavailableError) throw err;
        if (err.name === "AbortError") throw err;
        if (this.now() + attemptDelayMs >= deadline) throw err;
      }
      const slept = await boundedSleep(attemptDelayMs, signal);
      if (slept === "cancelled") throw abortError();
    }
  }

  async status(
    taskId: string,
    signal?: AbortSignal,
    responseTimeoutMs = this.requestTimeoutMs,
  ): Promise<BgTaskSnapshot> {
    this.ensureStarted();
    const cleanId = taskId.trim();
    if (!cleanId) throw new Error("Background task id must not be empty.");

    const requestId = this.makeRequestId();
    const request: BgStatusRequest = {
      schema_version: BG_REQUEST_SCHEMA,
      request_id: requestId,
      operation: "status",
      payload: { taskId: cleanId },
    };

    const responsePromise = this.awaitResponse(requestId, signal, responseTimeoutMs);
    this.events.emit(BG_REQUEST_CHANNEL, request);
    const response = await responsePromise;

    if (!response.ok) {
      throw new Error(`pi-background-tasks status failed: ${response.error}`);
    }

    return extractStatusSnapshot(response.result, cleanId);
  }


  observeTerminal(taskId: string, observer: (task: BgTaskSnapshot) => void): () => void {
    this.ensureStarted();

    const cached = this.cachedTerminal(taskId);
    if (cached) {
      queueMicrotask(() => observer(cached));
      return () => {};
    }

    const observers = this.terminalObservers.get(taskId) ?? new Set<(task: BgTaskSnapshot) => void>();
    observers.add(observer);
    this.terminalObservers.set(taskId, observers);

    return () => {
      const current = this.terminalObservers.get(taskId);
      current?.delete(observer);
      if (current?.size === 0) this.terminalObservers.delete(taskId);
    };
  }

  async waitForTask(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    graceMs = 0,
  ): Promise<WaitOutcome> {
    this.ensureStarted();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Task wait timeout must be a positive finite duration.");
    }

    const startedAt = this.now();
    if (signal?.aborted) {
      return { outcome: "cancelled", elapsedMs: 0 };
    }

    let current: BgTaskSnapshot;
    try {
      current = await this.statusWithGrace(
        taskId,
        signal,
        Math.min(this.requestTimeoutMs, timeoutMs),
        Math.min(graceMs, timeoutMs),
      );
    } catch (error) {
      if (asError(error).name === "AbortError") {
        return { outcome: "cancelled", elapsedMs: this.now() - startedAt };
      }
      throw error;
    }

    const cached = this.cachedTerminal(current.id);
    if (cached) {
      return { outcome: "terminal", task: cached, elapsedMs: this.now() - startedAt };
    }

    if (current.status !== "running") {
      this.cacheTerminal(current);
      return { outcome: "terminal", task: current, elapsedMs: this.now() - startedAt };
    }

    const remainingMs = timeoutMs - (this.now() - startedAt);
    if (remainingMs <= 0) {
      return { outcome: "timeout", task: current, elapsedMs: this.now() - startedAt };
    }

    return this.awaitTerminal(current, remainingMs, startedAt, signal);
  }

  private awaitResponse(
    requestId: string,
    signal?: AbortSignal,
    responseTimeoutMs = this.requestTimeoutMs,
  ): Promise<BgResponse> {
    return new Promise<BgResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const onAbort = () => {
        const pending = this.pendingResponses.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingResponses.delete(requestId);
        pending.cleanupAbort();
        reject(abortError());
      };

      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);

      const timer = setTimeout(() => {
        const pending = this.pendingResponses.get(requestId);
        if (!pending) return;
        this.pendingResponses.delete(requestId);
        pending.cleanupAbort();
        reject(
          new BackgroundTasksUnavailableError(
            "No response from pi-background-tasks EventBus. Ensure pi-background-tasks is installed, enabled, and loaded in this Pi session.",
          ),
        );
      }, responseTimeoutMs);

      this.pendingResponses.set(requestId, { resolve, reject, timer, cleanupAbort });
      if (signal?.aborted) onAbort();
    });
  }

  private awaitTerminal(
    current: BgTaskSnapshot,
    timeoutMs: number,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;

      const finish = (outcome: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const set = this.taskWaiters.get(current.id);
        set?.delete(waiter);
        if (set?.size === 0) this.taskWaiters.delete(current.id);
        resolve(outcome);
      };

      const waiter: TaskWaiter = {
        resolve: (task) => {
          finish({ outcome: "terminal", task, elapsedMs: this.now() - startedAt });
        },
        cancel: () => {
          finish({ outcome: "cancelled", task: current, elapsedMs: this.now() - startedAt });
        },
      };

      const existing = this.taskWaiters.get(current.id) ?? new Set<TaskWaiter>();
      existing.add(waiter);
      this.taskWaiters.set(current.id, existing);

      const timer = setTimeout(() => {
        finish({ outcome: "timeout", task: current, elapsedMs: this.now() - startedAt });
      }, timeoutMs);

      const onAbort = () => {
        finish({ outcome: "cancelled", task: current, elapsedMs: this.now() - startedAt });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      // Close the status -> waiter registration race. A terminal publication may
      // have landed in the session-wide cache between those two steps.
      const justFinished = this.cachedTerminal(current.id);
      if (justFinished) waiter.resolve(justFinished);
    });
  }

  private ensureStarted(): void {
    if (!this.started) {
      throw new Error("Wait runtime is not active for the current Pi session.");
    }
  }
}

export async function boundedSleep(
  durationMs: number,
  signal?: AbortSignal,
): Promise<"completed" | "cancelled"> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Wait duration must be a positive finite duration.");
  }
  if (signal?.aborted) return "cancelled";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "completed" | "cancelled") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("completed"), durationMs);
    const onAbort = () => finish("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
