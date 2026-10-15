import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Fields this fork reads from the pi-bg-handoff config file. Owning the read here (instead of
 * being told by another extension) keeps registration independent of extension load order.
 */
export interface SharedHandoffConfig {
  wait?: boolean;
}

const CONFIG_FILE_NAME = "pi-bg-handoff.json";
const CONFIG_PATH_ENV = "PI_BG_HANDOFF_CONFIG";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function agentDirectory(): string {
  const configured = process.env[AGENT_DIR_ENV];
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  return join(homedir(), ".pi", "agent");
}

/** Read `<agentDir>/pi-bg-handoff.json`. A missing or broken file is the normal case: `{}`. */
export function readSharedHandoffConfig(): { path: string; config: SharedHandoffConfig } {
  const override = process.env[CONFIG_PATH_ENV];
  const path = typeof override === "string" && override.trim().length > 0 ? override.trim() : join(agentDirectory(), CONFIG_FILE_NAME);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, config: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { path, config: {} };

  const raw = parsed as Record<string, unknown>;
  const config: SharedHandoffConfig = {};
  if (typeof raw.wait === "boolean") config.wait = raw.wait;
  return { path, config };
}
