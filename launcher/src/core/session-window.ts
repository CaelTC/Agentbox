import { existsSync } from "node:fs";
import { BOX_CONTAINER } from "./config";
import { assertValidSlug } from "./projects";
import { TERMINAL_PORT } from "./preview";

/**
 * Opening a Project session (ticket 04). A session is launched through the ONE
 * Box-side funnel (`claudebox-session`, ticket 02) and viewed in a chromeless
 * Chrome app-mode window on the loopback-forwarded console port — so a
 * non-technical user can't edit the URL or lose the tab, and the session is
 * reachable only from the Mac's browser, never the LAN (ADR 0001).
 *
 * These are the pure argv/URL decisions; the effects (spawning `docker`/`open`,
 * the Chrome→default-browser fallback) live in main/session.ts.
 */

/** The console URL for a Project's live session. */
export function sessionUrl(slug: string, port: number = TERMINAL_PORT): string {
  return `http://localhost:${port}/sessions/${assertValidSlug(slug)}`;
}

/** `docker exec` argv that ensures the Project's session exists via the funnel. */
export function ensureSessionExecArgs(slug: string, container: string = BOX_CONTAINER): string[] {
  // No `-it`: off a TTY the funnel just ensures the session, it doesn't attach.
  // The slug is a distinct argv (never a shell string), so it can't inject.
  return ["exec", container, "claudebox-session", assertValidSlug(slug)];
}

/**
 * `docker exec` argv that kills a Project's tmux session.
 *
 * Delete needs this, and needs it FIRST. tmux is the source of truth for a
 * session and it outlives its directory: remove `/workspace/<slug>` under a live
 * session and the funnel's `tmux new-session -A -s <slug>` will happily re-attach
 * the next Project that sanitizes to the same slug to the dead one, cwd pointed
 * at an inode that no longer exists. Killing the session is what makes the slug
 * genuinely free again.
 *
 * Runs as the Box's ordinary user, not root: the tmux server belongs to the
 * sandbox user, and root would talk to a different (empty) socket.
 */
export function killSessionExecArgs(slug: string, container: string = BOX_CONTAINER): string[] {
  return ["exec", container, "tmux", "kill-session", "-t", assertValidSlug(slug)];
}

/**
 * Where Chrome installs on Windows, in probe order (issue #10). These three
 * cover every winget/installer default, so no registry parsing — and "is it on
 * disk" is knowable BEFORE launching, which is what lets the Windows fallback be
 * decided without waiting on the process.
 */
export function windowsChromePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]]
    .filter((root): root is string => Boolean(root))
    .map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`);
}

/** The command and argv that show a session in a Chrome app-mode window. */
export interface ChromeLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * How to open the session window on this platform: the Mac hands the URL to
 * `open`, Windows spawns the probed `chrome.exe` itself. `undefined` means no
 * Chrome was found, and the caller falls back to the default browser — the same
 * fallback the Mac already has.
 */
export function chromeAppLaunch(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): ChromeLaunch | undefined {
  if (platform !== "win32") {
    // `--app=` is what makes the window chromeless: no URL bar, no tabs.
    return { command: "open", args: ["-na", "Google Chrome", "--args", `--app=${url}`] };
  }
  const chrome = windowsChromePaths(env).find(exists);
  return chrome === undefined ? undefined : { command: chrome, args: [`--app=${url}`] };
}
