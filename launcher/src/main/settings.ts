import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_HARNESS, isHarness, type Harness } from "../core/config";
import { settingsPath } from "./paths";

/**
 * The Launcher's app-level settings — one so far: the Harness, which coding
 * agent a Project session opens with (core/config.ts). App-level and not
 * per-Project metadata, so the answer to "which agent am I working with" is one
 * choice in one place rather than a field on every tile.
 *
 * A small JSON file beside the GitHub Account (main/paths.ts) rather than a
 * store with a lifecycle: it is read on a home render and on an open, and
 * written when the Sandbox User picks — so the file IS the state, and there is
 * no cache anyone has to remember to invalidate.
 *
 * Reading never throws. A missing file is the untouched default, and so is a
 * truncated or hand-edited one: a picker is not worth a Launcher that won't
 * start, and an agent name the Box doesn't know is refused loudly at the funnel
 * anyway (box/bin/agentbox-session).
 */
export function harness(): Harness {
  const stored = readSettings().harness;
  return isHarness(stored) ? stored : DEFAULT_HARNESS;
}

/**
 * Persist the Sandbox User's choice. Validated here rather than trusted from the
 * IPC bridge — this value is written into a Project's metadata and then read by
 * the Box, so an unknown name would become a session that refuses to open.
 */
export function setHarness(choice: Harness): void {
  if (!isHarness(choice)) throw new Error(`Unknown harness: '${String(choice)}'.`);
  // Merged, not replaced: the next setting to live in here must not be erased by
  // someone changing this one.
  const settings = { ...readSettings(), harness: choice };
  mkdirSync(dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function readSettings(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {}; // not there, not readable, not JSON — all of them mean "the defaults"
  }
}
