import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BOX_USER, WORKSPACE_DIR } from "../core/config";
import { size } from "../core/format";
import {
  SAVED_STAMP,
  parseBoxFileListing,
  planExport,
  resolveExportDir,
  resolveExportTarget,
  untrustedMark,
  type BoxFile,
  type ExportListing,
  type ExportResult,
} from "../core/export";
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
import {
  assertDeletableProjectPath,
  confirmsProjectName,
  parseProjectUsage,
  type DeleteListing,
  type DeleteResult,
} from "../core/delete";
import { killSessionArgs } from "../core/session-window";
import type { Project, ProjectMeta } from "../core/projects";
import {
  META_DIR,
  assertValidSlug,
  metaRelPath,
  parseProjectMeta,
  sanitizeProjectName,
  serializeProjectMeta,
} from "../core/projects";
import { resolveUploadTargets, type UploadTarget } from "../core/upload";
import { boxExec, sh, type BoxExec } from "./box-exec";
import { run } from "./exec";

/**
 * Box-side Workspace operations. Because the Workspace is a NAMED VOLUME and not
 * a host mount (ADR 0001, threat A), the Launcher cannot write Project folders
 * on the host — it brokers them into the Box through the Box-exec seam
 * (`./box-exec`), which owns every `docker exec` / `docker cp` here: its argv,
 * its shell quoting, and the rule that a non-zero exit is an error.
 *
 * The DECISIONS (safe slug, collision-free destinations) come from the pure,
 * tested core helpers; only the EFFECTS live here.
 *
 * Every entry point takes the Box as its last argument, defaulted to the real
 * one, so these operations are assertable against a fake Box — the same
 * injection style as `spawnPath(path, exists)` and `markExportedUntrusted`.
 * `run` survives only for HOST commands (`git`, `xattr`), never for the Box.
 */

// assertValidSlug before building any path that reaches a Box-side shell.
const metaPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}/${metaRelPath}`;
const projectPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}`;

/** List Projects by inspecting /workspace inside the Box. */
export async function boxListProjects(box: BoxExec = boxExec): Promise<Project[]> {
  // Throws rather than reporting an empty Workspace: "you have no Projects" is
  // the worst possible lie to tell a Sandbox User whose Projects are all there.
  const listing = await box.exec(
    // one slug per line, directories only, skip dotfiles. `[ -d ]` skips the
    // literal `/workspace/*/` POSIX sh leaves when the Workspace is empty.
    sh(
      'for d in "$1"/*/; do [ -d "$d" ] || continue; b=$(basename "$d"); case "$b" in .*) ;; *) echo "$b";; esac; done',
      WORKSPACE_DIR,
    ),
  );

  const slugs = listing
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const projects: Project[] = [];
  for (const slug of slugs) {
    const meta = await readBoxMeta(box, slug);
    projects.push({ name: meta?.name ?? slug, slug, dir: projectPath(slug) });
  }
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function readBoxMeta(box: BoxExec, slug: string): Promise<ProjectMeta | undefined> {
  // Tolerant on purpose: a Project directory with no project.json is a Project
  // named by its slug, not an error — `boxListProjects` falls back to the slug.
  const res = await box.tryExec(["cat", metaPath(slug)]);
  if (res.code !== 0) return undefined;
  return parseProjectMeta(res.stdout);
}

async function boxPathExists(box: BoxExec, path: string): Promise<boolean> {
  // Tolerant on purpose: non-zero IS the answer "it isn't there".
  const res = await box.tryExec(["test", "-e", path]);
  return res.code === 0;
}

/** Create a Project folder (and its metadata) inside the Box. */
export async function boxCreateProject(
  name: string,
  seedPrompt?: string,
  box: BoxExec = boxExec,
): Promise<Project> {
  const slug = sanitizeProjectName(name);
  if (await boxPathExists(box, projectPath(slug))) {
    throw new Error(`A Project already exists at '${slug}'.`);
  }

  // Both throw. A dropped exit code here handed the renderer a Project it would
  // render by its raw slug, sitting on a directory that may not exist at all.
  await box.exec(["mkdir", "-p", `${projectPath(slug)}/${META_DIR}`]);
  await box.writeFile(metaPath(slug), serializeProjectMeta({ name, slug, seedPrompt }));

  return { name, slug, dir: projectPath(slug) };
}

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
 */
function holdsAnExportedFile(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // no dotfile is exportable
    if (entry.isFile()) return true;
    if (entry.isDirectory() && holdsAnExportedFile(join(dir, entry.name))) return true;
  }
  return false;
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

/**
 * Enumerate a Project's regular files inside the Box (ticket 07). The LAUNCHER
 * asks for this list and the Launcher classifies it — nothing served from inside
 * the Box decides what the host writes.
 */
async function boxListProjectFiles(slug: string, box: BoxExec = boxExec): Promise<BoxFile[]> {
  const dir = projectPath(slug);
  // %m = octal mode, %s = size, %P = path relative to the Project. Regular files
  // only, so symlinks never become a host write.
  //
  // Dot-directories and node_modules are pruned rather than listed-and-refused:
  // the classifier rejects them either way, but one `npm install` would otherwise
  // put tens of thousands of identically-greyed rows in the picker. -mindepth 1
  // keeps the prune from matching "." itself and emptying the listing.
  //
  // Tolerant on purpose, and unusually so: the ROWS are the answer here, not the
  // exit code. `find` exits 1 for any per-file traversal error — one file a
  // running dev server unlinked mid-walk is enough — while still printing every
  // other file it visited, so throwing on the code failed a whole Export over a
  // listing that was complete apart from a file the user was never going to save.
  const listing = await box.tryExec(
    sh(
      `cd "$1" && find . -mindepth 1 \\( -name node_modules -o -name '.*' \\) -prune ` +
        `-o -type f -printf '%m\\t%s\\t%P\\n' 2>/dev/null`,
      dir,
    ),
  );

  // Nothing printed AND a failure is the case the throw was really for (no such
  // container, no such Project): Export and Delete both read this list, and an
  // empty one there would offer the Sandbox User nothing to save and then report
  // that nothing was lost. An empty Project exits 0, so it is not caught here.
  if (listing.code !== 0 && listing.stdout.trim() === "") {
    throw new Error(
      `Couldn't list the files in '${slug}': ${listing.stderr.trim() || "no output"}`,
    );
  }

  return parseBoxFileListing(listing.stdout);
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
 * One Project by slug, alongside the full listing it came from — `resolveExportDir`
 * needs the siblings to disambiguate two Projects whose friendly names collide.
 */
async function boxFindProject(
  slug: string,
  box: BoxExec = boxExec,
): Promise<{ project: Project; projects: Project[] }> {
  assertValidSlug(slug);
  const projects = await boxListProjects(box);
  const project = projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`No Project named '${slug}'.`);
  return { project, projects };
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
        // Undated on disk; `lastSavedAt` backfills it from the folder next time.
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
 * contents landing at the Project root (never nested — `claudebox-session`
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

  // Written AFTER the copy, so a stray .claudebox/ carried in from the source
  // folder can't clobber this Project's real metadata (ticket 09).
  await box.exec(["mkdir", "-p", `${dir}/${META_DIR}`]);
  await box.writeFile(
    metaPath(slug),
    serializeProjectMeta({ name, slug, seedPrompt: IMPORT_SEED_PROMPT }),
  );

  return { name, slug, dir };
}
