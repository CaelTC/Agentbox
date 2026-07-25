import { BOX_CONTAINER, ENGINE_CLI } from "../core/config";
import { detectServedPort, previewUrl } from "../core/preview";
import { run } from "./exec";

/**
 * Find whatever web server Claude started inside the Box and open it in the
 * Mac's browser (ticket 07). Listening ports are read from inside the Box; the
 * pure detectServedPort() picks which one to open.
 */
export async function detectPreviewUrl(): Promise<string | undefined> {
  // List TCP listening ports inside the Box. `ss -tlnH` prints one socket per
  // line; the 4th column is Local Address:Port.
  const res = await run(ENGINE_CLI, [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    "ss -tlnH 2>/dev/null || netstat -tlnp 2>/dev/null",
  ]);

  const ports = parseListeningPorts(res.stdout);
  const port = detectServedPort(ports);
  return port === undefined ? undefined : previewUrl(port);
}

/** Extract listening TCP port numbers from `ss`/`netstat` output. */
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const match = line.match(/[:.](\d{2,5})\s/);
    if (match?.[1]) {
      ports.add(Number(match[1]));
    }
  }
  return [...ports];
}
