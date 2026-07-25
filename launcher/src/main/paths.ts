import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On-disk locations the Launcher uses on the host. The Box definition is the
 * public repo cloned by the Install Script / refreshed on launch (ADR 0002);
 * `box/` inside it is the Docker build context.
 */
export function claudeboxHome(): string {
  return process.env.CLAUDEBOX_HOME ?? join(homedir(), ".claudebox");
}

export function hostDefinitionDir(): string {
  return join(claudeboxHome(), "definition");
}

export function hostBoxDefinitionDir(): string {
  return join(hostDefinitionDir(), "box");
}

/**
 * Where Exported Project documents land on the real MacBook (ticket 07). A
 * visible folder in the user's home, not inside `.claudebox` — the whole point
 * is that the Sandbox User can find their work in Finder.
 */
export function exportRoot(): string {
  return process.env.CLAUDEBOX_EXPORT_ROOT ?? join(homedir(), "Claudebox");
}
