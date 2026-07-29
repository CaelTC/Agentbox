import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BOX_USER, WORKSPACE_DIR } from "../core/config";
import { size } from "../core/format";
import {
  IMPORT_SEED_PROMPT,
  assertRepoRelativePaths,
  deriveImportIdentity,
  importTarArgs,
  importTarInput,
  parseDfAvailableBytes,
  parseGitLsFiles,
  planImport,
  type ImportFile,
  type ImportListing,
} from "../core/import";
import { META_DIR, serializeProjectMeta, type Project } from "../core/projects";
import { boxExec, type BoxExec } from "./box-exec";
import { run } from "./exec";
import { boxListProjects, metaPath, projectPath } from "./workspace-projects";

/**
 * Import: a whole folder on the MacBook becoming a Project (ticket 09). The only
 * Workspace operation that reads the host filesystem at length — `git`, the walk
 * and the `tar` that feeds `docker cp` all live here.
 */
/** True when the folder itself is a git working tree (not merely inside one). */
async function isGitRepo(folder: string): Promise<boolean> {
  const res = await run("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"]);
  return res.code === 0 && res.stdout.trim() === "true";
}

/**
 * Tracked plus untracked-not-ignored paths, NUL-separated exactly as `tar
 * --null -T -` wants them. Kept as the raw string (not just the parsed array)
 * so it can be fed straight to `tar`'s stdin without re-serializing it.
 */
async function gitLsFilesRaw(folder: string): Promise<string> {
  const res = await run("git", [
    "-C",
    folder,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (res.code !== 0) {
    throw new Error(`'git ls-files' failed in '${folder}': ${res.stderr}`);
  }
  return res.stdout;
}

/**
 * Every regular file and symlink under `folder`, relative paths — used when
 * there is no repo to ask `git ls-files`. No `.gitignore` at the root means
 * nothing is filtered here: everything crosses (matches the confirmation
 * sheet's warning for exactly this case).
 */
function listAllFiles(folder: string, dir: string = folder): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // A stray `.git` here means a repo `git rev-parse` refused (corrupt, or a
      // vendored one nested in the tree). Walking it turns every loose object
      // into its own tar directive; the repo path never expands `.git` either.
      if (entry.name === ".git") continue;
      found.push(...listAllFiles(folder, full));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      found.push(full.slice(folder.length + 1));
    }
  }
  return found;
}

/** Stat each path in Node for an exact total (~100ms for 20k files) — symmetric with `planExport`. */
function statImportFiles(folder: string, paths: readonly string[]): ImportFile[] {
  // lstat, not stat: a dangling symlink (pointing outside the folder) must not
  // crash the size pass — it lands as a symlink in the Box, harmlessly (ticket 09).
  return paths.map((path) => ({ path, size: lstatSync(join(folder, path)).size }));
}

async function freeSpaceBytes(box: BoxExec): Promise<number> {
  // -P (POSIX) guarantees one line per filesystem; plain `df` wraps a long
  // device name onto its own line, which would feed the parser the wrong row.
  //
  // Not tolerant: a failure here IS a failure, it just wants naming — which is
  // what `what` is for, rather than a `tryExec` whose result is rethrown anyway.
  return parseDfAvailableBytes(
    await box.exec(["df", "-kP", WORKSPACE_DIR], "Reading the Box's free space"),
  );
}

interface GatheredImport {
  readonly isGitRepo: boolean;
  readonly hasGitignore: boolean;
  readonly paths: readonly string[];
}

/**
 * The mechanism forks on whether the folder is a git repo at all; the warning
 * (`hasGitignore`) is a SEPARATE condition — a repo with no root `.gitignore`
 * still warns even though `git ls-files` is doing the listing.
 */
async function gatherImport(folder: string): Promise<GatheredImport> {
  const hasGitignore = existsSync(join(folder, ".gitignore"));
  if (await isGitRepo(folder)) {
    const paths = assertRepoRelativePaths(parseGitLsFiles(await gitLsFilesRaw(folder)));
    return { isGitRepo: true, hasGitignore, paths };
  }
  return { isGitRepo: false, hasGitignore, paths: listAllFiles(folder) };
}

/**
 * Measure a folder for the one confirmation sheet (ticket 09): what crosses,
 * whether `.gitignore` filtered anything, the exact size, and whether it fits
 * the Box. Nothing is copied here — `importFolder` re-measures independently
 * rather than trusting this listing's byte counts back from the renderer.
 */
export async function boxPlanImport(
  folder: string,
  box: BoxExec = boxExec,
): Promise<ImportListing> {
  const resolved = resolve(folder);
  // Independent: the `df` round trip into the Box needs nothing from the walk.
  const [gathered, freeBytes] = await Promise.all([gatherImport(resolved), freeSpaceBytes(box)]);
  const plan = planImport(statImportFiles(resolved, gathered.paths), freeBytes);

  return {
    folder: resolved,
    folderName: basename(resolved),
    isGitRepo: gathered.isGitRepo,
    hasGitignore: gathered.hasGitignore,
    ...plan,
  };
}

/**
 * Project Import (ticket 09): a folder on the MacBook *becomes* a Project, its
 * contents landing at the Project root (never nested — `agentbox-session`
 * launches Claude's cwd at exactly that root). One `tar` stream piped straight
 * into `docker cp -`, so 5000 files are one round trip instead of 5000; `.git`
 * always crosses alongside whatever `git ls-files` listed, history included.
 *
 * Re-measures the folder rather than trusting the sheet's listing, exactly as
 * `boxExport` re-enumerates the Box before writing: nothing from the renderer
 * is trusted for the write itself, only for what it showed the user.
 */
export async function boxImportFolder(
  folder: string,
  box: BoxExec = boxExec,
): Promise<Project> {
  const resolved = resolve(folder);
  // Independent: the `df` round trip into the Box needs nothing from the walk.
  const [gathered, freeBytes] = await Promise.all([gatherImport(resolved), freeSpaceBytes(box)]);
  const plan = planImport(statImportFiles(resolved, gathered.paths), freeBytes);

  if (!plan.fitsFreeSpace) {
    // Refused before a single byte crosses — "there isn't room" as a sentence,
    // not `docker cp` dying mid-stream and leaving a half-copied Project.
    throw new Error(
      `Not enough room in the Box: this needs ${size(plan.totalBytes)}, ` +
        `and only ${size(plan.freeBytes)} is free.`,
    );
  }

  const existing = await boxListProjects(box);
  const { name, slug } = deriveImportIdentity(
    basename(resolved),
    existing.map((p) => p.slug),
  );
  const dir = projectPath(slug);

  await box.exec(["mkdir", "-p", dir]);

  try {
    // Both of `runPipe`'s failure modes are one thrown error here — `copyInStream`
    // owns that normalisation, so this branch only has to own the cleanup.
    await box.copyInStream(
      { command: "tar", args: importTarArgs(resolved, gathered.isGitRepo) },
      dir,
      importTarInput(gathered.paths),
    );
  } catch (err) {
    // A failed `docker cp` still leaves whatever it managed to write. Without
    // this the half-copied directory survives, and since project.json is only
    // written below, it shows up in the Project list as an openable Project
    // that has no metadata — "nothing partial lands" has to mean this too.
    // As root: a partial copy's synthesised directories are root-owned, so the
    // sandbox user cannot remove them (see the chown below for why).
    //
    // A cleanup that itself fails is reported ALONGSIDE the copy failure rather
    // than replacing it (the copy is the thing that went wrong) or being
    // swallowed (the leftover directory is what the user will see next).
    const leftover = await box.execAsRoot(["rm", "-rf", dir]).then(
      () => "",
      (cleanupErr: unknown) =>
        ` The half-copied folder could not be removed either: ${(cleanupErr as Error).message}`,
    );
    throw new Error(
      `Import failed copying '${resolved}' into the Box: ${(err as Error).message}.${leftover}`,
    );
  }

  // `docker cp` writes files with the archive's ownership, but SYNTHESISES the
  // parent directories (`src/`, …) as root, because `git ls-files` lists only
  // files and so tar never emits a directory entry for them. Left alone, the
  // sandbox user can edit an imported file but cannot create a new one beside
  // it, and git refuses the repo for "dubious ownership". Root-owned dirs are
  // also why this runs as root.
  //
  // Throws: a dropped exit code here handed back a Project that Claude cannot
  // write into and git calls "dubious ownership" — an import that reads as a
  // success and is broken the moment it is opened.
  await box.execAsRoot(["chown", "-R", `${BOX_USER}:${BOX_USER}`, dir]);

  // Written AFTER the copy, so a stray .agentbox/ carried in from the source
  // folder can't clobber this Project's real metadata (ticket 09).
  await box.exec(["mkdir", "-p", `${dir}/${META_DIR}`]);
  await box.writeFile(
    metaPath(slug),
    serializeProjectMeta({ name, slug, seedPrompt: IMPORT_SEED_PROMPT }),
  );

  return { name, slug, dir };
}
