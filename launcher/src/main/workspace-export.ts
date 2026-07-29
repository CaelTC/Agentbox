import { chmodSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SAVED_STAMP,
  planExport,
  resolveExportDir,
  resolveExportTarget,
  untrustedMark,
  type ExportListing,
  type ExportResult,
} from "../core/export";
import type { Project } from "../core/projects";
import { boxExec, type BoxExec } from "./box-exec";
import { run } from "./exec";
import { boxFindProject, boxListProjectFiles, projectPath } from "./workspace-projects";

/**
 * Export: carrying a copy of a Project's documents out of the Box and onto the
 * Sandbox User's own disk, and the record of when that last happened — the stamp
 * the home screen, the delete sheet and "Show saved files" all read.
 */
/**
 * When an Export last landed in this folder — the stamp `boxExport` writes, never
 * the folder's own mtime (core/export.ts says why). Absent is the honest answer
 * for a folder nothing has been saved into: on the delete sheet it is the
 * difference between "your copies stay where they are" and "once it's deleted,
 * it's gone", and that sentence has to be true rather than reassuring.
 *
 * A landing folder written before the stamp existed gets one backfill, so that
 * sentence stays true for Exports an earlier build made: a folder holding a
 * non-dotfile demonstrably received an Export, and the folder's mtime is the only
 * record left of when. It is consulted ONCE and then frozen into the stamp — the
 * Finder drift the stamp exists to remove cannot creep back in afterwards. The
 * dotfile exclusion is what keeps the promise honest: no dotfile is exportable
 * (core/export.ts), so a folder holding only a `.DS_Store` is one Finder opened
 * and nothing ever saved into.
 *
 * Writing that stamp is best-effort, the ANSWER is not: an Export has already
 * been proven to have landed by the time the write is attempted, so a landing
 * folder the host will not let us write into still reports when it was saved —
 * it just pays for the walk again next time. A stamp that was created but could
 * not be dated is LEFT, reading `now`: creating it already bumped the folder's
 * own mtime, so removing it would send every later call back through the
 * backfill against that bumped value — one frozen wrong date instead of a date
 * that says "just now" forever.
 *
 * Every failure to READ here is `undefined`. This is decoration on the home
 * screen and a softer sentence on the delete sheet; a landing folder the host
 * will not let us read must not take either screen down with it.
 */
export function lastSavedAt(exportDir: string): number | undefined {
  const stamp = join(exportDir, SAVED_STAMP);
  try {
    const stamped = statSync(stamp, { throwIfNoEntry: false });
    if (stamped) return stamped.mtimeMs;

    const folder = statSync(exportDir, { throwIfNoEntry: false });
    if (!folder || !holdsAnExportedFile(exportDir)) return undefined;

    try {
      writeFileSync(stamp, `${new Date(folder.mtimeMs).toISOString()}\n`);
      utimesSync(stamp, folder.atime, folder.mtime);
    } catch {
      // The record is best-effort; the answer below was read before any write.
    }
    return folder.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Is there anything in this landing folder that only an Export could have put
 * there? `boxExport` keeps the Project's own directory structure, so a Project
 * whose files all lived under `docs/` lands as directories with the files a level
 * down — the evidence is at any depth, not just the top. Stops at the FIRST one:
 * this is a yes/no question asked inside the Box Gate, not an inventory.
 *
 * A directory the host will not let us read is "no evidence HERE", not "no
 * evidence": one unreadable subfolder must not bury a real Export sitting beside
 * it, or the delete sheet goes back to "once it's deleted, it's gone" over copies
 * that are on disk — the sentence this whole backfill exists to keep true.
 */
function holdsAnExportedFile(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // no dotfile is exportable
    if (entry.isFile()) return true;
    if (entry.isDirectory() && holdsAnExportedFile(join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * The classified file list the Launcher renders as checkboxes (ticket 08).
 * Non-exportable files are returned WITH their reason rather than filtered out,
 * so a user whose script does not come out sees why before they commit.
 */
export async function boxExportListing(
  slug: string,
  exportRoot: string,
  box: BoxExec = boxExec,
): Promise<ExportListing> {
  const [dir, files] = await Promise.all([
    boxExportDir(slug, exportRoot, box),
    boxListProjectFiles(slug, box),
  ]);
  const plan = planExport(files);
  return { files: plan.candidates, dir, capBytes: plan.capBytes };
}

/**
 * Where this Project's documents land on the host. The friendly name is read
 * from metadata INSIDE the Box, so Claude can write it — it is untrusted input
 * on the way to a host filesystem path, and resolveExportDir sanitizes it and
 * asserts containment before it is used.
 */
export async function boxExportDir(
  slug: string,
  exportRoot: string,
  box: BoxExec = boxExec,
): Promise<string> {
  const { project, projects } = await boxFindProject(slug, box);
  return resolveExportDir(exportRoot, project, projects);
}

/**
 * When each Project was last saved onto this computer, read from the Export
 * stamp. Purely host-side: no Box call, no new IPC channel, and the home screen
 * gets one true thing to say about every Project at once.
 *
 * Never saved is the ORDINARY case and is not an exception: `lastSavedAt` reports
 * it as `undefined`, so the common path no longer throws once per Project per
 * render, and neither can an unreadable landing folder. The try/catch that
 * remains is for the one call that genuinely throws — a friendly name that
 * `resolveExportDir` refuses —
 * because this is decoration, not an answer. The home screen already fails loudly
 * when the Box can't be read; it must not fail at all over a timestamp.
 */
export function withLastSaved(projects: readonly Project[], exportRoot: string): Project[] {
  return projects.map((project) => {
    let lastSaved: number | undefined;
    try {
      lastSaved = lastSavedAt(resolveExportDir(exportRoot, project, projects));
    } catch {
      return project; // that row loses its subtitle, and nothing else changes
    }
    return lastSaved === undefined ? project : { ...project, lastSaved };
  });
}

/**
 * Export (ticket 07/08): copy a Project's documents out of the Box onto the host
 * via `docker cp`. This is the first Box→host path in the system — it is a copy
 * performed by trusted host code, NOT a mount, so ADR 0001's "no host mounts"
 * invariant is untouched (ADR 0003).
 *
 * `pick` is the Sandbox User's ticked selection. It arrives from the renderer, so
 * it is re-validated here against the Box's own listing and the allowlist before
 * a single byte is copied, exactly as Project slugs are re-validated before they
 * reach a Box-side shell.
 */
export async function boxExport(
  slug: string,
  exportRoot: string,
  pick: readonly string[],
  box: BoxExec = boxExec,
): Promise<ExportResult> {
  // Required, never defaulted: a caller that forgets the selection must export
  // nothing, not everything. Ticket 08 made the picker the only way in.
  if (!Array.isArray(pick)) throw new Error("Nothing was chosen to save.");

  const dir = await boxExportDir(slug, exportRoot, box);
  const plan = planExport(await boxListProjectFiles(slug, box), pick);

  const result: ExportResult = {
    dir,
    saved: plan.selected.length,
    skipped: plan.skipped,
    totalBytes: plan.totalBytes,
    capBytes: plan.capBytes,
    overCap: plan.overCap,
    unmarked: 0,
  };

  // Over the cap nothing at all is written — an unbounded copy onto the user's
  // real disk is threat A.
  if (plan.overCap) return { ...result, saved: 0 };

  mkdirSync(dir, { recursive: true });
  let unmarked = 0;
  let landed = 0;
  try {
    for (const file of plan.selected) {
      const target = resolveExportTarget(dir, file.path);
      mkdirSync(dirname(target), { recursive: true }); // keep the Project's structure
      // Throws: `saved: N` is a promise about files that are actually on the disk.
      await box.copyOut(`${projectPath(slug)}/${file.path}`, target);
      // Nothing lands executable, whatever the Box said. Kept because it is still
      // correct on macOS and costs nothing — but it is a no-op for executability
      // on Windows, which is why the untrusted mark below exists (#12).
      chmodSync(target, 0o644);
      landed += 1;
      if (!(await markExportedUntrusted(target))) unmarked += 1;
    }
  } finally {
    // Stamped even when a copy failed part-way, because "last saved" is what
    // Show saved files, the delete sheet and every home screen row report, and
    // files that landed before the failure are on the Sandbox User's disk
    // whatever this call did next.
    //
    // A file of its own rather than the folder's mtime: writing into a folder is
    // not the only thing that moves that mtime — Finder does it by opening the
    // folder — and this is the only write that means an Export happened. The
    // mtime of the stamp is the record; the line inside it is for whoever finds
    // the file and wonders.
    //
    // The record can fail; the Export cannot fail with it. Files that landed are
    // on the Sandbox User's disk, and a `finally` that throws would replace both
    // `saved: N` and whatever real error the copy loop was already raising.
    if (landed > 0) {
      try {
        writeFileSync(join(dir, SAVED_STAMP), `${new Date().toISOString()}\n`);
      } catch {
        // What survives depends on whether this Project had ever been saved
        // before: a MISSING stamp is backfilled from the folder next time, but an
        // EXISTING one keeps the earlier Export's date, because `lastSavedAt`
        // returns on the stamp it finds and never reaches the backfill. So a
        // second Export whose stamp write fails reports the first one's date
        // until a later Export writes the stamp successfully.
      }
    }
  }
  return { ...result, unmarked };
}

/**
 * Apply this host's untrusted mark to one file that has just landed (#12) —
 * `Zone.Identifier` on Windows, `com.apple.quarantine` on macOS. The DECISION of
 * which mark, and its exact bytes, is the pure `untrustedMark`; only the write
 * and the spawn are here. `platform` and the two effects are injected the way
 * `spawnPath(path, exists)` injects its probe, so both branches are assertable
 * from either host.
 *
 * Returns false rather than throwing: a failed mark is no reason to delete a
 * Sandbox User's saved work. It is not swallowed either — `boxExport` counts
 * every false into `ExportResult.unmarked`, which the renderer surfaces.
 */
export async function markExportedUntrusted(
  target: string,
  platform: NodeJS.Platform = process.platform,
  write: (path: string, data: string) => void = writeFileSync,
  exec: (command: string, args: readonly string[]) => Promise<{ code: number }> = run,
): Promise<boolean> {
  const mark = untrustedMark(target, platform, Date.now());
  if (!mark) return false;
  try {
    if (mark.kind === "stream") {
      write(mark.path, mark.content);
      return true;
    }
    return (await exec(mark.command, mark.args)).code === 0;
  } catch {
    return false;
  }
}
