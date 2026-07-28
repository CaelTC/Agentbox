import { homedir } from "node:os";
import { join } from "node:path";

/**
 * On-disk locations the Launcher uses on the host. The Box definition is the
 * public repo cloned by the Install Script / refreshed on launch (ADR 0002);
 * `box/` inside it is the Docker build context.
 */
export function agentboxHome(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
}

export function hostDefinitionDir(): string {
  return join(agentboxHome(), "definition");
}

export function hostBoxDefinitionDir(): string {
  return join(hostDefinitionDir(), "box");
}

/**
 * Where Exported Project documents land on the real MacBook (ticket 07). A
 * visible folder in the user's home, not inside `.agentbox` — the whole point
 * is that the Sandbox User can find their work in Finder.
 */
export function exportRoot(): string {
  return process.env.AGENTBOX_EXPORT_ROOT ?? join(homedir(), "Agentbox");
}

/**
 * The connected GitHub Account (ADR 0006). Inside `.agentbox` rather than the
 * visible export folder: the token in here is encrypted with the OS keystore and
 * is nothing the Sandbox User should be handling by hand.
 */
export function githubTokenPath(): string {
  return join(agentboxHome(), "github.json");
}
