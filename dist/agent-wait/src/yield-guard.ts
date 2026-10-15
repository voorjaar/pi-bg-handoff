/**
 * Host-side bound on self-sustaining yield chains.
 *
 * Blocking waits are limited by WaitBudget, but a yielded wait deliberately
 * costs no budget: it terminates the run and arms a host wake that starts a new
 * run, which resets the budget. Nothing except a prompt guideline stopped
 * `wait(300, "yield")` from renewing itself forever.
 *
 * The counter therefore tracks consecutive *unattended* yields — yields that
 * happened without a real user message in between. Real user input means a human
 * is steering again, so the chain resets.
 */
export class YieldChainGuard {
  private consecutive = 0;

  constructor(readonly maxConsecutive: number = 8) {
    if (!Number.isInteger(maxConsecutive) || maxConsecutive < 1) {
      throw new Error("maxConsecutive must be a positive integer.");
    }
  }

  get consecutiveYields(): number {
    return this.consecutive;
  }

  get remaining(): number {
    return Math.max(0, this.maxConsecutive - this.consecutive);
  }

  assertCanYield(): void {
    if (this.consecutive >= this.maxConsecutive) {
      throw new Error(
        `Refusing to yield again: ${this.consecutive} consecutive host waits have been armed without any user input. ` +
          "Stop waiting and report the current state, or do work that does not depend on the pending condition. " +
          "The chain resets once the user sends a message.",
      );
    }
  }

  noteYieldArmed(): void {
    this.consecutive += 1;
  }

  /** A real (non-extension) user message means a human is steering again. */
  noteUserActivity(): void {
    this.consecutive = 0;
  }

  reset(): void {
    this.consecutive = 0;
  }
}
