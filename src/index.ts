import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-bg-handoff for ismailsaleekh/pi-background-tasks.
 *
 * Routing is fully automatic; there are no in-band command markers.
 *
 * 1. Pre-execution handoff. Commands that are unbounded or known-slow are started through the
 *    pi-background-tasks EventBus v1 *before* the foreground Bash call runs, and the original
 *    call is blocked with a message. This covers the built-in long-running patterns and commands
 *    the fingerprint cache already saw exceed the window.
 *
 * 2. Timeout detection. Every other Bash call keeps running in the foreground, but this extension
 *    injects the Bash tool's own `timeout` argument (default 120s). If the command finishes inside
 *    the window, nothing changes: normal result, normal exit code. If it exceeds the window, the
 *    Bash tool kills it with its partial output preserved, and this extension's `tool_result`
 *    handler re-runs the command from the start as a tracked background task and appends the task
 *    id to the result.
 *
 * Pi cannot migrate an already-running foreground process to the background, so mechanism 2
 * re-executes instead of adopting the killed attempt. The fingerprint cache (`learn`) records
 * commands that exceeded the window so an identical command is handed off pre-emptively later and
 * the probe is paid only once.
 *
 * The model's own escape hatch is the Bash `timeout` argument: a call that supplies one is an
 * explicit foreground contract, so it is honored verbatim and never routed to the background.
 * Deliberate backgrounding is `bg_run` (model) or `/bg` (human).
 *
 * The extension also ships the `background-commands` skill under `skills/` and contributes it
 * through `resources_discover`, so installing this extension enables the skill too. The guidance
 * message is injected once per distinct content instead of once per turn.
 *
 * Defaults are read once at load time from `<agentDir>/pi-bg-handoff.json` (override the path with
 * the `PI_BG_HANDOFF_CONFIG` environment variable). Unknown or invalid fields are ignored and
 * reported as warnings; `/bg-handoff` still overrides everything for the current session.
 */

const REQUEST = "pi-background-tasks:request:v1";
const RESPONSE = "pi-background-tasks:response:v1";
const TERMINAL = "pi-background-tasks:terminal:v1";
const REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
const RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
const TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";

const DEFAULT_WINDOW_SECONDS = 2 * 60;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 3600;
const DEFAULT_TASK_TIMEOUT_SECONDS = 4 * 60 * 60;
const MIN_TASK_TIMEOUT_SECONDS = 1;
const MAX_TASK_TIMEOUT_SECONDS = 86400;
const MAX_TRACKED_CALLS = 500;
const MAX_LEARNED_COMMANDS = 200;
/** Skills shipped inside this extension directory. */
const SKILLS_DIR_NAME = "skills";
/** Persistent defaults, read once at load time. */
const CONFIG_FILE_NAME = "pi-bg-handoff.json";
const CONFIG_PATH_ENV = "PI_BG_HANDOFF_CONFIG";
/** Legacy `#bg `/`#foreground ` prefixes are no longer semantics, only stripped. */
const LEGACY_MARKER = /^#(bg|foreground)\s+/i;

type Mode = "auto" | "patterns" | "off";
type Policy = "wake" | "notify" | "silent";
type Route = "preempt" | "window" | "none";
/** Shape accepted by `<agentDir>/pi-bg-handoff.json`. Every field is optional. */
type HandoffConfig = {
  mode?: Mode;
  windowSeconds?: number;
  taskTimeoutSeconds?: number;
  policy?: Policy;
  learn?: boolean;
  guidance?: boolean;
  extraPatterns?: string[];
};
type TaskSnapshot = {
  id?: string;
  status?: string;
  name?: string;
  outputPath?: string;
};
type BgResponse = {
  schema_version?: string;
  request_id?: string;
  operation?: string;
  ok?: boolean;
  result?: TaskSnapshot | { tasks?: TaskSnapshot[] } | Record<string, unknown>;
  error?: string;
};

const AUTO_PATTERNS: RegExp[] = [
  // Long-lived servers and watchers.
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i,
  /\b(vite|next\s+dev|nodemon|tsx\s+watch|tsc\s+watch|webpack\s+watch)\b/i,
  /\b(tail\s+-f|journalctl\s+-f|docker\s+compose\s+up|docker-compose\s+up)\b/i,
  // Common slow jobs whose output may be sparse.
  /\b(npm\s+ci|pnpm\s+install|yarn\s+install|bun\s+install)\b/i,
  /\b(cargo\s+(build|test)|go\s+test|pytest|playwright\s+test)\b/i,
];

function shortName(command: string): string {
  const first = command.trim().split(/\r?\n/, 1)[0] || "Background shell task";
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}

function fingerprint(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** The Bash tool appends its timeout status as the final line of an error result. */
function timedOutAtWindow(text: string, windowSeconds: number): boolean {
  const match = text.trimEnd().match(/Command timed out after (\d+(?:\.\d+)?) seconds$/);
  return match !== null && Number(match[1]) === windowSeconds;
}

/** Persistent defaults file, read once when the extension loads. */
const KNOWN_CONFIG_KEYS = new Set([
  "mode",
  "windowSeconds",
  "taskTimeoutSeconds",
  "policy",
  "learn",
  "guidance",
  "extraPatterns",
]);

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Locate the shipped `skills/` directory from wherever this module lives.
 *
 * The file can be loaded as `src/index.ts` (development) or `dist/index.ts` (built package), so the
 * search walks up from the module directory instead of assuming one layout.
 */
function findSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth <= 3; depth++) {
    const candidate = join(here, "..".repeat(depth), SKILLS_DIR_NAME);
    try {
      if (readFileSync(join(candidate, "background-commands", "SKILL.md"), "utf8").length > 0) return candidate;
    } catch {
      // Not here; keep walking up.
    }
  }
  return join(here, SKILLS_DIR_NAME);
}

/**
 * `<agentDir>/pi-bg-handoff.json`, or the `PI_BG_HANDOFF_CONFIG` override.
 *
 * The agent directory is computed here instead of importing `getAgentDir()` from the Pi package so
 * `selftest.mjs` can drive this file with plain `node`: a bare package specifier is not resolvable
 * from the extensions directory outside Pi's own module aliases.
 */
function resolveConfigPath(): string {
  const override = process.env[CONFIG_PATH_ENV];
  if (typeof override === "string" && override.trim()) return override.trim();
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof envDir === "string" && envDir.trim()
      ? envDir.trim().replace(/^~(?=$|\/)/, homedir())
      : join(homedir(), ".pi", "agent");
  return join(agentDir, CONFIG_FILE_NAME);
}

/**
 * Read the persistent defaults. A missing file is the normal case; every other problem is returned
 * as a message so the extension can warn instead of failing to load.
 */
function readConfigFile(): { path: string; config: HandoffConfig; problems: string[] } {
  const path = resolveConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { path, config: {}, problems: code === "ENOENT" ? [] : [`could not read ${path}: ${String(error)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { path, config: {}, problems: [`${path} is not valid JSON: ${String(error)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, config: {}, problems: [`${path} must contain a JSON object`] };
  }

  const raw = parsed as Record<string, unknown>;
  const config: HandoffConfig = {};
  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) problems.push(`unknown field "${key}" was ignored`);
  }

  if (raw.mode !== undefined) {
    if (raw.mode === "auto" || raw.mode === "patterns" || raw.mode === "off") config.mode = raw.mode;
    else problems.push('mode must be "auto", "patterns", or "off"');
  }

  const boundedInt = (name: string, value: unknown, min: number, max: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return undefined;
    }
    return value;
  };
  const window = boundedInt("windowSeconds", raw.windowSeconds, MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS);
  if (window !== undefined) config.windowSeconds = window;
  const taskTimeout = boundedInt("taskTimeoutSeconds", raw.taskTimeoutSeconds, MIN_TASK_TIMEOUT_SECONDS, MAX_TASK_TIMEOUT_SECONDS);
  if (taskTimeout !== undefined) config.taskTimeoutSeconds = taskTimeout;

  if (raw.policy !== undefined) {
    if (raw.policy === "wake" || raw.policy === "notify" || raw.policy === "silent") config.policy = raw.policy;
    else problems.push('policy must be "wake", "notify", or "silent"');
  }
  if (raw.learn !== undefined) {
    if (typeof raw.learn === "boolean") config.learn = raw.learn;
    else problems.push("learn must be a boolean");
  }
  if (raw.guidance !== undefined) {
    if (typeof raw.guidance === "boolean") config.guidance = raw.guidance;
    else problems.push("guidance must be a boolean");
  }
  if (raw.extraPatterns !== undefined) {
    if (!Array.isArray(raw.extraPatterns)) {
      problems.push("extraPatterns must be an array of regular-expression strings");
    } else {
      const accepted: string[] = [];
      for (const entry of raw.extraPatterns) {
        if (typeof entry !== "string") {
          problems.push("extraPatterns entries must be strings");
          continue;
        }
        try {
          new RegExp(entry);
        } catch {
          problems.push(`extraPatterns entry is not a valid regular expression: ${entry}`);
          continue;
        }
        accepted.push(entry);
      }
      if (accepted.length > 0) config.extraPatterns = accepted;
    }
  }

  return { path, config, problems };
}

export default function piBgHandoff(pi: ExtensionAPI) {
  const configFile = readConfigFile();
  /** Fields that were present but unusable; surfaced as warnings, never fatal. */
  const configIssues = [...configFile.problems];

  let mode: Mode = configFile.config.mode ?? "auto";
  let policy: Policy = configFile.config.policy ?? "wake";
  let learn = configFile.config.learn ?? true;
  /** Foreground detection window for the injected Bash `timeout`. */
  let windowSeconds = configFile.config.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  /** Hard timeout handed to pi-background-tasks for tasks that move to the background. */
  let taskTimeoutSeconds = configFile.config.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
  /** Set `"guidance": false` to keep the model-facing guidance message out entirely. */
  let guidanceEnabled = configFile.config.guidance ?? true;
  let legacyMarkerSeen = false;

  /** Built-in patterns plus any `extraPatterns` from the config file. */
  const patterns: RegExp[] = [...AUTO_PATTERNS];
  for (const source of configFile.config.extraPatterns ?? []) {
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      // Already validated by readConfigFile; a hostile pattern is simply skipped.
    }
  }

  const commandToTask = new Map<string, string>();
  /** taskId -> the dedupe key (cwd + NUL + command), not the bare command. */
  const taskToCommand = new Map<string, string>();
  const recentlyStarted = new Set<string>();
  /** toolCallId -> the call whose `timeout` argument this extension injected. */
  const injectedCalls = new Map<string, { command: string; cwd: string; windowSeconds: number }>();
  /** Commands observed to exceed the window, so identical calls skip the probe. */
  const learnedLong = new Map<string, { windowSeconds: number; at: number }>();

  function guidanceContent(): string {
    return `pi-bg-handoff routes long Bash commands to ismailsaleekh/pi-background-tasks automatically. Commands matching long-running patterns (servers, watchers, installs, builds, tests) are handed off before execution instead of being probed. Every other Bash call runs with an injected ${windowSeconds}s timeout window: commands that finish inside it behave normally, and commands that exceed it are killed, re-run from the start as a tracked background task, and their result reports the new task id with the partial output preserved. To keep a command in the foreground, pass the Bash tool's own \`timeout\` argument: an explicit timeout is honored verbatim and is never routed to the background. To background a command deliberately, call the \`bg_run\` tool (or \`/bg\` for a human-typed command). When a Bash call is blocked or re-run as a background task, do not repeat that command; continue the goal using other work. When the background task completes, use bg_status/bg_logs or /jobs and resume based on its result.`;
  }

  /** Content of the guidance message already in this session's transcript, if any. */
  let lastGuidanceContent: string | undefined;

  function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
    map.set(key, value);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  async function request(operation: string, payload: Record<string, unknown>): Promise<BgResponse> {
    const requestId = randomUUID();
    return await new Promise<BgResponse>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const unsubscribe = pi.events.on(RESPONSE, (frame: unknown) => {
        if (!frame || typeof frame !== "object") return;
        const response = frame as BgResponse;
        if (response.schema_version !== RESPONSE_SCHEMA || response.request_id !== requestId) return;
        finish(() => {
          if (response.ok) resolve(response);
          else reject(new Error(response.error || `pi-background-tasks ${operation} failed`));
        });
      });
      const timer = setTimeout(() => finish(() => reject(new Error("Timed out waiting for pi-background-tasks response"))), 5000);
      try {
        pi.events.emit(REQUEST, {
          schema_version: REQUEST_SCHEMA,
          request_id: requestId,
          operation,
          payload,
        });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  async function launch(command: string): Promise<TaskSnapshot> {
    const response = await request("run", {
      name: shortName(command),
      command,
      isAgent: false,
      timeoutSeconds: taskTimeoutSeconds,
      notifyOnCompletion: policy !== "silent",
      triggerOnCompletion: policy === "wake",
    });
    const task = response.result as TaskSnapshot | undefined;
    if (!task || typeof task.id !== "string" || !task.id) {
      throw new Error("pi-background-tasks returned no task id");
    }
    return task;
  }

  type HandoffOutcome = { ok: true; task: TaskSnapshot } | { ok: false; error: string; existingTaskId?: string };

  /**
   * Submit one command to pi-background-tasks. Returns an outcome instead of blocking so the
   * pre-execution path can block the tool call and the post-timeout path can amend a result.
   */
  async function submitHandoff(command: string, cwd: string, notify: (message: string) => void): Promise<HandoffOutcome> {
    const key = `${cwd}\0${command}`;
    const existing = commandToTask.get(key);
    if (existing) return { ok: false, error: "already handed off in this session", existingTaskId: existing };
    if (recentlyStarted.has(key)) return { ok: false, error: "already being submitted to pi-background-tasks" };

    recentlyStarted.add(key);
    try {
      // Confirm the manager is initialized before committing to a handoff.
      await request("capabilities", {});
      const task = await launch(command);
      commandToTask.set(key, task.id!);
      taskToCommand.set(task.id!, key);
      return { ok: true, task };
    } catch (error) {
      notify(`pi-bg-handoff could not submit the task: ${String(error)}`);
      return { ok: false, error: String(error) };
    } finally {
      recentlyStarted.delete(key);
    }
  }

  pi.events.on(TERMINAL, (frame: unknown) => {
    if (!frame || typeof frame !== "object") return;
    const terminal = frame as { schema_version?: string; task?: TaskSnapshot };
    if (terminal.schema_version !== TERMINAL_SCHEMA || !terminal.task?.id) return;
    const taskId = terminal.task.id;
    const key = taskToCommand.get(taskId);
    if (key) {
      commandToTask.delete(key);
      taskToCommand.delete(taskId);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (configIssues.length === 0 || !ctx.hasUI) return;
    ctx.ui.notify(`pi-bg-handoff: ${configIssues.join(" · ")}`, "warning");
  });

  pi.registerCommand("bg-handoff", {
    description:
      "Configure pi-bg-handoff: status | auto | patterns | off | timeout <seconds> | task-timeout <seconds> | policy wake|notify|silent | learn on|off",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "status").toLowerCase();
      if (sub === "auto" || sub === "patterns" || sub === "off") mode = sub;
      else if (sub === "timeout") {
        const value = Number(parts[1]);
        if (!Number.isInteger(value) || value < MIN_WINDOW_SECONDS || value > MAX_WINDOW_SECONDS) {
          ctx.ui.notify(`Usage: /bg-handoff timeout <${MIN_WINDOW_SECONDS}..${MAX_WINDOW_SECONDS} seconds>`, "warning");
          return;
        }
        windowSeconds = value;
      } else if (sub === "task-timeout") {
        const value = Number(parts[1]);
        if (!Number.isInteger(value) || value < MIN_TASK_TIMEOUT_SECONDS || value > MAX_TASK_TIMEOUT_SECONDS) {
          ctx.ui.notify(`Usage: /bg-handoff task-timeout <${MIN_TASK_TIMEOUT_SECONDS}..${MAX_TASK_TIMEOUT_SECONDS} seconds>`, "warning");
          return;
        }
        taskTimeoutSeconds = value;
      } else if (sub === "policy") {
        const value = parts[1];
        if (value !== "wake" && value !== "notify" && value !== "silent") {
          ctx.ui.notify("Usage: /bg-handoff policy wake|notify|silent", "warning");
          return;
        }
        policy = value;
      } else if (sub === "learn") {
        const value = parts[1];
        if (value !== "on" && value !== "off") {
          ctx.ui.notify("Usage: /bg-handoff learn on|off", "warning");
          return;
        }
        learn = value === "on";
        if (!learn) learnedLong.clear();
      } else if (sub !== "status") {
        ctx.ui.notify(
          "Usage: /bg-handoff [status|auto|patterns|off|timeout <seconds>|task-timeout <seconds>|policy wake|notify|silent|learn on|off]",
          "warning",
        );
        return;
      }
      let service = "available";
      try {
        await request("capabilities", {});
      } catch {
        service = "missing";
      }
      ctx.ui.notify(
        `mode=${mode} · manager=${service} · window=${windowSeconds}s · task-timeout=${taskTimeoutSeconds}s · learn=${learn ? `on (${learnedLong.size})` : "off"} · guidance=${guidanceEnabled ? "on" : "off"} · completion=${policy} · activeHandoffs=${commandToTask.size} · config=${configFile.path}${configIssues.length > 0 ? ` · configIssues=${configIssues.length}` : ""}`,
        service === "available" ? "info" : "warning",
      );
    },
  });

  pi.on("before_agent_start", (event) => {
    // `off` means nothing is routed, and `"guidance": false` opts out entirely.
    if (!guidanceEnabled || mode === "off") return;
    // Runs started by extension-sent custom messages do not need a fresh copy.
    if (event.messageType !== "user") return;
    const content = guidanceContent();
    // Inject once per distinct content: the earlier copy stays in the transcript and therefore in
    // model context, so the guidance is not repeated on every turn.
    if (content === lastGuidanceContent) return;
    lastGuidanceContent = content;
    return {
      message: {
        customType: "pi-bg-handoff-guidance",
        content,
        // `display` is a boolean in Pi's CustomMessage contract: false keeps the guidance in model
        // context without rendering it into the transcript on every turn.
        display: false,
      },
    };
  });

  // A compaction or tree navigation can drop the injected copy, so allow one fresh injection after.
  pi.on("session_compact", () => { lastGuidanceContent = undefined; });
  pi.on("session_tree", () => { lastGuidanceContent = undefined; });

  pi.on("resources_discover", () => {
    try {
      return { skillPaths: [findSkillsDir()] };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || mode === "off") return;
    const input = event.input as Record<string, unknown>;
    if (typeof input.command !== "string") return;

    let command = input.command.trim();
    // Legacy markers: strip them so they cannot become a shell comment that silently swallows the
    // command, but give them no routing meaning.
    if (LEGACY_MARKER.test(command)) {
      command = command.replace(LEGACY_MARKER, "").trim();
      input.command = command;
      if (!legacyMarkerSeen) {
        legacyMarkerSeen = true;
        if (ctx.hasUI) ctx.ui.notify("pi-bg-handoff: `#bg ` and `#foreground ` are no longer markers; use `bg_run` or a Bash `timeout` argument.", "info");
      }
    }
    if (!command) return;

    const notify = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };

    const modelTimeout =
      typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;

    let route: Route = "none";
    let reason = "no long-running pattern matched";
    if (mode === "auto" || mode === "patterns") {
      const matched = patterns.find((pattern) => pattern.test(command));
      if (matched) {
        route = "preempt";
        reason = `matched ${matched}`;
      } else if (mode === "auto" && learn) {
        const learned = learnedLong.get(fingerprint(command));
        if (learned) {
          route = "preempt";
          reason = `this exact command already exceeded the ${learned.windowSeconds}s window earlier in this session, so it was handed off without probing it again`;
        }
      }
    }
    // An explicit `timeout` from the model is a foreground contract: it outranks automatic routing.
    if (modelTimeout !== undefined && route === "preempt") {
      route = "none";
      reason = "the call supplied its own timeout, so it stays in the foreground";
    }
    if (route === "none" && mode === "auto" && modelTimeout === undefined) route = "window";

    if (route === "preempt") {
      const outcome = await submitHandoff(command, ctx.cwd, notify);
      if (outcome.ok) {
        return {
          block: true,
          reason: `[pi-bg-handoff] Started background task ${outcome.task.id} (${shortName(command)}). The original foreground Bash call was not run. Do not repeat it. Continue the current goal using independent work; when this task completes, inspect its output with bg_logs/bg_status or /jobs. Handoff reason: ${reason}.`,
        };
      }
      if (outcome.existingTaskId) {
        return {
          block: true,
          reason: `[pi-bg-handoff] This command was already handed off as background task ${outcome.existingTaskId}. Do not launch it again. Continue the current goal; inspect it with /jobs or bg_status/bg_logs.`,
        };
      }
      // Fail open: with no manager, let the original command run (bounded below when possible).
      if (mode === "patterns" || modelTimeout !== undefined) return;
      route = "window";
    }

    if (route === "window") {
      // Timeout detection: bound the foreground attempt with the Bash tool's own timeout argument.
      const effectiveWindow = modelTimeout === undefined ? windowSeconds : Math.min(modelTimeout, windowSeconds);
      input.timeout = effectiveWindow;
      remember(injectedCalls, event.toolCallId, { command, cwd: ctx.cwd, windowSeconds: effectiveWindow }, MAX_TRACKED_CALLS);
    }
    return;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const injected = injectedCalls.get(event.toolCallId);
    if (!injected) return;
    injectedCalls.delete(event.toolCallId);
    if (!event.isError) return;

    const text = extractText(event.content);
    if (!timedOutAtWindow(text, injected.windowSeconds)) return;

    if (learn) remember(learnedLong, fingerprint(injected.command), { windowSeconds: injected.windowSeconds, at: Date.now() }, MAX_LEARNED_COMMANDS);

    const outcome = await submitHandoff(injected.command, injected.cwd, (message) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    });

    const head =
      `[pi-bg-handoff] Foreground Bash exceeded the ${injected.windowSeconds}s timeout window and was killed at ${injected.windowSeconds}s. ` +
      `Output above is the partial result of that killed attempt.`;
    const tail = outcome.ok
      ? `The command is now running from the start as background task ${outcome.task.id} (${shortName(injected.command)}). Do not run it again in the foreground. Continue the current goal using independent work; when it completes, inspect its output with bg_logs/bg_status or /jobs.${learn ? " The identical command will be handed off immediately for the rest of this session." : ""}`
      : outcome.existingTaskId
        ? `It was already handed off as background task ${outcome.existingTaskId}. Do not run it again.`
        : `Automatic handoff failed (${outcome.error}). The command is not running; decide whether to retry it with a larger \`timeout\`, launch it with \`bg_run\`, or split it.`;

    return {
      content: [{ type: "text", text: `${text}\n\n${head} ${tail}` }],
      details: event.details,
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
      isError: true,
    };
  });
}
