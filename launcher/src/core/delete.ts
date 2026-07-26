/**
 * Delete Project. The mirror of `createProject`/`boxImportFolder`: a Project and
 * everything in it leaves the Workspace for good.
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
 * These are the pure decisions; the effects (killing the tmux session, the
 * `rm -rf` inside the Box) live in main/workspace.ts.
 */
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
