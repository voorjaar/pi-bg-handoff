// Standalone harness: fake pi host + fake pi-background-tasks manager, drives the real index.ts.
// Run: node --experimental-strip-types selftest.mjs
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import piBgHandoff from "./src/index.ts";

const projectRoot = dirname(fileURLToPath(import.meta.url));

const REQ = "pi-background-tasks:request:v1";
const RES = "pi-background-tasks:response:v1";
const TERM = "pi-background-tasks:terminal:v1";

/** Mirrors DEFAULT_WINDOW_SECONDS in index.ts so the harness tracks the shipped default. */
const WINDOW = 120;
const TIMEOUT_TEXT = `Command timed out after ${WINDOW} seconds`;

/** Keep every host deterministic: point the config path at a file that does not exist. */
process.env.PI_BG_HANDOFF_CONFIG = join(tmpdir(), "pi-bg-handoff-selftest-absent.json");

function makeHost() {
  const listeners = new Map();
  const notices = [];
  const launched = [];
  const handlers = {
    tool_call: [], tool_result: [], before_agent_start: [],
    resources_discover: [], session_compact: [], session_start: [],
  };
  let managerAvailable = true;
  let taskSeq = 0;
  let callSeq = 0;

  const events = {
    on(channel, handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },
    emit(channel, frame) {
      // Deliver to subscribers first, like the real EventBus.
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(frame);
      if (channel === REQ) {
        if (!managerAvailable) return; // no service -> request times out -> fail open
        queueMicrotask(() => {
          const id = frame.request_id;
          if (frame.operation === "capabilities") {
            events.emit(RES, { schema_version: "pi-background-tasks.extension-response.v1", request_id: id, operation: "capabilities", ok: true, result: { api_version: 1, run: true, status: true, logs: true, kill: true } });
            return;
          }
          if (frame.operation === "run") {
            const task = { id: `task-${++taskSeq}`, name: frame.payload.name, command: frame.payload.command, status: "running", outputPath: `/tmp/${taskSeq}.output`, timeoutSeconds: frame.payload.timeoutSeconds, notifyOnCompletion: frame.payload.notifyOnCompletion, triggerOnCompletion: frame.payload.triggerOnCompletion };
            launched.push(task);
            events.emit(RES, { schema_version: "pi-background-tasks.extension-response.v1", request_id: id, operation: "run", ok: true, result: task });
            return;
          }
          if (frame.operation === "status") {
            const wanted = frame.payload?.taskId;
            const task = launched.find((t) => t.id === wanted);
            if (!task) {
              events.emit(RES, { schema_version: "pi-background-tasks.extension-response.v1", request_id: id, operation: "status", ok: false, error: `unknown task ${wanted}` });
              return;
            }
            events.emit(RES, { schema_version: "pi-background-tasks.extension-response.v1", request_id: id, operation: "status", ok: true, result: { tasks: [task] } });
            return;
          }
        });
      }
    },
  };

  const statuses = [];
  const sent = [];
  const tools = {};
  const commands = {};
  const ctx = { cwd: "/repo", hasUI: true, ui: { notify: (m) => notices.push(m), setStatus: (key, text) => statuses.push({ key, text }) } };
  const pi = {
    events,
    on(event, handler) { handlers[event]?.push(handler); return () => {}; },
    registerCommand(name, opts) { commands[name] = { name, opts }; },
    registerTool(def) { tools[def.name] = def; },
    sendMessage(message, options) { sent.push({ message, options }); return Promise.resolve(); },
  };
  piBgHandoff(pi);

  const host = {
    handlers,
    commands,
    notices,
    launched,
    statuses,
    sent,
    tools,
    ctx,
    setManager(available) { managerAvailable = available; },
    async runCommand(args, name = "bg-handoff") { return commands[name].opts.handler(args, ctx); },
    async callTool(name, params) {
      return await tools[name].execute(`tool-${++callSeq}`, params, undefined, undefined, ctx);
    },
    taskStatus(id, status) {
      const task = launched.find((t) => t.id === id);
      if (task) task.status = status;
    },
    async callBash(command, extra = {}) {
      const input = { command, ...extra };
      const toolCallId = `call-${++callSeq}`;
      let blockResult;
      for (const h of handlers.tool_call) {
        const r = await h({ type: "tool_call", toolName: "bash", toolCallId, input }, ctx);
        if (r?.block) { blockResult = r; break; }
      }
      return { input, toolCallId, blockResult };
    },
    async deliverResult(toolCallId, input, { isError, text }) {
      let out;
      for (const h of handlers.tool_result) {
        const r = await h({ type: "tool_result", toolName: "bash", toolCallId, input, content: [{ type: "text", text }], isError, details: undefined }, ctx);
        if (r) out = r;
      }
      return out;
    },
    terminal(id) {
      events.emit(TERM, { schema_version: "pi-background-tasks.extension-terminal.v1", task: { id, status: "completed" } });
    },
    async startSession() {
      for (const h of handlers.session_start) await h({ type: "session_start", reason: "startup" }, ctx);
    },
    async startAgent() {
      const event = { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: {} };
      for (const h of handlers.before_agent_start) {
        const r = await h(event, ctx);
        if (r?.message) return r;
      }
      return undefined;
    },
    async discover() {
      for (const h of handlers.resources_discover) {
        const r = await h({ type: "resources_discover", cwd: "/repo", reason: "startup" }, ctx);
        if (r?.skillPaths) return r;
      }
      return undefined;
    },
  };
  return host;
}

function idFrom(text) { return text.match(/background task (task-[0-9]+)/)[1]; }
function show(label, value) { console.log(`\n### ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`); }
function assert(label, ok) { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); }

const host = makeHost();
const { handlers, commands, notices, ctx, statuses, sent, tools } = host;

// 1. fast command: no block, window injected, result untouched
const a = await host.callBash("echo hello");
assert("1 fast command gets the window", a.input.timeout === WINDOW && !a.blockResult);
assert("1 fast result untouched", (await host.deliverResult(a.toolCallId, a.input, { isError: false, text: "hello" })) === undefined);

// 2. exceeds window: killed by the Bash tool, then re-run as a background task
const b = await host.callBash("sleep 99 && echo done");
const bRes = await host.deliverResult(b.toolCallId, b.input, { isError: true, text: `partial progress line\n\n${TIMEOUT_TEXT}` });
assert("2 timeout -> background task", bRes?.content[0].text.includes("background task task-1") && bRes.content[0].text.includes("partial progress line"));
show("2 rewritten result", bRes?.content?.[0]?.text);

// 3. identical command again: pre-emptive handoff, no probe
host.terminal("task-1");
const c = await host.callBash("sleep 99 && echo done");
assert("3 learned pre-emptive handoff", c.blockResult?.reason.includes(`already exceeded the ${WINDOW}s window`));

// 4. pattern match: pre-emptive handoff
const d = await host.callBash("tail -f /dev/null");
assert("4 pattern pre-empt", d.blockResult?.reason.includes("matched"));

// 5. explicit model timeout shorter than the window is honored, and never handed off
const e = await host.callBash("curl -s https://example.com", { timeout: 5 });
assert("5 model timeout kept", e.input.timeout === 5);
assert("5 its timeout is not handed off", (await host.deliverResult(e.toolCallId, e.input, { isError: true, text: "Command timed out after 5 seconds" })) === undefined);

// 6. explicit model timeout on a PATTERN command outranks automatic routing
const f = await host.callBash("pytest -q", { timeout: 600 });
assert("6 explicit timeout outranks pattern routing", f.input.timeout === 600 && !f.blockResult);

// 7. legacy markers carry no semantics but are stripped so they cannot swallow the command
const g = await host.callBash("#bg python train.py");
assert("7 #bg stripped, no forced handoff", g.input.command === "python train.py" && g.input.timeout === WINDOW && !g.blockResult);
const h = await host.callBash("#foreground sleep 5");
assert("7 #foreground stripped, normal routing", h.input.command === "sleep 5" && h.input.timeout === WINDOW);
assert("7 marker notice shown once", notices.some((n) => n.includes("no longer markers")));

// 8. pattern match with the manager down -> falls through to the timeout window
host.setManager(false);
const i = await host.callBash("npm run dev");
assert("8 pattern + manager missing -> window", i.input.timeout === WINDOW && !i.blockResult);
host.setManager(true);

// 9. duplicate guard while running, released once the task is terminal
const j = await host.callBash("tail -f /dev/null");
assert("9 duplicate guard", j.blockResult?.reason.includes("already handed off"));
host.terminal(idFrom(j.blockResult.reason));
const k = await host.callBash("tail -f /dev/null");
assert("9 allowed again after terminal", k.blockResult?.reason.includes("Started background task"));

// 10. slash command: window change, learn off, mode off
await host.runCommand("timeout 5");
const l = await host.callBash("sleep 20");
assert("10 window now 5s", l.input.timeout === 5);
await host.runCommand("learn off");
const m = await host.callBash("sleep 99 && echo done");
assert("10 learn off -> probed again", m.input.timeout === 5 && !m.blockResult);
await host.runCommand("off");
const n = await host.callBash("echo untouched");
assert("10 mode off -> nothing injected", n.input.timeout === undefined && !n.blockResult);
await host.runCommand("auto");

// 11. guidance is injected for the model but hidden from the transcript
const guidance = await host.startAgent();
assert("11 guidance hidden from UI", guidance?.message?.display === false && typeof guidance.message.content === "string");

// 12. guidance is injected once per distinct content, not once per turn
assert("12 same content not re-injected", (await host.startAgent()) === undefined);
await host.runCommand("timeout 90");
const guidanceAfterChange = await host.startAgent();
assert("12 changed window re-injects once", typeof guidanceAfterChange?.message?.content === "string" && guidanceAfterChange.message.content.includes("90s timeout window"));
assert("12 still hidden", guidanceAfterChange?.message?.display === false);
await host.runCommand("off");
assert("12 mode off injects nothing", (await host.startAgent()) === undefined);
await host.runCommand("auto");
for (const h2 of handlers.session_compact) await h2({ type: "session_compact" }, ctx);
assert("12 re-injected after compaction", typeof (await host.startAgent())?.message?.content === "string");
await host.runCommand(`timeout ${WINDOW}`);

// 13. the shipped skill is contributed through resources_discover
const resources = await host.discover();
const skillDir = resources?.skillPaths?.[0];
assert("13 skill path contributed", typeof skillDir === "string");
assert("13 skill file exists", !!skillDir && existsSync(join(skillDir, "background-commands", "SKILL.md")));

// 14. ~/.pi/agent/pi-bg-handoff.json supplies the defaults
const dir = mkdtempSync(join(tmpdir(), "bg-handoff-cfg-"));
const writeConfig = (name, value) => {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  process.env.PI_BG_HANDOFF_CONFIG = path;
  return path;
};

writeConfig("good.json", {
  windowSeconds: 45,
  taskTimeoutSeconds: 900,
  mode: "patterns",
  policy: "silent",
  learn: false,
  guidance: false,
  extraPatterns: ["^make \\w+"],
});
const cfg = makeHost();
const fast = await cfg.callBash("echo hello");
assert("14 mode from config (patterns) -> no window", fast.input.timeout === undefined && !fast.blockResult);
const patternCmd = await cfg.callBash("make bundle");
assert("14 extraPatterns pre-empt", patternCmd.blockResult?.reason.includes("matched"));
assert("14 task-timeout from config", cfg.launched[0]?.timeoutSeconds === 900);
assert("14 policy silent -> no wake", cfg.launched[0]?.notifyOnCompletion === false && cfg.launched[0]?.triggerOnCompletion === false);
assert("14 guidance false -> none injected", (await cfg.startAgent()) === undefined);
await cfg.runCommand("auto");
const probed = await cfg.callBash("sleep 60");
assert("14 windowSeconds from config", probed.input.timeout === 45);
assert("14 no config problems", cfg.notices.every((n) => !n.includes("pi-bg-handoff:")));

// 15. an invalid config keeps working on defaults and reports what it ignored
writeConfig("bad.json", { mode: "always", windowSeconds: 0, guidance: "yes", extraPatterns: ["("], bogusField: 1 });
const bad = makeHost();
await bad.startSession();
const badFast = await bad.callBash("echo hello");
assert("15 invalid config -> defaults still applied", badFast.input.timeout === WINDOW);
assert("15 mode problem reported", bad.notices.some((n) => n.includes('mode must be "auto"')));
assert("15 windowSeconds problem reported", bad.notices.some((n) => n.includes("windowSeconds must be an integer")));
assert("15 unknown field reported", bad.notices.some((n) => n.includes('unknown field "bogusField"')));
assert("15 bad pattern reported", bad.notices.some((n) => n.includes("not a valid regular expression")));
await bad.runCommand("status");
assert("15 status names the config path", bad.notices.some((n) => n.includes("config=") && n.includes("bad.json")));

// 16. no config file at all is the normal case: no warnings
process.env.PI_BG_HANDOFF_CONFIG = join(dir, "does-not-exist.json");
const bare = makeHost();
await bare.startSession();
const bareFast = await bare.callBash("echo hello");
assert("16 missing config -> defaults, no warnings", bareFast.input.timeout === WINDOW && bare.notices.every((n) => !n.includes("pi-bg-handoff:")));

// 17. waiting is not this extension's job any more: it lives in the vendored pi-agent-wait fork
assert("17 no wait tools registered here", !tools.bg_wait && !tools.bg_wait_for_background);
assert("17 no /bg-wait command registered here", !commands["bg-wait"]);

// Asserted through the patch itself, so it holds whether or not the fork checkout is currently patched.
const waitPatch = readFileSync(join(projectRoot, "patches", "pi-agent-wait.patch"), "utf8");
assert(
  "17 wait patch renames the tools and adds /bg-wait",
  waitPatch.includes('+    name: "bg_wait",') &&
    waitPatch.includes('+    name: "bg_wait_for_task",') &&
    waitPatch.includes('pi.registerCommand("bg-wait", {') &&
    waitPatch.includes("const mode: WaitMode = params.mode as WaitMode;"),
);

show("notices", notices);
show("wait statuses", statuses);
show("wake messages", sent.map((s) => ({ customType: s.message.customType, deliverAs: s.options?.deliverAs, content: s.message.content })));
