import { BOX_CONTAINER, WORKSPACE_DIR } from "../core/config";
import type { Project, ProjectMeta } from "../core/projects";
import {
  assertValidSlug,
  metaRelPath,
  parseProjectMeta,
  sanitizeProjectName,
  serializeProjectMeta,
} from "../core/projects";
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
