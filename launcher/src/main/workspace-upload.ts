import { resolveUploadTargets, type UploadTarget } from "../core/upload";
import { boxExec, type BoxExec } from "./box-exec";
import { projectPath } from "./workspace-projects";

/** Upload: host files chosen one by one, copied into a Project (ticket 06). */
/**
 * Copy host files into a Project via `docker cp` — a one-way host→Box copy with
 * no live mount (ticket 06). Collision-free destinations come from the pure
 * resolver, using a Box-backed existence check.
 */
export async function boxUpload(
  sources: string[],
  slug: string,
  box: BoxExec = boxExec,
): Promise<UploadTarget[]> {
  const dir = projectPath(slug);

  // Pre-fetch existing names once so the resolver can dedupe synchronously.
  // Tolerant on purpose: this only feeds collision-avoidance, and an empty
  // listing is the right starting point either way — the copies below are what
  // actually has to succeed, and they say so.
  const existing = new Set<string>();
  const listing = await box.tryExec(["ls", "-1", dir]);
  for (const name of listing.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    existing.add(`${dir}/${name}`);
  }

  const targets = resolveUploadTargets(sources, dir, {
    exists: (p) => existing.has(p),
  });

  // Throws. Returning the targets from a `docker cp` whose exit code was never
  // read is what let the renderer report "Uploaded 3 file(s)" for files that
  // never crossed.
  for (const { source, dest } of targets) {
    await box.copyIn(source, dest);
  }
  return targets;
}
