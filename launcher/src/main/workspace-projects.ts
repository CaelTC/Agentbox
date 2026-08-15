import { DEFAULT_HARNESS, WORKSPACE_DIR, type Harness } from "../core/config";
import { parseBoxFileListing, type BoxFile } from "../core/export";
import type { Project, ProjectMeta } from "../core/projects";
import {
  META_DIR,
  assertValidSlug,
  metaRelPath,
  parseProjectMeta,
  sanitizeProjectName,
  serializeProjectMeta,
} from "../core/projects";
import { boxExec, sh, type BoxExec } from "./box-exec";

/**
 * What every other Workspace operation is built on: where a Project lives inside
 * the Box, what is in it, and the two operations that make the list itself.
 *
 * Nothing here is exported to the renderer that isn't in `./workspace` — the
 * helpers below are `export`ed only so the sibling files can reach them, which is
 * what a module-private function becomes once the concerns live apart.
 */
// assertValidSlug before building any path that reaches a Box-side shell.
export const metaPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}/${metaRelPath}`;
export const projectPath = (slug: string) => `${WORKSPACE_DIR}/${assertValidSlug(slug)}`;

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
    projects.push({ name: meta?.name ?? slug, slug, dir: projectPath(slug), agent: meta?.agent });
  }
  return projects.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readBoxMeta(box: BoxExec, slug: string): Promise<ProjectMeta | undefined> {
  // Tolerant on purpose: a Project directory with no project.json is a Project
  // named by its slug, not an error — `boxListProjects` falls back to the slug.
  const res = await box.tryExec(["cat", metaPath(slug)]);
  if (res.code !== 0) return undefined;
  return parseProjectMeta(res.stdout);
}

export async function boxPathExists(box: BoxExec, path: string): Promise<boolean> {
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
 * Stamp the Harness the Launcher is set to into a Project's metadata, where the
 * Box-side funnel reads it (the `agent` key, `box/bin/agentbox-session`). Run on
 * every open (main/ipc.ts), which is what makes an app-level setting apply to
 * whichever Project is opened next instead of the one it was created under.
 *
 * Writes nothing when the metadata already says what the funnel would do anyway:
 * the default harness IS the funnel's default, so a Launcher whose setting was
 * never touched leaves every existing project.json exactly as it found it, and
 * switching back drops the key rather than pinning it.
 *
 * Metadata that is missing or unparseable is left alone rather than replaced —
 * rewriting it would throw away the Project's name, and a Project with no
 * metadata is one the funnel refuses to open in the first place.
 */
export async function boxSetProjectAgent(
  slug: string,
  agent: Harness,
  box: BoxExec = boxExec,
): Promise<void> {
  const meta = await readBoxMeta(box, slug);
  if (!meta || (meta.agent ?? DEFAULT_HARNESS) === agent) return;

  const next: ProjectMeta = { ...meta };
  if (agent === DEFAULT_HARNESS) delete next.agent;
  else next.agent = agent;
  await box.writeFile(metaPath(slug), serializeProjectMeta(next));
}

/**
 * Enumerate a Project's regular files inside the Box (ticket 07). The LAUNCHER
 * asks for this list and the Launcher classifies it — nothing served from inside
 * the Box decides what the host writes.
 */
export async function boxListProjectFiles(slug: string, box: BoxExec = boxExec): Promise<BoxFile[]> {
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
 * One Project by slug, alongside the full listing it came from — `resolveExportDir`
 * needs the siblings to disambiguate two Projects whose friendly names collide.
 */
export async function boxFindProject(
  slug: string,
  box: BoxExec = boxExec,
): Promise<{ project: Project; projects: Project[] }> {
  assertValidSlug(slug);
  const projects = await boxListProjects(box);
  const project = projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`No Project named '${slug}'.`);
  return { project, projects };
}
