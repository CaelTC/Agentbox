import type { BrowserWindowConstructorOptions } from "electron";
import { BOX_CONTAINER } from "./config";
import { assertValidSlug } from "./projects";
import { TERMINAL_PORT } from "./preview";

/**
 * Opening a Project session (ticket 04). A session is launched through the ONE
 * Box-side funnel (`claudebox-session`, ticket 02) and viewed in a window the
 * Launcher itself owns, on the loopback-forwarded console port — so a
 * non-technical user can't edit the URL or lose the tab, and the session is
 * reachable only from this computer, never the LAN (ADR 0001).
 *
 * Owning the window (rather than handing the URL to Chrome) is what makes "is it
 * already open?" answerable: every Chrome app window looked identical and
 * answered to no one, so a second Open session simply stacked another copy of
 * the same tmux session on top of the first.
 *
 * These are the pure URL/argv/option decisions; the effects (spawning `docker`,
 * creating the window, keeping the per-Project registry) live in main/session.ts.
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
 * Is this URL the Box's own console? The session window renders a page served
 * from INSIDE the Box, so where that page may navigate the window is a boundary
 * decision, not a cosmetic one: the console's own pages (Files, the other
 * sessions on the rail) are all it gets. Compared as a parsed origin, so a
 * lookalike host like `http://localhost:7681.example.com/` can't pass as a
 * prefix of ours.
 */
export function isConsoleUrl(url: string, port: number = TERMINAL_PORT): boolean {
  try {
    return new URL(url).origin === `http://localhost:${port}`;
  } catch {
    return false; // not a URL at all — certainly not the console
  }
}

/**
 * The session window itself. Chromeless in the sense that matters — no URL bar,
 * no tabs — while keeping the native frame, because the frame's close button is
 * how a Sandbox User puts the session away.
 *
 * The web preferences are the boundary, not decoration: this page comes from the
 * Box, so it loads with no preload (the IPC bridge belongs to the home window
 * alone), no Node, and a sandboxed renderer. The Box gets a plain web page and
 * nothing else.
 */
export function sessionWindowOptions(slug: string): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 760,
    // Replaced by the page's own <title> ("<slug> · Claudebox") once it loads;
    // this is what the window is called for the moment before that.
    title: `${assertValidSlug(slug)} · Claudebox`,
    // The console's own background (Coastal Water), so opening doesn't flash white.
    backgroundColor: "#073D44",
    autoHideMenuBar: true, // no menu bar to wander into on Windows
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  };
}
