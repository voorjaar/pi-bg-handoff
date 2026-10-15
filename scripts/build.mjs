#!/usr/bin/env node
/**
 * Combined build: the vendored pi-background-tasks fork plus this project's own extension, served
 * from one `dist/` folder.
 *
 * Order of work:
 *   1. Reset each fork checkout to pristine upstream and re-apply its patch under `patches/`.
 *      Upstream's own build config, tests, and docs are never edited; the forks are only ever patched.
 *   2. Build the pi-background-tasks fork with upstream's own `npm run build:runtime` (its own
 *      tsconfig.build.json), then trim what this package actually serves (source maps, and the
 *      anthropic-attribution extension when it is not declared).
 *   3. Copy the pi-agent-wait fork's TypeScript sources into `dist/agent-wait/` (upstream ships TS, and
 *      Pi loads it directly).
 *   4. Compile `src/index.ts` with the fork's own TypeScript so this project needs no toolchain of its
 *      own, and copy the fork's compiled tree into `dist/background-tasks/`.
 *
 * `package.json` -> `pi.extensions` then points at the built entries, so installing this package loads
 * the patched forks instead of the npm-published pi-background-tasks / pi-agent-wait.
 *
 * Run: node scripts/build.mjs [--no-patch]   (--no-patch builds the forks exactly as upstream has them)
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forkRoot = join(projectRoot, "fork", "pi-background-tasks");
const waitForkRoot = join(projectRoot, "fork", "pi-agent-wait");
const patchFile = join(projectRoot, "patches", "pi-background-tasks.patch");
const waitPatchFile = join(projectRoot, "patches", "pi-agent-wait.patch");
const dist = join(projectRoot, "dist");
const forkDist = join(dist, "background-tasks");
const waitDist = join(dist, "agent-wait");

const applyPatch = !process.argv.includes("--no-patch");

function run(command, args, cwd, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}\n${output || `exit ${result.status}`}`);
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result;
}

function git(args, cwd, options) {
  return run("git", args, cwd, options);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function step(message) {
  process.stdout.write(`\n== ${message}\n`);
}

if (!existsSync(join(forkRoot, ".git"))) {
  throw new Error(
    `Missing fork checkout at ${forkRoot}\n` +
      "Clone it first: git clone https://github.com/ismailsaleekh/pi-background-tasks fork/pi-background-tasks",
  );
}
if (!existsSync(join(waitForkRoot, ".git"))) {
  throw new Error(
    `Missing fork checkout at ${waitForkRoot}\n` +
      "Clone it first: git clone https://github.com/AledHe/pi-agent-wait fork/pi-agent-wait",
  );
}

step(`fork: reset src/ to pristine upstream${applyPatch ? " then apply patch" : " (patch skipped)"}`);
git(["checkout", "--", "src/"], forkRoot, { quiet: true });
if (applyPatch) {
  if (!existsSync(patchFile)) throw new Error(`Missing patch file ${patchFile}`);
  git(["apply", "--check", relative(forkRoot, patchFile)], forkRoot, { quiet: true });
  git(["apply", relative(forkRoot, patchFile)], forkRoot, { quiet: true });
  const stat = git(["diff", "--shortstat", "--", "src/"], forkRoot, { quiet: true }).stdout.trim();
  process.stdout.write(`patch applied: ${stat || "no changes"}\n`);
}

step(`fork pi-agent-wait: reset src/ + test-support/ to pristine upstream${applyPatch ? " then apply patch" : " (patch skipped)"}`);
git(["checkout", "--", "src/", "test-support/", "test/"], waitForkRoot, { quiet: true });
if (applyPatch) {
  if (!existsSync(waitPatchFile)) throw new Error(`Missing patch file ${waitPatchFile}`);
  git(["apply", "--check", relative(waitForkRoot, waitPatchFile)], waitForkRoot, { quiet: true });
  git(["apply", relative(waitForkRoot, waitPatchFile)], waitForkRoot, { quiet: true });
  const stat = git(["diff", "--shortstat", "--", "src/", "test-support/", "test/"], waitForkRoot, { quiet: true }).stdout.trim();
  process.stdout.write(`patch applied: ${stat || "no changes"}\n`);
}

if (!existsSync(join(forkRoot, "node_modules", "typescript"))) {
  step("fork: npm install");
  run("npm", ["install", "--no-audit", "--no-fund"], forkRoot);
}

step("fork: upstream build:runtime");
run("npm", ["run", "--silent", "build:runtime"], forkRoot);
for (const entry of ["extensions/background-tasks.js", "extensions/anthropic-attribution.js", "package.json"]) {
  if (!existsSync(join(forkRoot, "dist", entry))) throw new Error(`fork build did not emit dist/${entry}`);
}

step("this project: compile src/index.ts -> dist/index.js");
rmSync(dist, { recursive: true, force: true });
// Reuse whichever TypeScript is present: this project's own devDependency, otherwise the fork's.
const tscCandidates = [
  join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
  join(forkRoot, "node_modules", "typescript", "bin", "tsc"),
];
const tsc = tscCandidates.find((candidate) => existsSync(candidate));
if (!tsc) {
  throw new Error(
    "No TypeScript compiler found. Run `npm install` in this project, or `npm install` in fork/pi-background-tasks.",
  );
}
run(process.execPath, [tsc, "--project", join(projectRoot, "tsconfig.json")], projectRoot);
if (!existsSync(join(dist, "index.js"))) throw new Error("build did not emit dist/index.js");

step("assemble dist/background-tasks from the fork build");
cpSync(join(forkRoot, "dist"), forkDist, { recursive: true });

const manifest = readJson(join(projectRoot, "package.json"));
const declared = manifest?.pi?.extensions ?? [];

step("trim dist/background-tasks to what this package serves");
// Upstream's dist carries 2.6 MB of source maps that nothing at runtime loads, plus the delegate,
// fusion, attested, and anthropic-attribution subsystems that Pi only imports when the matching
// PI_BG_FEATURES token is enabled. The fork's default is `process` only (see
// patches/pi-background-tasks.patch), so this build drops exactly the subsystems it will never load.
const FEATURE_TOKENS = ["process", "delegate", "fusion", "attested", "attribution"];
// The files each feature owns. `*-child.js` is not import-reachable (it is spawned as a child process
// through a computed path), so an enabled feature seeds its own entrypoints into the keep set.
const FEATURE_MODULES = {
  delegate: [
    "src/delegate-extension.js",
    "src/delegate-child-extension.js",
    "extensions/delegate-child.js",
    "src/core/delegate/",
  ],
  fusion: [
    "src/fusion-extension.js",
    "src/fusion-child-extension.js",
    "extensions/fusion-child.js",
    "src/core/fusion/",
    "src/ui/fusion-model-selector.js",
  ],
  attested: ["src/core/attested-pi-run.js"],
  attribution: [
    "extensions/anthropic-attribution.js",
    "extensions/anthropic-attribution-child.js",
    "src/core/anthropic-attribution.js",
    "src/core/anthropic-attribution-path.js",
  ],
};

function selectedFeatures() {
  const flag = process.argv.find((arg) => arg.startsWith("--features="));
  const raw = flag ? flag.slice("--features=".length) : process.env.PI_BG_FEATURES;
  const tokens = (raw ?? "process").split(",");
  const unknown = tokens.filter((token) => !FEATURE_TOKENS.includes(token));
  if (unknown.length > 0) throw new Error(`unknown PI_BG_FEATURES token(s): ${unknown.join(", ")}`);
  if (!tokens.includes("process")) throw new Error("PI_BG_FEATURES must include the mandatory token process");
  return new Set(tokens);
}
const features = selectedFeatures();

function importSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const statik = [];
  const dynamic = [];
  for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)['"]/g)) statik.push(match[1]);
  for (const match of text.matchAll(/require\(["']([^"']+)['"]/g)) statik.push(match[1]);
  for (const match of text.matchAll(/\bimport\(\s*["']([^"']+)['"]\s*\)/g)) dynamic.push(match[1]);
  const resolveAll = (list) =>
    list
      .filter((spec) => spec.startsWith("."))
      .map((spec) => resolve(dirname(file), spec));
  return { statik: resolveAll(statik), dynamic: resolveAll(dynamic) };
}

function belongsToDisabledFeature(absPath) {
  const rel = relative(forkDist, absPath);
  for (const [feature, paths] of Object.entries(FEATURE_MODULES)) {
    if (features.has(feature)) continue;
    if (paths.some((owned) => rel === owned || rel.startsWith(owned))) return true;
  }
  return false;
}

const keep = new Set();
const queue = declared
  .map((entry) => String(entry))
  .filter((entry) => entry.includes("dist/background-tasks/"))
  .map((entry) => resolve(projectRoot, entry));
for (const feature of features) {
  for (const owned of FEATURE_MODULES[feature] ?? []) {
    const abs = join(forkDist, owned);
    if (owned.endsWith(".js") && existsSync(abs)) queue.push(abs);
  }
}
while (queue.length > 0) {
  const file = queue.pop();
  if (keep.has(file) || !existsSync(file)) continue;
  keep.add(file);
  const { statik, dynamic } = importSpecifiers(file);
  // Static imports always execute, so they are always kept. Dynamic imports are followed except into a
  // subsystem this build disabled: the compiled code reaches those only behind a feature check.
  queue.push(...statik);
  queue.push(...dynamic.filter((dep) => !belongsToDisabledFeature(dep)));
}

let removedBytes = 0;
const removed = [];
const compiled = [];
(function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else compiled.push(full);
  }
})(forkDist);
for (const full of compiled) {
  const rel = relative(forkDist, full);
  const drop =
    rel.endsWith(".map") ||
    (full.endsWith(".js") && !keep.has(full)) ||
    // A data file belongs to the module that reads it; keep the package.json version marker always.
    (rel.endsWith(".json") && rel !== "package.json" && !existsSync(full.replace(/\.json$/, ".js")));
  if (!drop) continue;
  removedBytes += statSync(full).size;
  removed.push(rel);
  rmSync(full);
}

// A kept module that statically imports a dropped file would fail at runtime, not at build time, so the
// closure is re-checked after trimming.
const broken = [];
for (const file of keep) {
  for (const dep of importSpecifiers(file).statik) {
    if (!existsSync(dep)) broken.push(`${relative(forkDist, file)} -> ${relative(forkDist, dep)}`);
  }
}
if (broken.length > 0) throw new Error(`trim broke static imports:\n  ${broken.join("\n  ")}`);

process.stdout.write(
  `features for this build: ${[...features].join(",")} (PI_BG_FEATURES or --features=...)\n` +
    `kept ${keep.size} module(s); removed ${removed.length} file(s), ${(removedBytes / 1024).toFixed(0)}KB ` +
    `(${removed.filter((rel) => rel.endsWith(".map")).length} source maps, ` +
    `${removed.filter((rel) => !rel.endsWith(".map")).length} from disabled subsystems)\n`,
);

step("assemble dist/agent-wait from the pi-agent-wait fork");
// Upstream ships TypeScript and declares `./index.ts` as its Pi entry, so the served tree is the
// patched source tree (tests and the offline type stubs are not shipped).
rmSync(waitDist, { recursive: true, force: true });
cpSync(join(waitForkRoot, "index.ts"), join(waitDist, "index.ts"));
cpSync(join(waitForkRoot, "src"), join(waitDist, "src"), { recursive: true });

const missing = declared
  .map((entry) => String(entry))
  .filter((entry) => !existsSync(join(projectRoot, entry)));
if (missing.length > 0) throw new Error(`pi.extensions entries missing from the build: ${missing.join(", ")}`);

process.stdout.write(
  `\nbuild complete.\n` +
    `  dist/index.js                         pi-bg-handoff (${manifest.version})\n` +
    `  dist/background-tasks/                patched pi-background-tasks ${readJson(join(forkDist, "package.json")).version}\n` +
    `  dist/agent-wait/                      patched pi-agent-wait ${readJson(join(waitForkRoot, "package.json")).version}\n` +
    `  served entries: ${declared.join(", ")}\n`,
);
