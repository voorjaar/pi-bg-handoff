#!/usr/bin/env node
/**
 * Re-export each fork's patch from its working tree.
 *
 * Two traps this guards, both of which silently produced a wrong patch file:
 *  - `git apply --3way` stages its result. A plain `git diff` shows only unstaged changes, so a
 *    regeneration after a 3-way rebase dropped a third of the files (26 of 61). Everything under the
 *    pathspec is staged here and the diff is taken against the index, so the patch is the whole delta.
 *  - A failed build resets a fork to pristine upstream and never re-applies its patch. Diffing that
 *    tree yields an empty patch, which reads as "no local changes" but erases the file. An empty
 *    result is only accepted when the previous patch was already empty.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGETS = [
  {
    fork: "fork/pi-background-tasks",
    patch: "patches/pi-background-tasks.patch",
    specs: ["src/", "tests/", "scripts/docs/", "docs/", "README.md"],
  },
  {
    fork: "fork/pi-agent-wait",
    patch: "patches/pi-agent-wait.patch",
    specs: ["src/", "test-support/", "test/"],
  },
];

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${output || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function countFiles(diff) {
  return diff.split("\n").filter((line) => line.startsWith("diff --git ")).length;
}

let failed = false;
for (const target of TARGETS) {
  const forkRoot = resolve(target.fork);
  const patchPath = resolve(target.patch);
  if (!existsSync(forkRoot)) {
    console.error(`${target.fork}: checkout missing; run npm run fork:clone`);
    failed = true;
    continue;
  }
  let diff;
  try {
    git(["add", "-A", "--", ...target.specs], forkRoot);
    diff = git(["diff", "--cached", "--", ...target.specs], forkRoot);
  } catch (error) {
    console.error(String(error.message ?? error));
    failed = true;
    continue;
  }
  const previous = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  if (diff.trim().length === 0 && previous.trim().length > 0) {
    console.error(
      `${target.fork}: refusing to replace a ${countFiles(previous)}-file patch with an empty diff. ` +
        "That checkout is pristine upstream — a failed build resets forks without re-applying. " +
        "Run npm run fork:patch first, then regenerate.",
    );
    failed = true;
    continue;
  }
  writeFileSync(patchPath, diff.endsWith("\n") || diff.length === 0 ? diff : `${diff}\n`);
  console.error(
    `${target.fork}: wrote ${target.patch} (${countFiles(diff)} files, ${diff.split("\n").length} lines)`,
  );
}

process.exit(failed ? 1 : 0);
