import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * pi-bg-handoff for ismailsaleekh/pi-background-tasks.
 *
 * Routing is fully automatic; there are no in-band command markers.
 *
 * 1. Pre-execution handoff. Commands that are unbounded or known-slow are started through the
 *    pi-background-tasks EventBus v1 *before* the foreground Bash call runs, and the original
 *    call is blocked with a message. This covers the built-in long-running patterns and commands
 *    the fingerprint cache already saw exceed the window. Patterns are matched against a projection
 *    of the command in which quoted spans and heredoc bodies are blanked out, because they are
 *    arguments: `grep -n "playwright test" src/` is a search, not a test run.
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
 * A Bash `timeout` the model supplies is a budget, not an escape hatch: with the default
 * `explicitTimeout: "handoff"` it bounds the foreground attempt but never prevents routing, so a
 * pattern-matched command is handed off immediately and any command that exceeds its window is
 * re-run in the background. `explicitTimeout: "foreground"` (or `/bg-handoff explicit-timeout
 * foreground`) is the human opt-in that restores the older contract where an explicit timeout keeps
 * the call in the foreground; the model has no way to ask for foreground execution, because a
 * foreground call can block the turn for as long as the command takes. A re-run re-executes from the
 * beginning, so the killed attempt's side effects happen twice. Deliberate backgrounding is `bg_run`
 * (model) or `/bg` (human).
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
/** 0 means the foreground gets no probe time: every Bash call starts as a background task. */
const MIN_WINDOW_SECONDS = 0;
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
/** `"handoff"` (default): an explicit Bash `timeout` bounds the probe but does not veto routing. */
/**
 * Shared with the vendored `pi-agent-wait` fork, which registers itself into this slot at load so
 * `/bg-handoff wait off|on` can disable the wait tools for the session without un-registering them.
 */
const WAIT_CONTROL_SLOT = Symbol.for("pi-bg-handoff.wait-control:v1");
/**
 * Published for the vendored `pi-background-tasks` fork. `{ enabled: false }` keeps the footer to task
 * state: the dock-entry hint and the `/bg-clear` hint are not advertised. This package publishes
 * `false` unless `"footerHints": true` opts back in, and the fork reads the slot when the footer renders,
 * so extension load order does not matter.
 */
const FOOTER_HINTS_SLOT = Symbol.for("pi-bg-handoff.footer-hints:v1");
function waitControlSlot() {
    const value = globalThis[WAIT_CONTROL_SLOT];
    if (!value || typeof value !== "object")
        return undefined;
    const candidate = value;
    return typeof candidate.setEnabled === "function" ? candidate : undefined;
}
const AUTO_PATTERNS = [
    // Long-lived servers and watchers.
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/i,
    /\b(vite|next\s+dev|nodemon|tsx\s+watch|tsc\s+watch|webpack\s+watch)\b/i,
    /\b(tail\s+-f|journalctl\s+-f|docker\s+compose\s+up|docker-compose\s+up)\b/i,
    // Common slow jobs whose output may be sparse.
    /\b(npm\s+ci|pnpm\s+install|yarn\s+install|bun\s+install)\b/i,
    /\b(cargo\s+(build|test)|go\s+test|pytest|playwright\s+test)\b/i,
];
/**
 * Patterns describe what a command *runs*. Text inside quotes is an argument, so a search term that
 * happens to look like a server or a test runner (`grep -n "pytest" src/`) must not route the call.
 */
function matchProjection(command) {
    return command
        .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?\n\s*\2(?=$|\s)/g, " ")
        .replace(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`/g, ' "" ');
}
function shortName(command) {
    const first = command.trim().split(/\r?\n/, 1)[0] || "Background shell task";
    return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}
function fingerprint(command) {
    return command.trim().replace(/\s+/g, " ");
}
/** The Bash tool appends its timeout status as the final line of an error result. */
function timedOutAtWindow(text, windowSeconds) {
    const match = text.trimEnd().match(/Command timed out after (\d+(?:\.\d+)?) seconds$/);
    return match !== null && Number(match[1]) === windowSeconds;
}
/** Persistent defaults file, read once when the extension loads. */
const KNOWN_CONFIG_KEYS = new Set([
    "mode",
    "windowSeconds",
    "explicitTimeout",
    "taskTimeoutSeconds",
    "policy",
    "learn",
    "guidance",
    "extraPatterns",
    "wait",
    "footerHints",
    "stubGuard",
]);
/**
 * A turn whose entire visible output is "I am waiting" (or nothing at all).
 *
 * Only whole-text matches count: a real answer that happens to contain the word "wait"
 * is not a stub. This is the shape that makes an agent look stalled while a scheduler
 * keeps waking it up.
 */
const STUB_PATTERNS = [
    /^(等待中|等待|还在等|仍在等|正在等|继续等待|先等着|等着|稍等|后台运行中|运行中)([….。！!~～\s]*)$/,
    /^(wait(ing)?( for it)?|still (waiting|running)|hold(ing)?( on| tight)?|pending|running in the background|in progress)(…|\.\.\.|\.|\s)*$/i,
    /^(…|\.\.\.|。|⠋|⠙)+$/,
];
/** How many times per session a stub turn may be bounced back before the guard stands down. */
const MAX_STUB_NUDGES = 3;
function isWaitingStub(text) {
    const normalized = text.trim();
    if (normalized.length === 0)
        return true;
    return STUB_PATTERNS.some((pattern) => pattern.test(normalized));
}
function extractText(content) {
    if (!Array.isArray(content))
        return "";
    return content
        .filter((part) => !!part && typeof part === "object" && part.type === "text" &&
        typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
}
/**
 * Locate the shipped `skills/` directory from wherever this module lives.
 *
 * The file can be loaded as `src/index.ts` (development) or `dist/index.ts` (built package), so the
 * search walks up from the module directory instead of assuming one layout.
 */
function findSkillsDir() {
    const here = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth <= 3; depth++) {
        const candidate = join(here, "..".repeat(depth), SKILLS_DIR_NAME);
        try {
            if (readFileSync(join(candidate, "background-commands", "SKILL.md"), "utf8").length > 0)
                return candidate;
        }
        catch {
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
function resolveConfigPath() {
    const override = process.env[CONFIG_PATH_ENV];
    if (typeof override === "string" && override.trim())
        return override.trim();
    const envDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = typeof envDir === "string" && envDir.trim()
        ? envDir.trim().replace(/^~(?=$|\/)/, homedir())
        : join(homedir(), ".pi", "agent");
    return join(agentDir, CONFIG_FILE_NAME);
}
/**
 * Read the persistent defaults. A missing file is the normal case; every other problem is returned
 * as a message so the extension can warn instead of failing to load.
 */
function readConfigFile() {
    const path = resolveConfigPath();
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (error) {
        const code = error.code;
        return { path, config: {}, problems: code === "ENOENT" ? [] : [`could not read ${path}: ${String(error)}`] };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        return { path, config: {}, problems: [`${path} is not valid JSON: ${String(error)}`] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { path, config: {}, problems: [`${path} must contain a JSON object`] };
    }
    const raw = parsed;
    const config = {};
    const problems = [];
    for (const key of Object.keys(raw)) {
        if (!KNOWN_CONFIG_KEYS.has(key))
            problems.push(`unknown field "${key}" was ignored`);
    }
    if (raw.mode !== undefined) {
        if (raw.mode === "auto" || raw.mode === "off")
            config.mode = raw.mode;
        else if (raw.mode === "patterns")
            problems.push('mode "patterns" is gone - long-running commands always go to the background; "off" is the only opt-out and it routes nothing');
        else
            problems.push('mode must be "auto" or "off"');
    }
    const boundedInt = (name, value, min, max) => {
        if (value === undefined)
            return undefined;
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
            problems.push(`${name} must be an integer between ${min} and ${max}`);
            return undefined;
        }
        return value;
    };
    if (raw.explicitTimeout !== undefined) {
        if (raw.explicitTimeout === "handoff" || raw.explicitTimeout === "foreground")
            config.explicitTimeout = raw.explicitTimeout;
        else
            problems.push('explicitTimeout must be "handoff" or "foreground"');
    }
    const window = boundedInt("windowSeconds", raw.windowSeconds, MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS);
    if (window !== undefined)
        config.windowSeconds = window;
    const taskTimeout = boundedInt("taskTimeoutSeconds", raw.taskTimeoutSeconds, MIN_TASK_TIMEOUT_SECONDS, MAX_TASK_TIMEOUT_SECONDS);
    if (taskTimeout !== undefined)
        config.taskTimeoutSeconds = taskTimeout;
    if (raw.policy !== undefined) {
        if (raw.policy === "wake" || raw.policy === "notify" || raw.policy === "silent")
            config.policy = raw.policy;
        else
            problems.push('policy must be "wake", "notify", or "silent"');
    }
    if (raw.learn !== undefined) {
        if (typeof raw.learn === "boolean")
            config.learn = raw.learn;
        else
            problems.push("learn must be a boolean");
    }
    if (raw.guidance !== undefined) {
        if (typeof raw.guidance === "boolean")
            config.guidance = raw.guidance;
        else
            problems.push("guidance must be a boolean");
    }
    if (raw.wait !== undefined) {
        if (typeof raw.wait === "boolean")
            config.wait = raw.wait;
        else
            problems.push("wait must be a boolean");
    }
    if (raw.stubGuard !== undefined) {
        if (typeof raw.stubGuard === "boolean")
            config.stubGuard = raw.stubGuard;
        else
            problems.push("stubGuard must be a boolean");
    }
    if (raw.footerHints !== undefined) {
        if (typeof raw.footerHints === "boolean")
            config.footerHints = raw.footerHints;
        else
            problems.push("footerHints must be a boolean");
    }
    if (raw.extraPatterns !== undefined) {
        if (!Array.isArray(raw.extraPatterns)) {
            problems.push("extraPatterns must be an array of regular-expression strings");
        }
        else {
            const accepted = [];
            for (const entry of raw.extraPatterns) {
                if (typeof entry !== "string") {
                    problems.push("extraPatterns entries must be strings");
                    continue;
                }
                try {
                    new RegExp(entry);
                }
                catch {
                    problems.push(`extraPatterns entry is not a valid regular expression: ${entry}`);
                    continue;
                }
                accepted.push(entry);
            }
            if (accepted.length > 0)
                config.extraPatterns = accepted;
        }
    }
    return { path, config, problems };
}
export default function piBgHandoff(pi) {
    const configFile = readConfigFile();
    /** Fields that were present but unusable; surfaced as warnings, never fatal. */
    const configIssues = [...configFile.problems];
    let mode = configFile.config.mode ?? "auto";
    let policy = configFile.config.policy ?? "wake";
    let learn = configFile.config.learn ?? true;
    /** Foreground detection window for the injected Bash `timeout`. */
    let windowSeconds = configFile.config.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    /** Default "handoff": a timeout the model passes only bounds the foreground probe. `"foreground"` is the
     * human opt-in contract where an explicit timeout outranks routing - it is not something the model can ask for. */
    let explicitTimeout = configFile.config.explicitTimeout ?? "handoff";
    /** Hard timeout handed to pi-background-tasks for tasks that move to the background. */
    let taskTimeoutSeconds = configFile.config.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
    /** Set `"guidance": false` to keep the model-facing guidance message out entirely. */
    let guidanceEnabled = configFile.config.guidance ?? true;
    /** Whether an explicit Bash `timeout` keeps a call in the foreground. */
    /** Mirrors the wait tools' state; the fork owns the tools and reports the truth through its slot. */
    let waitRequested = configFile.config.wait ?? true;
    /** Footer hints are off by default in both forks; `"footerHints": true` opts back in, and
     * `PI_BG_FOOTER_HINTS` decides instead when it is set. */
    const envFooterHints = process.env.PI_BG_FOOTER_HINTS;
    let footerHintsEnabled = configFile.config.footerHints ?? false;
    if (envFooterHints === "on" || envFooterHints === "off")
        footerHintsEnabled = envFooterHints === "on";
    /** Bounce back a turn whose entire visible output is a waiting stub and which ran no tool. */
    let stubGuardEnabled = configFile.config.stubGuard ?? true;
    if (process.env.PI_BG_STUB_GUARD === "on" || process.env.PI_BG_STUB_GUARD === "off") {
        stubGuardEnabled = process.env.PI_BG_STUB_GUARD === "on";
    }
    let stubNudges = 0;
    globalThis[FOOTER_HINTS_SLOT] = { enabled: footerHintsEnabled };
    let legacyMarkerSeen = false;
    /** Built-in patterns plus any `extraPatterns` from the config file. */
    const patterns = [...AUTO_PATTERNS];
    for (const source of configFile.config.extraPatterns ?? []) {
        try {
            patterns.push(new RegExp(source, "i"));
        }
        catch {
            // Already validated by readConfigFile; a hostile pattern is simply skipped.
        }
    }
    const commandToTask = new Map();
    /** taskId -> the dedupe key (cwd + NUL + command), not the bare command. */
    const taskToCommand = new Map();
    const recentlyStarted = new Set();
    /** toolCallId -> the call whose `timeout` argument this extension injected. */
    const injectedCalls = new Map();
    /** Commands observed to exceed the window, so identical calls skip the probe. */
    const learnedLong = new Map();
    function guidanceContent() {
        const windowClause = windowSeconds === 0
            ? "`windowSeconds` is 0, so every Bash call is started as a tracked background task instead of being probed in the foreground."
            : `Every other Bash call runs with an injected ${windowSeconds}s timeout window: commands that finish inside it behave normally, and commands that exceed it are killed and re-run from the start as a tracked background task, with the partial output preserved and the new task id reported.`;
        const timeoutClause = explicitTimeout === "foreground"
            ? "A `timeout` argument you pass is a budget: here it also keeps the call in the foreground (the human set `explicit-timeout foreground`), so a command you bound yourself is not routed."
            : "A `timeout` argument you pass is a budget, not a way to stay in the foreground: a pattern-matched command is handed off regardless, and a command that exceeds its window is re-run in the background.";
        return `pi-bg-handoff routes long Bash commands to ismailsaleekh/pi-background-tasks automatically. Commands matching long-running patterns (servers, watchers, follow-logs such as \`tail -f\`, installs, builds, test runners) are handed off before execution instead of being probed; matching looks at what the command runs, so a quoted search term or a heredoc body never routes a call. ${windowClause} ${timeoutClause} A re-run starts the command over from the beginning, so anything the killed attempt already did happens twice (appends, copies, partially written files) - write commands so a second run is safe. When a Bash call is blocked or re-run as a background task, do not repeat that command; continue the goal using other work. A completed task notifies you and starts a follow-up turn, so do not poll: read its output with bg_logs, use bg_status only for the current state and /jobs for the list. To background a command deliberately, call the \`bg_run\` tool (or \`/bg\` for a human-typed command). The human-side switches are \`/bg-handoff status\`, \`patterns\` (list), \`timeout <seconds>\`, \`mode auto|off\` and \`explicit-timeout handoff|foreground\`; there is no foreground mode for you to ask for. A turn woken by a task notification or a host continuation must either do work or arm a host-side wait (\`bg_wait\` / \`bg_wait_for_task\`): never end it with a stub such as \`等待中\` or \`Waiting\` and no tool call. Do not economize on tokens while background work is in flight - read the output, verify the result, and report it completely; token cost is never a reason to skip a check or shorten a conclusion, only the time settings (timeouts, wait durations, queue order) are worth choosing carefully.`;
    }
    /** Content of the guidance message already in this session's transcript, if any. */
    let lastGuidanceContent;
    function remember(map, key, value, limit) {
        map.set(key, value);
        while (map.size > limit) {
            const oldest = map.keys().next().value;
            if (oldest === undefined)
                break;
            map.delete(oldest);
        }
    }
    async function request(operation, payload) {
        const requestId = randomUUID();
        return await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                unsubscribe();
                fn();
            };
            const unsubscribe = pi.events.on(RESPONSE, (frame) => {
                if (!frame || typeof frame !== "object")
                    return;
                const response = frame;
                if (response.schema_version !== RESPONSE_SCHEMA || response.request_id !== requestId)
                    return;
                finish(() => {
                    if (response.ok)
                        resolve(response);
                    else
                        reject(new Error(response.error || `pi-background-tasks ${operation} failed`));
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
            }
            catch (error) {
                finish(() => reject(error));
            }
        });
    }
    async function launch(command) {
        const response = await request("run", {
            name: shortName(command),
            command,
            isAgent: false,
            timeoutSeconds: taskTimeoutSeconds,
            notifyOnCompletion: policy !== "silent",
            triggerOnCompletion: policy === "wake",
        });
        const task = response.result;
        if (!task || typeof task.id !== "string" || !task.id) {
            throw new Error("pi-background-tasks returned no task id");
        }
        return task;
    }
    /**
     * Submit one command to pi-background-tasks. Returns an outcome instead of blocking so the
     * pre-execution path can block the tool call and the post-timeout path can amend a result.
     */
    async function submitHandoff(command, cwd, notify) {
        const key = `${cwd}\0${command}`;
        const existing = commandToTask.get(key);
        if (existing)
            return { ok: false, error: "already handed off in this session", existingTaskId: existing };
        if (recentlyStarted.has(key))
            return { ok: false, error: "already being submitted to pi-background-tasks" };
        recentlyStarted.add(key);
        try {
            // Confirm the manager is initialized before committing to a handoff.
            await request("capabilities", {});
            const task = await launch(command);
            commandToTask.set(key, task.id);
            taskToCommand.set(task.id, key);
            return { ok: true, task };
        }
        catch (error) {
            notify(`pi-bg-handoff could not submit the task: ${String(error)}`);
            return { ok: false, error: String(error) };
        }
        finally {
            recentlyStarted.delete(key);
        }
    }
    pi.events.on(TERMINAL, (frame) => {
        if (!frame || typeof frame !== "object")
            return;
        const terminal = frame;
        if (terminal.schema_version !== TERMINAL_SCHEMA || !terminal.task?.id)
            return;
        const taskId = terminal.task.id;
        const key = taskToCommand.get(taskId);
        if (key) {
            commandToTask.delete(key);
            taskToCommand.delete(taskId);
        }
    });
    pi.on("session_start", (_event, ctx) => {
        if (configIssues.length === 0 || !ctx.hasUI)
            return;
        ctx.ui.notify(`pi-bg-handoff: ${configIssues.join(" · ")}`, "warning");
    });
    pi.registerCommand("bg-handoff", {
        description: "Configure pi-bg-handoff: status | auto | patterns | off | timeout <seconds> | task-timeout <seconds> | policy wake|notify|silent | learn on|off | explicit-timeout handoff|foreground | wait on|off | stub-guard on|off",
        handler: async (args, ctx) => {
            const parts = args.trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] || "status").toLowerCase();
            if (sub === "patterns") {
                ctx.ui.notify(`mode=${mode} · ${patterns.length} patterns route a command straight to the background: ${patterns.map((pattern) => pattern.source).join(" | ")} · set the mode with /bg-handoff mode auto|off`, "info");
                return;
            }
            if (sub === "mode") {
                const value = parts[1];
                if (value !== "auto" && value !== "off") {
                    ctx.ui.notify('Usage: /bg-handoff mode auto|off - there is no foreground mode: a long-running command goes to the background', "warning");
                    return;
                }
                mode = value;
                lastGuidanceContent = undefined;
            }
            else if (sub === "auto" || sub === "off") {
                mode = sub;
                lastGuidanceContent = undefined;
                ctx.ui.notify(`(older spelling) write /bg-handoff mode ${sub}`, "info");
            }
            else if (sub === "timeout") {
                const value = Number(parts[1]);
                if (!Number.isInteger(value) || value < MIN_WINDOW_SECONDS || value > MAX_WINDOW_SECONDS) {
                    ctx.ui.notify(`Usage: /bg-handoff timeout <${MIN_WINDOW_SECONDS}..${MAX_WINDOW_SECONDS} seconds>`, "warning");
                    return;
                }
                windowSeconds = value;
                lastGuidanceContent = undefined;
            }
            else if (sub === "task-timeout") {
                const value = Number(parts[1]);
                if (!Number.isInteger(value) || value < MIN_TASK_TIMEOUT_SECONDS || value > MAX_TASK_TIMEOUT_SECONDS) {
                    ctx.ui.notify(`Usage: /bg-handoff task-timeout <${MIN_TASK_TIMEOUT_SECONDS}..${MAX_TASK_TIMEOUT_SECONDS} seconds>`, "warning");
                    return;
                }
                taskTimeoutSeconds = value;
            }
            else if (sub === "policy") {
                const value = parts[1];
                if (value !== "wake" && value !== "notify" && value !== "silent") {
                    ctx.ui.notify("Usage: /bg-handoff policy wake|notify|silent", "warning");
                    return;
                }
                policy = value;
            }
            else if (sub === "learn") {
                const value = parts[1];
                if (value !== "on" && value !== "off") {
                    ctx.ui.notify("Usage: /bg-handoff learn on|off", "warning");
                    return;
                }
                learn = value === "on";
                if (!learn)
                    learnedLong.clear();
            }
            else if (sub === "explicit-timeout") {
                const value = parts[1];
                if (value !== "handoff" && value !== "foreground") {
                    ctx.ui.notify('Usage: /bg-handoff explicit-timeout handoff|foreground - "foreground" is a human opt-in: a model-supplied timeout is a budget, not a way to stay foreground', "warning");
                    return;
                }
                explicitTimeout = value;
                lastGuidanceContent = undefined;
            }
            else if (sub === "wait") {
                const value = parts[1];
                if (value !== "on" && value !== "off") {
                    ctx.ui.notify("Usage: /bg-handoff wait on|off", "warning");
                    return;
                }
                waitRequested = value === "on";
                const slot = waitControlSlot();
                if (slot)
                    slot.setEnabled(waitRequested);
                else
                    ctx.ui.notify("The wait tools are not loaded in this session, so there is nothing to toggle.", "warning");
            }
            else if (sub === "stub-guard") {
                const value = parts[1];
                if (value !== "on" && value !== "off") {
                    ctx.ui.notify("Usage: /bg-handoff stub-guard on|off", "warning");
                    return;
                }
                stubGuardEnabled = value === "on";
                if (stubGuardEnabled)
                    stubNudges = 0;
            }
            else if (sub !== "status") {
                ctx.ui.notify("Usage: /bg-handoff [status|mode auto|off|patterns|timeout <seconds>|task-timeout <seconds>|policy wake|notify|silent|learn on|off|explicit-timeout handoff|foreground|wait on|off|stub-guard on|off]", "warning");
                return;
            }
            let service = "available";
            try {
                await request("capabilities", {});
            }
            catch {
                service = "missing";
            }
            ctx.ui.notify(`mode=${mode} · manager=${service} · window=${windowSeconds === 0 ? "0s (every Bash call goes to background)" : `${windowSeconds}s`} · task-timeout=${taskTimeoutSeconds}s · learn=${learn ? `on (${learnedLong.size})` : "off"} · guidance=${guidanceEnabled ? "on" : "off"} · completion=${policy} · explicit-timeout=${explicitTimeout} · patterns=${patterns.length} · wait=${waitRequested ? "on" : "off"} · footerHints=${footerHintsEnabled ? "on" : "off"} · stub-guard=${stubGuardEnabled ? "on" : "off"} · activeHandoffs=${commandToTask.size} · config=${configFile.path}${configIssues.length > 0 ? ` · configIssues=${configIssues.length}: ${configIssues.slice(0, 3).join(" | ")}` : ""}`, service === "available" ? "info" : "warning");
        },
    });
    pi.on("before_agent_start", (event) => {
        // `off` means nothing is routed, and `"guidance": false` opts out entirely.
        if (!guidanceEnabled || mode === "off")
            return;
        // Runs started by extension-sent custom messages do not need a fresh copy.
        if (event.messageType !== "user")
            return;
        const content = guidanceContent();
        // Inject once per distinct content: the earlier copy stays in the transcript and therefore in
        // model context, so the guidance is not repeated on every turn.
        if (content === lastGuidanceContent)
            return;
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
    // The stub guard: a completed turn that ran no tool and whose whole visible output is
    // "等待中"/"Waiting"/nothing is answered with an error and one forced follow-up request,
    // so the model has to arm a real wait or say something with content in it.
    pi.on("turn_end", async (event, ctx) => {
        if (!stubGuardEnabled || stubNudges >= MAX_STUB_NUDGES)
            return;
        if (event.outcome !== "completed")
            return;
        if (Array.isArray(event.toolResults) && event.toolResults.length > 0)
            return;
        const message = event.message;
        if (!message)
            return;
        const blocks = Array.isArray(message.content) ? message.content : [];
        if (blocks.some((block) => !!block && typeof block === "object" && block.type === "toolCall"))
            return;
        const text = extractText(message.content).trim();
        if (!isWaitingStub(text))
            return;
        stubNudges += 1;
        const shown = text.replace(/\s+/g, " ").slice(0, 40) || "(empty)";
        ctx.ui.notify(`stub guard: bounced a waiting-stub turn (${stubNudges}/${MAX_STUB_NUDGES})`, "info");
        return {
            entries: [
                ...(Array.isArray(event.entries) ? event.entries : []),
                {
                    type: "custom_message",
                    customType: "pi-bg-handoff-stub-guard",
                    display: false,
                    content: `[pi-bg-handoff] Stub turn rejected (${stubNudges}/${MAX_STUB_NUDGES}): this turn ran no tool and its entire visible output was the waiting stub ${JSON.stringify(shown)}. ` +
                        "Do exactly one of: (1) arm the wait in the host with `bg_wait_for_task { taskId }` or `bg_wait { seconds }` and end the turn; " +
                        "(2) if a goal is focused and nothing is actionable, record the wait where the scheduler can see it (an event-only wait, no polling contract) or pause the goal; " +
                        "(3) end with a status line naming the running task, what will wake you, and what you will do next. " +
                        "Do not answer with a bare waiting stub again.",
                },
            ],
            continue: true,
        };
    });
    pi.on("resources_discover", () => {
        try {
            return { skillPaths: [findSkillsDir()] };
        }
        catch {
            return undefined;
        }
    });
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash" || mode === "off")
            return;
        const input = event.input;
        if (typeof input.command !== "string")
            return;
        let command = input.command.trim();
        // Legacy markers: strip them so they cannot become a shell comment that silently swallows the
        // command, but give them no routing meaning.
        if (LEGACY_MARKER.test(command)) {
            command = command.replace(LEGACY_MARKER, "").trim();
            input.command = command;
            if (!legacyMarkerSeen) {
                legacyMarkerSeen = true;
                if (ctx.hasUI)
                    ctx.ui.notify("pi-bg-handoff: `#bg ` and `#foreground ` are no longer markers; use `bg_run` or a Bash `timeout` argument.", "info");
            }
        }
        if (!command)
            return;
        const notify = (message) => {
            if (ctx.hasUI)
                ctx.ui.notify(message, "warning");
        };
        const modelTimeout = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0 ? input.timeout : undefined;
        let route = "none";
        let reason = "no long-running pattern matched";
        if (mode === "auto") {
            const matched = patterns.find((pattern) => pattern.test(matchProjection(command)));
            if (matched) {
                route = "preempt";
                reason = `matched ${matched}`;
            }
            else if (mode === "auto" && learn) {
                const learned = learnedLong.get(fingerprint(command));
                if (learned) {
                    route = "preempt";
                    reason = `this exact command already exceeded the ${learned.windowSeconds}s window earlier in this session, so it was handed off without probing it again`;
                }
            }
        }
        // `explicitTimeout: "foreground"` is the human opt-in: an explicit timeout outranks routing. With the
        // default "handoff" it only bounds the probe below.
        if (explicitTimeout === "foreground" && modelTimeout !== undefined) {
            route = "none";
            reason = "the call supplied its own timeout and explicitTimeout is \"foreground\", so it stays in the foreground";
        }
        if (route === "none" && windowSeconds === 0 && !(explicitTimeout === "foreground" && modelTimeout !== undefined)) {
            route = "preempt";
            reason = "windowSeconds is 0, so the foreground gets no probe time and every Bash call starts as a background task";
        }
        if (route === "none" && mode === "auto" && (modelTimeout === undefined || explicitTimeout === "handoff"))
            route = "window";
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
            if (windowSeconds === 0 || (explicitTimeout === "foreground" && modelTimeout !== undefined))
                return;
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
        if (event.toolName !== "bash")
            return;
        const injected = injectedCalls.get(event.toolCallId);
        if (!injected)
            return;
        injectedCalls.delete(event.toolCallId);
        if (!event.isError)
            return;
        const text = extractText(event.content);
        if (!timedOutAtWindow(text, injected.windowSeconds))
            return;
        if (learn)
            remember(learnedLong, fingerprint(injected.command), { windowSeconds: injected.windowSeconds, at: Date.now() }, MAX_LEARNED_COMMANDS);
        const outcome = await submitHandoff(injected.command, injected.cwd, (message) => {
            if (ctx.hasUI)
                ctx.ui.notify(message, "warning");
        });
        const head = `[pi-bg-handoff] Foreground Bash exceeded the ${injected.windowSeconds}s timeout window and was killed at ${injected.windowSeconds}s. ` +
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
//# sourceMappingURL=index.js.map