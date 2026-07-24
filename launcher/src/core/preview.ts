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

export function previewUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Choose which port to open, given the ports currently listening inside the Box.
 * Prefer a well-known dev-server port (guaranteed published, so it will
 * resolve); otherwise fall back to the first listening port.
 */
export function detectServedPort(listeningPorts: readonly number[]): number | undefined {
  if (listeningPorts.length === 0) return undefined;
  const known = listeningPorts.find((p) => PREVIEW_PORTS.includes(p));
  return known ?? listeningPorts[0];
}
