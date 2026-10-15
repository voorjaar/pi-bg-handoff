export type UserInterruptHandler = () => void;

export interface UserInterruptSummary {
  foregroundInterrupted: number;
  passiveUiDetached: number;
}

/**
 * Coordinates user-input interruption without owning the underlying work.
 *
 * Foreground handlers abort a pending blocking wait so the current tool call can
 * return. Passive UI handlers only hide waiting chrome; their timer/task watcher
 * intentionally remains alive in the host runtime.
 */
export class WaitInterruptionHub {
  private readonly foreground = new Set<UserInterruptHandler>();
  private readonly passiveUi = new Set<UserInterruptHandler>();

  registerForeground(handler: UserInterruptHandler): () => void {
    this.foreground.add(handler);
    return () => this.foreground.delete(handler);
  }

  registerPassiveUi(handler: UserInterruptHandler): () => void {
    this.passiveUi.add(handler);
    return () => this.passiveUi.delete(handler);
  }

  interruptForUserInput(): UserInterruptSummary {
    const foreground = [...this.foreground];
    const passiveUi = [...this.passiveUi];

    // Remove first so a handler cannot be invoked twice by re-entrant input.
    for (const handler of foreground) this.foreground.delete(handler);
    for (const handler of passiveUi) this.passiveUi.delete(handler);

    for (const handler of foreground) handler();
    for (const handler of passiveUi) handler();

    return {
      foregroundInterrupted: foreground.length,
      passiveUiDetached: passiveUi.length,
    };
  }

  clear(): void {
    this.foreground.clear();
    this.passiveUi.clear();
  }
}

export interface CombinedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Combine abort sources without leaking listeners after a wait settles. */
export function combineAbortSignals(signals: readonly AbortSignal[]): CombinedAbortSignal {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      continue;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", abort));
  }

  let disposed = false;
  return {
    signal: controller.signal,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    },
  };
}
