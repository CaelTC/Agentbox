import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { BOX_CONTAINER, BOX_USER, ENGINE_CLI, WORKSPACE_DIR } from "../core/config";
import { size } from "../core/format";
import {
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
  parseProjectUsage,
  type DeleteResult,
} from "../core/delete";
import { killSessionExecArgs } from "../core/session-window";
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
import { run, runPipe } from "./exec";

/**
 * Box-side Workspace operations. Because the Workspace is a NAMED VOLUME and not
 * a host mount (ADR 0001, threat A), the Launcher cannot write Project folders
 * on the host — it brokers them into the Box via `docker exec` / `docker cp`.
 *
 * The DECISIONS (safe slug, collision-free destinations) come from the pure,
 * tested core helpers; only the EFFECTS live here.
 */

// assertValidSlug before building any path that reaches a Box-side shell.
const metaPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}/${metaRelPath}`;
const projectPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}`;

/** List Projects by inspecting /workspace inside the Box. */
export async function boxListProjects(): Promise<Project[]> {
  const listing = await run(ENGINE_CLI, [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    // one slug per line, directories only, skip dotfiles. `[ -d ]` skips the
    // literal `/workspace/*/` POSIX sh leaves when the Workspace is empty.
    `for d in ${WORKSPACE_DIR}/*/; do [ -d "$d" ] || continue; b=$(basename "$d"); case "$b" in .*) ;; *) echo "$b";; esac; done 2>/dev/null`,
  ]);

  const slugs = listing.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const projects: Project[] = [];
  for (const slug of slugs) {
    const meta = await readBoxMeta(slug);
    projects.push({ name: meta?.name ?? slug, slug, dir: projectPath(slug) });
  }
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function readBoxMeta(slug: string): Promise<ProjectMeta | undefined> {
  const res = await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "cat", metaPath(slug)]);
  if (res.code !== 0) return undefined;
  return parseProjectMeta(res.stdout);
}

async function boxPathExists(path: string): Promise<boolean> {
  const res = await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "test", "-e", path]);
  return res.code === 0;
}

/** Create a Project folder (and its metadata) inside the Box. */
export async function boxCreateProject(
  name: string,
  seedPrompt?: string,
): Promise<Project> {
  const slug = sanitizeProjectName(name);
  if (await boxPathExists(projectPath(slug))) {
    throw new Error(`A Project already exists at '${slug}'.`);
  }

  await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "mkdir", "-p", `${projectPath(slug)}/.claudebox`]);
  await writeBoxFile(metaPath(slug), serializeProjectMeta({ name, slug, seedPrompt }));

  return { name, slug, dir: projectPath(slug) };
}

async function writeBoxFile(path: string, content: string): Promise<void> {
  // Use base64 to avoid any shell-quoting hazards with arbitrary content.
  const b64 = Buffer.from(content, "utf8").toString("base64");
  await run(ENGINE_CLI, [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    `echo ${b64} | base64 -d > "${path}"`,
  ]);
}

/**
 * How much of the Workspace one Project is holding. Unlike `boxListProjectFiles`
 * (which prunes dot-directories and `node_modules` because the Export picker
 * would drown in them), this counts EVERYTHING — the delete sheet is answering
 * "what am I about to lose", and an imported repo's `.git` is exactly the part a
 * Sandbox User would most regret.
 */
export async function boxProjectUsage(
  slug: string,
): Promise<{ fileCount: number; totalBytes: number } | undefined> {
  const dir = projectPath(slug);
  // Two lines: the file count, then the size in KiB. `du` reports allocated
  // blocks, which is the truer answer to what the Resource Cap is holding.
  const res = await run(ENGINE_CLI, [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    `cd "${dir}" && { find . -mindepth 1 -type f | wc -l; du -sk . | cut -f1; }`,
  ]);
  if (res.code !== 0) return undefined;
  return parseProjectUsage(res.stdout);
}

/**
 * Delete Project: remove a Project and everything in it from the Workspace,
 * permanently (core/delete.ts explains why there is no trash).
 *
 * Order matters. The tmux session dies FIRST — see `killSessionExecArgs` — and
 * only then does the directory go, so the slug is genuinely free afterwards.
 *
 * The `rm -rf` runs as root for the same reason the failed-import cleanup does:
 * `docker cp` synthesises parent directories as root, so a Project that arrived
 * through Import can contain directories the sandbox user cannot unlink. A
 * delete that half-works would leave exactly the metadata-less directory that
 * shows up in the Project list as an openable Project with nothing in it.
 */
export async function boxDeleteProject(slug: string): Promise<DeleteResult> {
  const dir = assertDeletableProjectPath(WORKSPACE_DIR, slug);

  const meta = await readBoxMeta(slug);
  if (!(await boxPathExists(dir))) {
    throw new Error(`No Project named '${slug}'.`);
  }

  // Non-zero simply means there was no live session — not a failure.
  const killed = await run(ENGINE_CLI, killSessionExecArgs(slug));

  const removed = await run(ENGINE_CLI, ["exec", "-u", "root", BOX_CONTAINER, "rm", "-rf", dir]);
  if (removed.code !== 0) {
    throw new Error(`Couldn't delete '${slug}': ${removed.stderr}`);
  }

  // Confirmed gone rather than assumed: `rm -rf` exits 0 on plenty of paths it
  // never touched, and the one thing this operation promises is that the Project
  // is not there any more.
  if (await boxPathExists(dir)) {
    throw new Error(`'${slug}' is still in the Workspace after deleting it.`);
  }

  return { slug, name: meta?.name ?? slug, sessionKilled: killed.code === 0 };
}

/**
 * Copy host files into a Project via `docker cp` — a one-way host→Box copy with
 * no live mount (ticket 06). Collision-free destinations come from the pure
 * resolver, using a Box-backed existence check.
 */
export async function boxUpload(sources: string[], slug: string): Promise<UploadTarget[]> {
  const dir = projectPath(slug);

  // Pre-fetch existing names once so the resolver can dedupe synchronously.
  const existing = new Set<string>();
  const listing = await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "sh", "-c", `ls -1 "${dir}" 2>/dev/null`]);
  for (const name of listing.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    existing.add(`${dir}/${name}`);
  }

  const targets = resolveUploadTargets(sources, dir, {
    exists: (p) => existing.has(p),
  });

  for (const { source, dest } of targets) {
    await run(ENGINE_CLI, ["cp", source, `${BOX_CONTAINER}:${dest}`]);
  }
  return targets;
}

/**
 * Enumerate a Project's regular files inside the Box (ticket 07). The LAUNCHER
 * asks for this list and the Launcher classifies it — nothing served from inside
 * the Box decides what the host writes.
 */
export async function boxListProjectFiles(slug: string): Promise<BoxFile[]> {
  const dir = projectPath(slug);
  // %m = octal mode, %s = size, %P = path relative to the Project. Regular files
  // only, so symlinks never become a host write.
  //
  // Dot-directories and node_modules are pruned rather than listed-and-refused:
  // the classifier rejects them either way, but one `npm install` would otherwise
  // put tens of thousands of identically-greyed rows in the picker. -mindepth 1
  // keeps the prune from matching "." itself and emptying the listing.
  const listing = await run(ENGINE_CLI, [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    `cd "${dir}" && find . -mindepth 1 \\( -name node_modules -o -name '.*' \\) -prune ` +
      `-o -type f -printf '%m\\t%s\\t%P\\n' 2>/dev/null`,
  ]);

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
): Promise<ExportListing> {
  const [dir, files] = await Promise.all([
    boxExportDir(slug, exportRoot),
    boxListProjectFiles(slug),
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
export async function boxExportDir(slug: string, exportRoot: string): Promise<string> {
  const { project, projects } = await boxFindProject(slug);
  return resolveExportDir(exportRoot, project, projects);
}

/**
 * One Project by slug, alongside the full listing it came from — `resolveExportDir`
 * needs the siblings to disambiguate two Projects whose friendly names collide.
 */
export async function boxFindProject(
  slug: string,
): Promise<{ project: Project; projects: Project[] }> {
  assertValidSlug(slug);
  const projects = await boxListProjects();
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
): Promise<ExportResult> {
  // Required, never defaulted: a caller that forgets the selection must export
  // nothing, not everything. Ticket 08 made the picker the only way in.
  if (!Array.isArray(pick)) throw new Error("Nothing was chosen to save.");

  const dir = await boxExportDir(slug, exportRoot);
  const plan = planExport(await boxListProjectFiles(slug), pick);

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
  for (const file of plan.selected) {
    const target = resolveExportTarget(dir, file.path);
    mkdirSync(dirname(target), { recursive: true }); // keep the Project's structure
    await run(ENGINE_CLI, ["cp", `${BOX_CONTAINER}:${projectPath(slug)}/${file.path}`, target]);
    // Nothing lands executable, whatever the Box said. Kept because it is still
    // correct on macOS and costs nothing — but it is a no-op for executability
    // on Windows, which is why the untrusted mark below exists (#12).
    chmodSync(target, 0o644);
    if (!(await markExportedUntrusted(target))) unmarked += 1;
  }

  const now = new Date();
  utimesSync(dir, now, now); // stamps "last saved", which Show files reports
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

async function freeSpaceBytes(): Promise<number> {
  // -P (POSIX) guarantees one line per filesystem; plain `df` wraps a long
  // device name onto its own line, which would feed the parser the wrong row.
  const res = await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "df", "-kP", WORKSPACE_DIR]);
  if (res.code !== 0) {
    throw new Error(`Could not read the Box's free space: ${res.stderr}`);
  }
  return parseDfAvailableBytes(res.stdout);
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
export async function boxPlanImport(folder: string): Promise<ImportListing> {
  const resolved = resolve(folder);
  // Independent: the `df` round trip into the Box needs nothing from the walk.
  const [gathered, freeBytes] = await Promise.all([gatherImport(resolved), freeSpaceBytes()]);
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
export async function boxImportFolder(folder: string): Promise<Project> {
  const resolved = resolve(folder);
  // Independent: the `df` round trip into the Box needs nothing from the walk.
  const [gathered, freeBytes] = await Promise.all([gatherImport(resolved), freeSpaceBytes()]);
  const plan = planImport(statImportFiles(resolved, gathered.paths), freeBytes);

  if (!plan.fitsFreeSpace) {
    // Refused before a single byte crosses — "there isn't room" as a sentence,
    // not `docker cp` dying mid-stream and leaving a half-copied Project.
    throw new Error(
      `Not enough room in the Box: this needs ${size(plan.totalBytes)}, ` +
        `and only ${size(plan.freeBytes)} is free.`,
    );
  }

  const existing = await boxListProjects();
  const { name, slug } = deriveImportIdentity(
    basename(resolved),
    existing.map((p) => p.slug),
  );
  const dir = projectPath(slug);

  await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "mkdir", "-p", dir]);

  // `runPipe` REJECTS rather than resolves when a stage cannot be spawned at all
  // (no `tar`, no engine binary). Folded into a failure result so one branch
  // below owns the cleanup — a rejection escaping here would skip the `rm -rf`
  // and leave exactly the metadata-less directory it exists to prevent.
  const copy = await runPipe(
    { command: "tar", args: importTarArgs(resolved, gathered.isGitRepo) },
    { command: ENGINE_CLI, args: ["cp", "-", `${BOX_CONTAINER}:${dir}`] },
    importTarInput(gathered.paths),
  ).catch((err: unknown) => ({ code: -1, stdout: "", stderr: String(err) }));
  if (copy.code !== 0) {
    // A failed `docker cp` still leaves whatever it managed to write. Without
    // this the half-copied directory survives, and since project.json is only
    // written below, it shows up in the Project list as an openable Project
    // that has no metadata — "nothing partial lands" has to mean this too.
    // As root: a partial copy's synthesised directories are root-owned, so the
    // sandbox user cannot remove them (see the chown below for why).
    await run(ENGINE_CLI, ["exec", "-u", "root", BOX_CONTAINER, "rm", "-rf", dir]);
    throw new Error(`Import failed copying '${resolved}' into the Box: ${copy.stderr}`);
  }

  // `docker cp` writes files with the archive's ownership, but SYNTHESISES the
  // parent directories (`src/`, …) as root, because `git ls-files` lists only
  // files and so tar never emits a directory entry for them. Left alone, the
  // sandbox user can edit an imported file but cannot create a new one beside
  // it, and git refuses the repo for "dubious ownership". Root-owned dirs are
  // also why this runs as root.
  await run(ENGINE_CLI, [
    "exec",
    "-u",
    "root",
    BOX_CONTAINER,
    "chown",
    "-R",
    `${BOX_USER}:${BOX_USER}`,
    dir,
  ]);

  // Written AFTER the copy, so a stray .claudebox/ carried in from the source
  // folder can't clobber this Project's real metadata (ticket 09).
  await run(ENGINE_CLI, ["exec", BOX_CONTAINER, "mkdir", "-p", `${dir}/${META_DIR}`]);
  await writeBoxFile(
    metaPath(slug),
    serializeProjectMeta({ name, slug, seedPrompt: IMPORT_SEED_PROMPT }),
  );

  return { name, slug, dir };
}
