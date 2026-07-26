/**
 * Web Preview (ticket 07): the laptop reaching INTO the Box to view a page the
 * Sandbox User had Claude build. This is safe under both threats (ADR 0001) —
 * it grants the Mac's browser inbound access to a Box port and nothing more.
 *
 * Mechanism: the Box publishes a small set of common dev-server ports, each
 * bound to 127.0.0.1 so ONLY the Mac's localhost (its browser) can reach them —
 * never the LAN, and never in the Box→host direction. "Preview" then detects
 * which port is actually serving and opens it.
 */

/** Common dev-server ports we pre-publish so Preview works without reconfiguration. */
export const PREVIEW_PORTS: readonly number[] = [3000, 4321, 5173, 8000, 8080];

/**
 * The Box's web terminal (ttyd → tmux) listens here, published on loopback so the
 * Mac's browser can open a tmux session. Kept OUT of PREVIEW_PORTS: it is always
 * listening, so Preview must never mistake it for the user's dev server.
 */
export const TERMINAL_PORT = 7681;

/**
 * `docker run` publish args, each bound to loopback on the host. Binding to
 * 127.0.0.1 (not 0.0.0.0) keeps the forward scoped to the Mac's browser and
 * off the LAN.
 */
export function loopbackPublishArgs(ports: readonly number[] = PREVIEW_PORTS): string[] {
  const args: string[] = [];
  for (const port of ports) {
    args.push("-p", `127.0.0.1:${port}:${port}`);
  }
  return args;
}

/**
 * The Box-global `~/.claude/CLAUDE.md` Claude Code reads at session start
 * (written by `box/entrypoint.sh` on every start, ticket 09 — a per-Project
 * doc would otherwise get buried by an imported Project's own CLAUDE.md). It
 * exists because the published ports forward to the container's BRIDGE ip,
 * not its loopback: a dev server bound to 127.0.0.1 *inside* the Box is
 * unreachable from the Mac, and Preview opens a silent dead page. Ports come
 * from PREVIEW_PORTS so the doc cannot drift from what is actually published
 * — `entrypoint.sh` duplicates this text verbatim since a bash build context
 * cannot import it directly; this function is the source of truth and the
 * test below is what keeps the two from drifting apart.
 *
 * Deliberately has no production caller: `entrypoint.sh` writes the doc on every
 * Box start. This is the copy the drift test compares that script against, and
 * the only thing forcing it to carry the real `PREVIEW_PORTS`. Do not delete it
 * as dead code.
 */
export function previewDoc(): string {
  const ports = PREVIEW_PORTS.join(", ");
  return `# Preview in Claudebox

The user views web pages by clicking **Preview** in the Launcher, which opens
whatever is serving inside this Box in their computer's browser.

For that to work:

1. Serve on one of these published ports: ${ports}.
2. Bind the server to **0.0.0.0**, not to localhost. A server bound to
   localhost (127.0.0.1) inside this Box is NOT reachable from the Preview
   button — the page will look dead. The Launcher already keeps the port off
   the LAN.

Examples:

\`\`\`sh
python3 -m http.server 5173 --bind 0.0.0.0
npx vite --host 0.0.0.0 --port 5173
\`\`\`

Then tell the user to click **Preview**.
`;
}

export function previewUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Choose which port to open, given the ports currently listening inside the Box.
 * Prefer a well-known dev-server port (guaranteed published, so it will
 * resolve); otherwise fall back to the first listening port.
 */
export function detectServedPort(listeningPorts: readonly number[]): number | undefined {
  // The web terminal is always listening; it is never the page the user wants to preview.
  const candidates = listeningPorts.filter((p) => p !== TERMINAL_PORT);
  if (candidates.length === 0) return undefined;
  const known = candidates.find((p) => PREVIEW_PORTS.includes(p));
  return known ?? candidates[0];
}
