export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";

export const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

export const TASK_STATUS_VALUES = ["running", "completed", "failed", "killed"] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export interface BgTaskSnapshot {
  id: string;
  name?: string;
  command: string;
  description?: string;
  status: TaskStatus;
  outputPath: string;
  cwd: string;
  startTime: number;
  endTime?: number;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  bytesWritten: number;
  isAgent: boolean;
  error?: string;
  notified: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  timeoutSeconds?: number;
  model?: string;
  [key: string]: unknown;
}

export interface BgStatusRequest {
  schema_version: typeof BG_REQUEST_SCHEMA;
  request_id: string;
  operation: "status";
  payload: { taskId: string };
}

export type BgResponse =
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: true;
      result: unknown;
    }
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: false;
      error: string;
    };

export interface BgTerminalFrame {
  schema_version: typeof BG_TERMINAL_SCHEMA;
  task: BgTaskSnapshot;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "killed"
  );
}

export function isTaskSnapshot(value: unknown): value is BgTaskSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.command === "string" &&
    isTaskStatus(value.status) &&
    typeof value.outputPath === "string" &&
    typeof value.cwd === "string" &&
    typeof value.startTime === "number" &&
    Number.isFinite(value.startTime) &&
    typeof value.bytesWritten === "number" &&
    typeof value.isAgent === "boolean" &&
    typeof value.notified === "boolean" &&
    typeof value.notifyOnCompletion === "boolean" &&
    typeof value.triggerOnCompletion === "boolean"
  );
}

export function isBgResponse(value: unknown): value is BgResponse {
  if (!isRecord(value)) return false;
  if (
    value.schema_version !== BG_RESPONSE_SCHEMA ||
    typeof value.request_id !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }

  if (value.ok) return Object.hasOwn(value, "result");
  return typeof value.error === "string";
}

export function isTerminalFrame(value: unknown): value is BgTerminalFrame {
  return (
    isRecord(value) &&
    value.schema_version === BG_TERMINAL_SCHEMA &&
    isTaskSnapshot(value.task)
  );
}

export function extractStatusSnapshot(result: unknown, requestedId: string): BgTaskSnapshot {
  if (isTaskSnapshot(result)) return result;

  if (isRecord(result) && Array.isArray(result.tasks)) {
    const candidates = result.tasks.filter(isTaskSnapshot);
    const exact = candidates.filter((task) => task.id === requestedId);
    if (exact.length === 1) return exact[0]!;

    const prefix = candidates.filter((task) => task.id.startsWith(requestedId));
    if (prefix.length === 1) return prefix[0]!;
    if (prefix.length > 1) {
      throw new Error(`Background task id prefix '${requestedId}' is ambiguous.`);
    }
  }

  throw new Error(`Unexpected status response for background task '${requestedId}'.`);
}
