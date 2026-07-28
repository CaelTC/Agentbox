import { WORKSPACE_DIR } from "../core/config";
import {
  assertDeletableProjectFilePath,
  assertDeletableProjectPath,
  confirmsProjectName,
  folderName,
  parseProjectUsage,
  planFileDelete,
  type DeleteListing,
  type DeleteResult,
  type FileDeleteResult,
} from "../core/delete";
import { killSessionArgs } from "../core/session-window";
import { boxExec, sh, type BoxExec } from "./box-exec";
import { boxExportDir, lastSavedAt } from "./workspace-export";
import {
  boxFindProject,
  boxListProjectFiles,
  boxPathExists,
  projectPath,
  readBoxMeta,
} from "./workspace-projects";

/**
 * The two permanent deletes — a whole Project, and files inside one — and the
 * sheet that stands in front of the first of them. Everything here is the last
 * thing between a click and work that does not come back.
 */
/**
 * How much of the Workspace one Project is holding. Unlike `boxListProjectFiles`
 * (which prunes dot-directories and `node_modules` because the Export picker
 * would drown in them), this counts EVERYTHING — the delete sheet is answering
 * "what am I about to lose", and an imported repo's `.git` is exactly the part a
 * Sandbox User would most regret.
 */
async function boxProjectUsage(
  slug: string,
  box: BoxExec = boxExec,
): Promise<{ fileCount: number; totalBytes: number } | undefined> {
  const dir = projectPath(slug);
  // Two lines: the file count, then the size in KiB. `du` reports allocated
  // blocks, which is the truer answer to what the Resource Cap is holding.
  //
  // Tolerant on purpose: `undefined` is a documented outcome here — the delete
  // sheet says "couldn't measure this" rather than the "0 files" that a failed
  // probe would otherwise read as.
  const res = await box.tryExec(
    sh('cd "$1" && { find . -mindepth 1 -type f | wc -l; du -sk . | cut -f1; }', dir),
  );
  if (res.code !== 0) return undefined;
  return parseProjectUsage(res.stdout);
}

/**
 * Everything the delete confirmation sheet says, from the four places that know
 * it: the Project's own name, what it is holding, where its Exports landed, and
 * when it was last saved out. Composed HERE and not in the router, because the
 * sheet is the last thing standing between a click and permanent loss — it has
 * to report the Exported copies that will SURVIVE as well as what will not, and
 * that promise is only assertable if it is one function.
 *
 * `usage` is spread rather than defaulted: absent means the probe failed, and
 * the sheet says "couldn't measure this" instead of "0 files" (core/delete.ts).
 */
export async function boxDeleteListing(
  slug: string,
  exportRoot: string,
  box: BoxExec = boxExec,
): Promise<DeleteListing> {
  const [{ project }, usage, exportDir] = await Promise.all([
    boxFindProject(slug, box),
    boxProjectUsage(slug, box),
    boxExportDir(slug, exportRoot, box),
  ]);
  const saved = lastSavedAt(exportDir);

  return {
    slug,
    name: project.name,
    ...usage,
    exportDir,
    ...(saved === undefined ? {} : { lastSaved: saved }),
  };
}

/**
 * Delete Project: remove a Project and everything in it from the Workspace,
 * permanently (core/delete.ts explains why there is no trash).
 *
 * `typed` is the name the Sandbox User typed into the sheet. It arrives from the
 * renderer, so it is input rather than truth: it is re-checked HERE against the
 * Project's real name inside the Box, exactly as `boxExport` re-enumerates the
 * Box before writing. A renderer bug — or a stale sheet naming a Project that
 * has since been renamed — must not be able to delete the wrong thing.
 *
 * Order matters. The tmux session dies FIRST — see `killSessionArgs` — and
 * only then does the directory go, so the slug is genuinely free afterwards.
 *
 * The `rm -rf` runs as root for the same reason the failed-import cleanup does:
 * `docker cp` synthesises parent directories as root, so a Project that arrived
 * through Import can contain directories the sandbox user cannot unlink. A
 * delete that half-works would leave exactly the metadata-less directory that
 * shows up in the Project list as an openable Project with nothing in it.
 */
export async function boxDeleteProject(
  slug: string,
  typed: string,
  box: BoxExec = boxExec,
): Promise<DeleteResult> {
  const dir = assertDeletableProjectPath(WORKSPACE_DIR, slug);

  const meta = await readBoxMeta(box, slug);
  if (!(await boxPathExists(box, dir))) {
    throw new Error(`No Project named '${slug}'.`);
  }

  const name = meta?.name ?? slug;
  if (!confirmsProjectName(typed ?? "", name)) {
    throw new Error(`That isn't the name of this project, so nothing was deleted.`);
  }

  // Tolerant on purpose: non-zero simply means there was no live session.
  // Deliberately NOT execAsRoot — the tmux server belongs to the sandbox user,
  // and root would talk to a different, empty socket.
  const killed = await box.tryExec(killSessionArgs(slug));

  await box.execAsRoot(["rm", "-rf", dir], `Deleting '${slug}'`);

  // Confirmed gone rather than assumed: `rm -rf` exits 0 on plenty of paths it
  // never touched, and the one thing this operation promises is that the Project
  // is not there any more.
  if (await boxPathExists(box, dir)) {
    throw new Error(`'${slug}' is still in the Workspace after deleting it.`);
  }

  return { slug, name, sessionKilled: killed.code === 0 };
}

/**
 * Delete files and folders INSIDE a Project, permanently (core/delete.ts says
 * why there is no trash here either).
 *
 * `pick` arrives from the renderer, so — like `boxExport`'s selection and
 * `boxDeleteProject`'s typed name — it is input rather than truth. It is checked
 * twice before anything is removed, and the two checks answer different
 * questions:
 *
 *   1. `planFileDelete` re-enumerates the Project INSIDE the Box and honours a
 *      path only if that fresh listing has it. The listing prunes dotfiles and
 *      `node_modules`, so `.git` and the Project's own marker are unreachable
 *      through it by construction rather than by a rule someone has to keep.
 *   2. `assertDeletableProjectFilePath` refuses anything that could leave the
 *      Project directory, on the string itself. Check 1 already makes a
 *      traversal unmatchable; this is the one that stands between a renderer
 *      that stops behaving and a root `rm -rf`, and it is deliberately not
 *      reasoning about what check 1 happens to allow today.
 *
 * `typed` is the folder gate. A folder takes everything under it, so it earns
 * the same type-the-name confirmation a whole Project does, re-checked HERE and
 * not merely in the sheet. It is not a security boundary — a renderer could tick
 * the folder's files individually and get the same bytes removed — it is what
 * makes one click on a folder an intention rather than a slip, and the trusted
 * layer keeps it so that a stale sheet cannot satisfy it either.
 *
 * Root, for the same reason `boxDeleteProject` is: `docker cp` synthesises
 * parent directories as root, so an imported Project holds directories the
 * sandbox user cannot unlink.
 *
 * Failure is REPORTED, not thrown. One `rm -rf` covers every target, and what
 * actually went is then read back from the Box rather than inferred from an exit
 * code — `rm -rf` exits 0 over plenty it never touched, and non-zero while
 * having removed most of what it was given. A delete that half-worked is a real
 * outcome and the screen has to be able to say which half.
 */
export async function boxDeleteFiles(
  slug: string,
  pick: readonly string[],
  typed?: string,
  box: BoxExec = boxExec,
): Promise<FileDeleteResult> {
  // Required, never defaulted: a caller that forgets the selection must delete
  // nothing. The same guard `boxExport` keeps, and here it guards an `rm -rf`.
  if (!Array.isArray(pick) || pick.length === 0) throw new Error("Nothing was chosen to delete.");

  const dir = projectPath(slug);
  const plan = planFileDelete(await boxListProjectFiles(slug, box), pick);

  const folders = plan.targets.filter((t) => t.folder);
  if (folders.length > 0) {
    // One at a time, so the name that was typed is unambiguously the one that
    // was checked. The Files tab only ever offers one folder anyway.
    if (plan.targets.length !== 1) {
      throw new Error("Delete a folder on its own, not alongside other files.");
    }
    if (!confirmsProjectName(typed ?? "", folderName(folders[0]!.path))) {
      throw new Error("That isn't the name of this folder, so nothing was deleted.");
    }
  }

  const failed = [...plan.refused];
  if (plan.targets.length === 0) return { deleted: [], fileCount: 0, totalBytes: 0, failed };

  const paths = plan.targets.map((t) => assertDeletableProjectFilePath(dir, t.path));

  let refusal: string | undefined;
  try {
    await box.execAsRoot(["rm", "-rf", ...paths], `Deleting files in '${slug}'`);
  } catch (err) {
    // Not the answer, just the best explanation available for whatever the
    // read-back below finds still sitting there.
    refusal = err instanceof Error ? err.message : String(err);
  }

  // What is GONE is read back rather than assumed — one exec for the whole set,
  // because the Box Gate is held for all of it and a per-target probe over a
  // 200-file selection is 200 round trips inside that hold. `if` rather than
  // `&&` so a last path that no longer exists doesn't fail the whole loop.
  const survivors = new Set(
    (
      await box.exec(
        sh('for p in "$@"; do if [ -e "$p" ]; then printf "%s\\n" "$p"; fi; done', ...paths),
        `Checking what was deleted from '${slug}'`,
      )
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const deleted: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  for (const [index, target] of plan.targets.entries()) {
    if (survivors.has(paths[index]!)) {
      failed.push({ path: target.path, reason: refusal ?? "The sandbox wouldn't remove it." });
      continue;
    }
    deleted.push(target.path);
    fileCount += target.fileCount;
    totalBytes += target.totalBytes;
  }

  return { deleted, fileCount, totalBytes, failed };
}
