import { sanitizeProjectName } from "./projects";

/**
 * Project Import (ticket 09): a folder on the user's computer *becomes* a Project — the
 * opposite direction and shape from Export. Export carries documents out under
 * an allowlist; Import carries a whole project in, unfiltered, because a repo
 * the user chose to bring in is the thing they came here to work on. This
 * module holds every DECISION (what crosses, what it's named, whether it fits);
 * the git/tar/docker calls live in the effects layer (`main/workspace.ts`).
 *
 * Threat model (see the ADR): `.git` carries every secret ever committed and
 * later removed, plus full private history — accepted deliberately, because a
 * user technical enough to have a repo is technical enough to own that call.
 * The confirmation sheet this module feeds is informed consent, not protection.
 */

/**
 * Parse `git ls-files -z`'s NUL-separated output into individual paths. The
 * trailing NUL after the last entry (and an empty stdout) would otherwise
 * produce a spurious empty path.
 */
export function parseGitLsFiles(stdout: string): string[] {
  return stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * A path is safe to hand to `tar` only if it stays inside the folder being
 * imported — no absolute path, no `..` segment, matching the defence-in-depth
 * already in `core/export.ts` and `core/upload.ts`.
 */
export function isRepoRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) return false;
  return !path.split("/").some((s) => s === "" || s === "." || s === "..");
}

/** Throws naming the first unsafe path, so a crafted `git ls-files` line never reaches `tar`. */
export function assertRepoRelativePaths(paths: readonly string[]): readonly string[] {
  for (const path of paths) {
    if (!isRepoRelativePath(path)) {
      throw new Error(`Refusing to import '${path}': not inside the folder being imported.`);
    }
  }
  return paths;
}

/**
 * The `tar` argv for the import stream. Lives here, not in the effects layer,
 * because it shipped once without `-c` — tar then wrote zero bytes, `docker cp`
 * took the empty stream and exited 0, and every import silently copied nothing.
 * Argv that decides what crosses is a decision, so it is testable like one.
 *
 * `.git` rides along as an extra positional path: it always crosses, history
 * included, and `git ls-files` never lists it.
 */
export function importTarArgs(folder: string, isGitRepo: boolean): readonly string[] {
  return ["-c", "-C", folder, "--null", "-T", "-", ...(isGitRepo ? [".git"] : [])];
}

/** The NUL-separated, NUL-terminated list `tar --null -T -` reads from stdin. */
export function importTarInput(paths: readonly string[]): string {
  return paths.length > 0 ? `${paths.join("\0")}\0` : "";
}

export interface ImportIdentity {
  readonly name: string;
  readonly slug: string;
}

/**
 * Folder names `sanitizeProjectName` reduces to nothing — symbols-only, or a
 * script with no ASCII letters/digits (a CJK name, say) — fall back to this
 * rather than throwing. Throwing would be a dead end: a Sandbox User can't
 * rename the folder they just picked from inside this dialog.
 */
const FALLBACK_SLUG = "project";

/**
 * Turn the imported folder's name into a Project identity. A slug clash
 * auto-suffixes `-2`, `-3`, … — matching `resolveUploadTargets` — rather than
 * `createProject`'s throw, which is likewise a dead end here: the folder name
 * isn't something the Sandbox User typed and can just change.
 */
export function deriveImportIdentity(
  folderName: string,
  existingSlugs: readonly string[],
): ImportIdentity {
  const trimmed = folderName.trim();

  let base: string;
  try {
    base = sanitizeProjectName(trimmed);
  } catch {
    base = FALLBACK_SLUG;
  }

  const taken = new Set(existingSlugs);
  let slug = base;
  let n = 1;
  while (taken.has(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }

  return { name: trimmed.length > 0 ? trimmed : slug, slug };
}

/** One file that will cross, as stat'd on the host. */
export interface ImportFile {
  readonly path: string;
  readonly size: number;
}

/**
 * Above this, the confirmation sheet states the real number rather than
 * staying quiet — the user decides whether it's worth it. Unlike
 * `EXPORT_CAP_BYTES` this is not a ceiling: an Import is never refused for
 * being merely big, only for not fitting the Box's free space.
 */
export const IMPORT_SIZE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

export interface ImportPlan {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly warnBytes: number;
  readonly overWarnThreshold: boolean;
  readonly freeBytes: number;
  /** False means the Import must be refused before anything is copied. */
  readonly fitsFreeSpace: boolean;
}

/**
 * Sum the stat'd list against the size-warning threshold and the Box's free
 * space, exact rather than estimated — symmetric with `planExport`'s
 * `totalBytes`. Refusing here is what turns "there isn't room" into a sentence
 * instead of `docker cp` dying mid-stream and leaving a half-copied Project.
 */
export function planImport(files: readonly ImportFile[], freeBytes: number): ImportPlan {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return {
    fileCount: files.length,
    totalBytes,
    warnBytes: IMPORT_SIZE_WARNING_BYTES,
    overWarnThreshold: totalBytes > IMPORT_SIZE_WARNING_BYTES,
    freeBytes,
    fitsFreeSpace: totalBytes <= freeBytes,
  };
}

/**
 * Parse `df -k`'s "Available" column (in KB) from the Box's `/workspace` mount.
 * Dropped rather than guessed at if the shape is unexpected: a wrong free-space
 * number would make the size refusal lie.
 */
export function parseDfAvailableBytes(stdout: string): number {
  const dataLine = stdout.trim().split("\n")[1] ?? "";
  const fields = dataLine.trim().split(/\s+/);
  const availableKb = Number(fields[3]);
  if (!Number.isFinite(availableKb)) {
    throw new Error("Could not read the Box's free space from `df`.");
  }
  return availableKb * 1024;
}

/**
 * What the one confirmation sheet shows. `folder` is the absolute host path —
 * carried back to `importFolder` so the Launcher re-reads the folder itself
 * when the copy runs, rather than trusting this listing's byte counts.
 */
export interface ImportListing {
  readonly folder: string;
  readonly folderName: string;
  readonly isGitRepo: boolean;
  /** No `.gitignore` at the folder root means nothing meaningful was filtered — shown as a warning. */
  readonly hasGitignore: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly warnBytes: number;
  readonly overWarnThreshold: boolean;
  readonly freeBytes: number;
  readonly fitsFreeSpace: boolean;
}

/**
 * Fixed seed prompt (CONTEXT.md's Starter Template principle: a Sandbox User is
 * never faced with a blank chat) — an Import is where that bites hardest, since
 * the user just handed Claude a codebase it doesn't understand yet.
 */
export const IMPORT_SEED_PROMPT =
  "I've just brought this project in from my computer. Take a look around, tell me what it is, and suggest a few things I could do with it.";
