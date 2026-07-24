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

/** `open` argv for a chromeless Chrome app-mode window showing `url`. */
export function chromeAppOpenArgs(url: string): string[] {
  return ["-na", "Google Chrome", "--args", `--app=${url}`];
}
