/**
 * Projects (ticket 05): each Project is its own folder in the Workspace and
 * persists. This module owns Project naming and metadata; the Workspace itself
 * lives on a named volume inside the Box, so creating and listing Projects is
 * brokered there (main/workspace.ts), not on the host filesystem.
 */
export interface Project {
  /** The friendly name the Sandbox User typed. */
  readonly name: string;
  /** The filesystem-safe folder name. */
  readonly slug: string;
  /** Absolute path to the Project's folder inside the Workspace. */
  readonly dir: string;
  /**
   * Epoch ms of the last Export, absent if this Project has never been saved
   * out. Filled host-side from the landing folder's own mtime (main/workspace.ts)
   * — it costs no Box call, which is why the home screen can say it for every
   * Project at once. Absent from a Project the Box just created.
   */
  readonly lastSaved?: number;
}

/** Persisted per-Project metadata, written into the Box by main/workspace.ts. */
export interface ProjectMeta {
  name: string;
  slug: string;
  seedPrompt?: string;
}

export const META_DIR = ".claudebox";
export const META_FILE = "project.json";

/** Relative path of a Project's metadata file, from the Project directory. */
export const metaRelPath = `${META_DIR}/${META_FILE}`;

export function serializeProjectMeta(meta: ProjectMeta): string {
  const trimmed: ProjectMeta = meta.seedPrompt
    ? { name: meta.name, slug: meta.slug, seedPrompt: meta.seedPrompt }
    : { name: meta.name, slug: meta.slug };
  return JSON.stringify(trimmed, null, 2);
}

export function parseProjectMeta(json: string): ProjectMeta | undefined {
  try {
    return JSON.parse(json) as ProjectMeta;
  } catch {
    return undefined;
  }
}

/**
 * Turn a friendly name into a safe folder slug. Rejects names that reduce to
 * nothing, and can never produce a `..` or path separator — so a Project can
 * never escape the Workspace.
 */
export function sanitizeProjectName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics becomes one dash
    .replace(/^-+|-+$/g, ""); // trim leading/trailing dashes

  if (slug.length === 0) {
    throw new Error(`Invalid Project name: '${raw}' has no usable characters.`);
  }
  return slug;
}

/**
 * The exact shape sanitizeProjectName produces: lowercase a–z / 0–9 / single
 * dashes. The Box enforces the same shape in Python, where this cannot be
 * imported (`box/bin/claudebox-session`, `box/terminal/paths.py`);
 * `test/projects.test.ts` compares all three patterns as text.
 */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Guard a slug that is about to be interpolated into a Box-side shell command
 * (workspace.ts). Slugs are always sanitizeProjectName output, but IPC could in
 * principle hand us anything — so re-validate at the effect boundary rather than
 * trust the caller. Defence in depth against shell injection into the Box.
 */
export function assertValidSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Unsafe Project slug: '${slug}'.`);
  }
  return slug;
}

