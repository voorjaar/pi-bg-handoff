import type { EventBusLike } from "./runtime.ts";

/**
 * pi-subagents background-work provider protocol v1.
 *
 * The public pi-subagents contract intentionally uses Symbol.for() so
 * independently loaded extensions can participate without a direct package
 * dependency. Keeping the version in both the registry key and payload lets us
 * fail closed if a future incompatible registry is present.
 */
export const BACKGROUND_WORK_PROTOCOL_VERSION = 1 as const;
export const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
export const PI_AGENT_WAIT_PROVIDER_NAME = "pi-agent-wait";
export const PI_AGENT_WAIT_WAKE_CHANNEL = "pi-agent-wait:background-work:v1";

export interface BackgroundWorkItem {
  id: string;
  sessionId: string;
}

interface BackgroundWorkReconcileContext {
  sessionId: string;
  nowMs: number;
}

interface BackgroundWorkProvider {
  name: string;
  listActiveWork(): readonly BackgroundWorkItem[];
  wakeChannels?: readonly string[];
  reconcile?(context: BackgroundWorkReconcileContext): void;
}

interface BackgroundWorkRegistry {
  version: typeof BACKGROUND_WORK_PROTOCOL_VERSION;
  providers: Map<string, BackgroundWorkProvider>;
}

interface TrackedWork extends BackgroundWorkItem {
  deadlineAt?: number;
}

export interface TrackBackgroundWorkInput extends BackgroundWorkItem {
  deadlineAt?: number;
}

export interface TrackedBackgroundWork {
  readonly id: string;
  readonly sessionId: string;
  finish(reason?: string): void;
}

function protocolRegistry(): BackgroundWorkRegistry {
  const key = Symbol.for(BACKGROUND_WORK_REGISTRY_KEY);
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[key];

  if (existing === undefined) {
    const created: BackgroundWorkRegistry = {
      version: BACKGROUND_WORK_PROTOCOL_VERSION,
      providers: new Map(),
    };
    globalObject[key] = created;
    return created;
  }

  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error(
      `Malformed pi-subagents background-work registry at Symbol.for("${BACKGROUND_WORK_REGISTRY_KEY}").`,
    );
  }

  const candidate = existing as Partial<BackgroundWorkRegistry>;
  if (
    candidate.version !== BACKGROUND_WORK_PROTOCOL_VERSION ||
    !(candidate.providers instanceof Map)
  ) {
    throw new Error(
      `Unsupported pi-subagents background-work registry at Symbol.for("${BACKGROUND_WORK_REGISTRY_KEY}").`,
    );
  }

  return candidate as BackgroundWorkRegistry;
}

function assertWorkString(value: string, field: string, maxLength: number): void {
  if (!value || value.trim() !== value || value.includes("\0") || value.length > maxLength) {
    throw new Error(`${field} must be a trimmed non-empty string up to ${maxLength} characters without NUL.`);
  }
}

/**
 * Process-local catalog of detached/yielded waits owned by this extension.
 * listActiveWork() is synchronous because pi-subagents snapshots providers
 * synchronously; the actual task/timer completion remains event-driven.
 */
export class BackgroundWorkTracker {
  private readonly work = new Map<string, TrackedWork>();

  constructor(
    private readonly events: EventBusLike,
    private readonly now: () => number = Date.now,
  ) {}

  begin(input: TrackBackgroundWorkInput): TrackedBackgroundWork {
    assertWorkString(input.id, "Background-work id", 256);
    assertWorkString(input.sessionId, "Background-work sessionId", 256);
    if (
      input.deadlineAt !== undefined &&
      (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= 0)
    ) {
      throw new Error("Background-work deadlineAt must be a positive finite timestamp when provided.");
    }

    const key = `${input.sessionId}\0${input.id}`;
    const record: TrackedWork = { id: input.id, sessionId: input.sessionId };
    if (input.deadlineAt !== undefined) record.deadlineAt = input.deadlineAt;
    this.work.set(key, record);

    let finished = false;
    return {
      id: input.id,
      sessionId: input.sessionId,
      finish: (reason = "finished"): void => {
        if (finished) return;
        finished = true;
        // Identity check prevents an old disposer from removing a replacement
        // that reused the same provider-local id.
        if (this.work.get(key) !== record) return;
        this.work.delete(key);
        this.emitChanged(input.id, input.sessionId, reason);
      },
    };
  }

  listActiveWork(): readonly BackgroundWorkItem[] {
    return [...this.work.values()].map(({ id, sessionId }) => ({ id, sessionId }));
  }

  reconcile(sessionId: string, nowMs = this.now()): void {
    for (const [key, record] of this.work) {
      if (record.sessionId !== sessionId) continue;
      if (record.deadlineAt === undefined || record.deadlineAt > nowMs) continue;
      this.work.delete(key);
      this.emitChanged(record.id, record.sessionId, "deadline-reconciled");
    }
  }

  clear(reason = "cleared"): void {
    const records = [...this.work.values()];
    this.work.clear();
    for (const record of records) this.emitChanged(record.id, record.sessionId, reason);
  }

  private emitChanged(id: string, sessionId: string, reason: string): void {
    this.events.emit(PI_AGENT_WAIT_WAKE_CHANNEL, {
      schema_version: "pi-agent-wait.background-work-change.v1",
      provider: PI_AGENT_WAIT_PROVIDER_NAME,
      id,
      sessionId,
      reason,
    });
  }
}

/**
 * Register against pi-subagents' public Symbol.for-based v1 provider contract.
 * No direct dependency on pi-subagents is required; if pi-subagents is absent,
 * this simply creates the inert process-local registry that it would create on
 * first import. When pi-subagents is present or loads later, both extensions
 * meet in the same versioned registry.
 */
export function registerPiSubagentsBackgroundWorkProvider(
  tracker: BackgroundWorkTracker,
): () => void {
  const current = protocolRegistry();
  const provider: BackgroundWorkProvider = {
    name: PI_AGENT_WAIT_PROVIDER_NAME,
    wakeChannels: [PI_AGENT_WAIT_WAKE_CHANNEL],
    listActiveWork: () => tracker.listActiveWork(),
    reconcile: ({ sessionId, nowMs }) => tracker.reconcile(sessionId, nowMs),
  };

  current.providers.set(provider.name, provider);

  return () => {
    if (current.providers.get(provider.name) === provider) {
      current.providers.delete(provider.name);
    }
  };
}
