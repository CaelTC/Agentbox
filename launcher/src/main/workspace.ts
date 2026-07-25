import { chmodSync, mkdirSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { BOX_CONTAINER, WORKSPACE_DIR } from "../core/config";
import {
  parseBoxFileListing,
  planExport,
  resolveExportDir,
  resolveExportTarget,
  type BoxFile,
  type ExportListing,
  type ExportResult,
} from "../core/export";
import type { Project, ProjectMeta } from "../core/projects";
import {
  assertValidSlug,
  metaRelPath,
  parseProjectMeta,
  sanitizeProjectName,
  serializeProjectMeta,
} from "../core/projects";
import { previewDoc, projectDocRelPath } from "../core/preview";
import { resolveUploadTargets, type UploadTarget } from "../core/upload";
import { run } from "./exec";

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
  const listing = await run("docker", [
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
  const res = await run("docker", ["exec", BOX_CONTAINER, "cat", metaPath(slug)]);
  if (res.code !== 0) return undefined;
  return parseProjectMeta(res.stdout);
}

async function boxPathExists(path: string): Promise<boolean> {
  const res = await run("docker", ["exec", BOX_CONTAINER, "test", "-e", path]);
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

  await run("docker", ["exec", BOX_CONTAINER, "mkdir", "-p", `${projectPath(slug)}/.claudebox`]);
  await writeBoxFile(metaPath(slug), serializeProjectMeta({ name, slug, seedPrompt }));

  return { name, slug, dir: projectPath(slug) };
}

/**
 * Drop the Preview contract into the Project as `CLAUDE.md`, which Claude Code
 * reads at every session start. Written only when absent, so any later edit by
 * the user or by Claude survives.
 */
export async function boxEnsureProjectDoc(slug: string): Promise<void> {
  const path = `${projectPath(slug)}/${projectDocRelPath}`;
  if (await boxPathExists(path)) return;
  await writeBoxFile(path, previewDoc());
}

async function writeBoxFile(path: string, content: string): Promise<void> {
  // Use base64 to avoid any shell-quoting hazards with arbitrary content.
  const b64 = Buffer.from(content, "utf8").toString("base64");
  await run("docker", [
    "exec",
    BOX_CONTAINER,
    "sh",
    "-c",
    `echo ${b64} | base64 -d > "${path}"`,
  ]);
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
  const listing = await run("docker", ["exec", BOX_CONTAINER, "sh", "-c", `ls -1 "${dir}" 2>/dev/null`]);
  for (const name of listing.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    existing.add(`${dir}/${name}`);
  }

  const targets = resolveUploadTargets(sources, dir, {
    exists: (p) => existing.has(p),
  });

  for (const { source, dest } of targets) {
    await run("docker", ["cp", source, `${BOX_CONTAINER}:${dest}`]);
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
  const listing = await run("docker", [
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
  assertValidSlug(slug);
  const projects = await boxListProjects();
  const project = projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`No Project named '${slug}'.`);
  return resolveExportDir(exportRoot, project, projects);
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
  };

  // Over the cap nothing at all is written — an unbounded copy onto the user's
  // real disk is threat A.
  if (plan.overCap) return { ...result, saved: 0 };

  mkdirSync(dir, { recursive: true });
  for (const file of plan.selected) {
    const target = resolveExportTarget(dir, file.path);
    mkdirSync(dirname(target), { recursive: true }); // keep the Project's structure
    await run("docker", ["cp", `${BOX_CONTAINER}:${projectPath(slug)}/${file.path}`, target]);
    chmodSync(target, 0o644); // nothing lands executable, whatever the Box said
  }

  const now = new Date();
  utimesSync(dir, now, now); // stamps "last saved", which Show files reports
  return result;
}
