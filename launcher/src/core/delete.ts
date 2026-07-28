/**
 * Delete Project, and delete files INSIDE a Project. The mirror of
 * `createProject`/`boxImportFolder`: a Project and everything in it — or a file
 * and a folder within one — leaves the Workspace for good.
 *
 * Deletion is PERMANENT and there is no trash. The Workspace is a named volume
 * with no host mount (ADR 0001), so nothing here is on the user's real disk and
 * nothing here is in a Finder trash they could fish it out of — the Box holds
 * the only copy. A `.trash/` folder inside the Box would keep charging the
 * Resource Cap for work the Sandbox User believes they threw away, which is the
 * ceiling that bounds threat A; so the honest answer is to remove it and to be
 * loud about that beforehand, which is what `confirmsProjectName` is for.
 *
 * Already-Exported files are NOT touched. Those live on the Sandbox User's own
 * computer, put there deliberately by them (ADR 0003) — the Launcher does not
 * reach back out and take them away.
 *
 * The same contract holds one level down. Deleting a file inside a Project is
 * permanent for exactly the same reasons, so it gets the same sentence on screen
 * and the same absence of an undo — what differs is only how much friction the
 * confirmation carries, which scales with what is going: a folder takes its
 * contents with it and so earns the type-the-name gate, a ticked file does not.
 *
 * The Launcher is the ONLY interface that can delete a file. The Box's own web
 * console stays read-only, deliberately: it runs without a password because
 * every route in it is a read, and the first write route would spend that.
 *
 * These are the pure decisions; the effects (killing the tmux session, the
 * `rm -rf` inside the Box) live in main/workspace.ts.
 */
import type { BoxFile } from "./export";
import { assertValidSlug } from "./projects";

/** What one Project is about to cost the Sandbox User, for the confirmation sheet. */
export interface DeleteListing {
  readonly slug: string;
  /** The friendly name — and the exact string the user has to type to confirm. */
  readonly name: string;
  /**
   * Absent when the size probe failed. Distinguishable from an empty Project on
   * purpose: the sheet must be able to say "couldn't measure this" rather than
   * show a confident "0 files" over a Project full of work.
   */
  readonly fileCount?: number;
  readonly totalBytes?: number;
  /** Where this Project's Exports landed, so the sheet can say they survive. */
  readonly exportDir: string;
  /** Epoch ms of the last Export, absent if this Project was never saved out. */
  readonly lastSaved?: number;
}

/** What one delete actually did. */
export interface DeleteResult {
  readonly slug: string;
  readonly name: string;
  /** True when the Project had a live tmux session that this delete killed. */
  readonly sessionKilled: boolean;
}

/**
 * The Box-side absolute path an `rm -rf` is about to be handed.
 *
 * Built by string concatenation and NOT by `node:path`: this is a POSIX path
 * inside the Box, and `resolve("/workspace", slug)` on a Windows host would
 * rewrite it to `C:\workspace\…` (the Launcher runs on both — ADR 0004).
 *
 * `assertValidSlug` already makes `..`, `/` and the empty string unrepresentable,
 * so the containment check below can never fire. It stays anyway: this is the one
 * string in Claudebox that becomes `rm -rf` as root, and a future caller that
 * loosens the slug rule should hit an exception here rather than the Workspace
 * root.
 */
export function assertDeletableProjectPath(workspaceDir: string, slug: string): string {
  const path = `${workspaceDir}/${assertValidSlug(slug)}`;
  if (!path.startsWith(`${workspaceDir}/`) || path.length <= workspaceDir.length + 1) {
    throw new Error(`Refusing to delete '${path}': not a Project inside ${workspaceDir}.`);
  }
  return path;
}

/**
 * The Box-side absolute path of ONE thing inside a Project that an `rm -rf` is
 * about to be handed. The file-level twin of `assertDeletableProjectPath`, and
 * the trust boundary of this feature: `relPath` is a string the renderer sent,
 * and the only thing standing between it and a root `rm -rf` is this function.
 *
 * String concatenation and not `node:path`, for the same reason as above: this
 * is a POSIX path inside the Box and the Launcher also runs on Windows.
 * `resolve()` there would rewrite it, and `normalize()` would *resolve* a `..`
 * instead of refusing it — which is the whole point. Nothing is resolved here;
 * anything that could traverse is rejected outright.
 *
 * Refused, in order: an empty path (that is the Project itself, which has its
 * own delete and its own confirmation), an absolute path, and any segment that
 * is empty, `.` or `..`. Dot-prefixed segments go too, which is what makes
 * `.git` and the Project's own `.claudebox/` marker undeletable — the same
 * prune the Box-side listing already applies, so nothing reachable is lost.
 */
export function assertDeletableProjectFilePath(projectDir: string, relPath: string): string {
  const refuse = (why: string): never => {
    throw new Error(`Refusing to delete '${relPath}': ${why}.`);
  };

  if (relPath === "" || relPath.startsWith("/")) refuse("not a file inside the Project");
  for (const segment of relPath.split("/")) {
    if (segment === "" || segment === "." || segment === "..") refuse("not a file inside the Project");
    if (segment.startsWith(".")) refuse("hidden files and folders can't be deleted from here");
  }

  const path = `${projectDir}/${relPath}`;
  // Belt and braces over the loop above, and the assertion a future edit to it
  // has to keep: whatever this returns is under the Project and is not the
  // Project. `..` cannot survive the loop, so this can never fire today.
  if (!path.startsWith(`${projectDir}/`) || path.length <= projectDir.length + 1) {
    refuse(`not inside ${projectDir}`);
  }
  return path;
}

/** The folder's own name — the string its confirmation asks to be typed. */
export function folderName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** One thing a delete is about to remove, sized from the Box's own listing. */
export interface FileDeleteTarget {
  /** Project-relative path, as the Box listed it. */
  readonly path: string;
  /** True when this is a folder, and so takes everything under it. */
  readonly folder: boolean;
  /** Files going with it — 1 for a file, the whole subtree for a folder. */
  readonly fileCount: number;
  readonly totalBytes: number;
}

/** What a delete will and won't do, before anything is removed. */
export interface FileDeletePlan {
  readonly targets: readonly FileDeleteTarget[];
  /** Picked paths the Box's own listing does not have, with the reason. */
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  readonly fileCount: number;
  readonly totalBytes: number;
}

/**
 * Work out what a picked set of paths actually removes, against the listing the
 * Box just produced.
 *
 * `pick` is the renderer's ticking, so it is input and not truth — exactly as
 * `planExport` treats its own. A path is honoured only if the Box just listed it
 * as a file, or if it is a folder holding at least one listed file. Everything
 * else is REFUSED and named: a file that vanished between the listing and the
 * click is the ordinary case here and the Sandbox User is told, rather than
 * having it quietly counted as deleted.
 *
 * That membership test is also what keeps `.git`, the Project's marker and
 * `node_modules` out of reach without a second rule: the listing prunes them,
 * so nothing under them can ever be matched (main/workspace.ts).
 */
export function planFileDelete(
  files: readonly BoxFile[],
  pick: readonly string[],
): FileDeletePlan {
  const targets: FileDeleteTarget[] = [];
  const refused: { path: string; reason: string }[] = [];

  for (const path of new Set(pick)) {
    const exact = files.find((f) => f.path === path);
    if (exact) {
      targets.push({ path, folder: false, fileCount: 1, totalBytes: exact.size });
      continue;
    }
    const under = files.filter((f) => f.path.startsWith(`${path}/`));
    if (under.length > 0) {
      targets.push({
        path,
        folder: true,
        fileCount: under.length,
        totalBytes: under.reduce((sum, f) => sum + f.size, 0),
      });
      continue;
    }
    refused.push({ path, reason: "It isn't in this project any more." });
  }

  return {
    targets,
    refused,
    fileCount: targets.reduce((sum, t) => sum + t.fileCount, 0),
    totalBytes: targets.reduce((sum, t) => sum + t.totalBytes, 0),
  };
}

/** What one file delete actually did. */
export interface FileDeleteResult {
  /** The paths that are demonstrably gone — confirmed, not assumed. */
  readonly deleted: readonly string[];
  /** Files under them, for the sentence the Sandbox User reads afterwards. */
  readonly fileCount: number;
  readonly totalBytes: number;
  /**
   * Everything that did NOT go, and why: a path the Box no longer lists, or one
   * the `rm` left behind (a read-only parent, a permission the sandbox user
   * lacks). Returned rather than thrown, because a partial delete is real and
   * the screen has to be able to say which half happened.
   */
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
}

/** Trimmed, lowercased, internal whitespace collapsed — see `confirmsProjectName`. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Does what the Sandbox User typed match the Project they're deleting?
 *
 * Typing the name is the friction that makes this an intention rather than a
 * misclick, so it is compared leniently — case and stray whitespace are not the
 * point, and failing someone who typed "My Website " instead of "My website"
 * would just teach them to distrust the box. An empty Project name can never be
 * confirmed by an empty field.
 *
 * Deleting a FOLDER inside a Project takes the same gate, against the folder's
 * own name (`folderName`). Deliberately the same function and not a second one:
 * one folder click can take 41 files with it, which is the case that earns the
 * friction — and a second name-matching rule would only be a chance to drift.
 */
export function confirmsProjectName(typed: string, name: string): boolean {
  const wanted = normalize(name);
  return wanted.length > 0 && normalize(typed) === wanted;
}

/**
 * Parse the two-line size probe (`find | wc -l`, then `du -sk`) run inside the
 * Box. `du` reports allocated blocks in KiB rather than apparent bytes, which is
 * the truer answer to "how much of the Resource Cap does this Project hold".
 *
 * Undefined on anything unexpected rather than a guessed zero: the sheet has to
 * be able to say "couldn't measure this" instead of showing a confident "0 files"
 * over a Project full of work.
 */
export function parseProjectUsage(
  stdout: string,
): { fileCount: number; totalBytes: number } | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return undefined;

  const fileCount = Number(lines[0]);
  const kib = Number(lines[1]);
  if (!Number.isInteger(fileCount) || fileCount < 0) return undefined;
  if (!Number.isInteger(kib) || kib < 0) return undefined;

  return { fileCount, totalBytes: kib * 1024 };
}
