#!/usr/bin/env node
/**
 * Reset one fork checkout to pristine upstream and (optionally) re-apply its patch.
 *
 * `git checkout -- <paths>` only restores tracked files, so a patch that *creates* a file fails with
 * "already exists in working directory" on the next run. This helper deletes exactly the paths the
 * patch adds before applying it, which keeps `src/`, `test/`, and `test-support/` reproducible without
 * `git clean` (that would also drop the fork's own node_modules).
 *
 * CLI: node scripts/fork-reset.mjs <forkDir> <patchFile> [--check] [--no-apply] <pathSpec>...
 *   --check     git apply --check only (prove the patch fits, change nothing)
 *   --no-apply  reset to pristine upstream without applying the patch
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Vault-relative-ish paths a patch creates from nothing (`new file mode` blocks). */
export function pathsAddedByPatch(patchText) {
  const added = [];
  let current;
  let isNew = false;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current && isNew) added.push(current);
      current = undefined;
      isNew = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      isNew = true;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      const path = line.slice(6).trim();
      if (path && path !== "/dev/null") current = path;
    }
  }
  if (current && isNew) added.push(current);
  return added;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${output || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

/** Restore tracked paths, drop files the patch will create, then optionally apply the patch. */
export function resetFork({ forkRoot, patchPath, pathSpecs, apply = true, check = true }) {
  // git resolves a relative patch against the fork's own cwd, so both paths are absolutized here.
  const root = resolve(forkRoot);
  const patch = patchPath ? resolve(patchPath) : undefined;
  if (patch && !existsSync(patch)) throw new Error(`Missing patch file ${patch}`);
  git(["checkout", "--", ...pathSpecs], root);
  const added = patch ? pathsAddedByPatch(readFileSync(patch, "utf8")) : [];
  for (const path of added) rmSync(join(root, path), { force: true });
  if (!patch || !apply) return { removed: added };
  if (check) git(["apply", "--check", patch], root);
  git(["apply", patch], root);
  return { removed: added };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const noApply = args.includes("--no-apply");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (positional.length < 3) {
    process.stderr.write("usage: node scripts/fork-reset.mjs <forkDir> <patchFile> [--check|--no-apply] <pathSpec>...\n");
    process.exit(2);
  }
  const [forkRoot, patchPath, ...pathSpecs] = positional;
  const { removed } = resetFork({ forkRoot, patchPath, pathSpecs, apply: !noApply });
  const scope = noApply ? "reset to pristine upstream" : check ? "patch applies cleanly" : "patch applied";
  process.stdout.write(
    `${forkRoot}: ${scope}${removed.length > 0 ? ` (cleared patch-added files: ${removed.join(", ")})` : ""}\n`,
  );
}
