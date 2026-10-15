#!/usr/bin/env node
/**
 * Verify that every patch under `patches/` still applies to its pinned pristine upstream commit.
 *
 * The forks under `fork/` are the development checkout; the patches are what makes the fork
 * reproducible: a reviewer can clone upstream, apply the patch, and get the same source. This
 * script clones each pinned commit into a scratch directory and runs `git apply --check`
 * (network required).
 *
 *   node scripts/verify-patches.mjs            # clone + check every patch
 *   node scripts/verify-patches.mjs --offline  # check each patch reverses cleanly inside its fork
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    name: "pi-background-tasks",
    url: "https://github.com/ismailsaleekh/pi-background-tasks",
    commit: "799182ff65d7040732aea23b2001ea860b688531",
    patch: "patches/pi-background-tasks.patch",
    fork: "fork/pi-background-tasks",
  },
  {
    name: "pi-agent-wait",
    url: "https://github.com/AledHe/pi-agent-wait",
    commit: "4d5d65c59e929e76e35f2994000d00e5d54415be",
    patch: "patches/pi-agent-wait.patch",
    fork: "fork/pi-agent-wait",
  },
];

const offline = process.argv.includes("--offline");
const scratch = offline ? null : mkdtempSync(join(tmpdir(), "pi-bg-handoff-patches-"));
let failed = false;

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  for (const target of TARGETS) {
    if (offline) {
      // Reversing the patch inside the fork proves the patch matches the fork exactly; the fork's
      // own HEAD is the pinned upstream commit, so this is the offline equivalent of the clone check.
      const head = run("git", ["rev-parse", "HEAD"], target.fork).trim();
      if (head !== target.commit) {
        console.error(`${target.name}: fork HEAD ${head} != pinned ${target.commit}`);
        failed = true;
        continue;
      }
      try {
        run("git", ["apply", "--reverse", "--check", join(projectRoot, target.patch)], target.fork);
        console.log(`${target.name}: patch reverses cleanly against ${target.fork} @ ${target.commit.slice(0, 8)}`);
      } catch (error) {
        failed = true;
        console.error(`${target.name}: patch does not reverse cleanly\n${String(error.stderr ?? error.message)}`);
      }
      continue;
    }

    const checkout = join(scratch, target.name);
    try {
      run("git", ["clone", "--quiet", target.url, checkout], scratch);
      run("git", ["checkout", "--quiet", target.commit], checkout);
      run("git", ["apply", "--check", join(projectRoot, target.patch)], checkout);
      console.log(`${target.name}: patch applies to ${target.commit.slice(0, 8)}`);
    } catch (error) {
      failed = true;
      console.error(`${target.name}: patch does not apply to ${target.commit.slice(0, 8)}\n${String(error.stderr ?? error.message)}`);
    }
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
