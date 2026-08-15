import type { Harness } from "./config";

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
   * out. Filled host-side from the Export stamp in the landing folder
   * (`SAVED_STAMP`, main/workspace.ts) — it costs no Box call, which is why the
   * home screen can say it for every Project at once. Absent from a Project the
   * Box just created.
   */
  readonly lastSaved?: number;
}

/** Persisted per-Project metadata, written into the Box by main/workspace.ts. */
export interface ProjectMeta {
  name: string;
  slug: string;
  seedPrompt?: string;
  /**
   * Which coding agent the Box-side funnel launches for this Project
   * (`box/bin/agentbox-session`). Absent means the default harness, which is
   * also the funnel's own default — so the Launcher stamps this key only when
   * the setting says something else, and a Project nobody has opened under a
   * different harness keeps the metadata it was created with.
   */
  agent?: Harness;
}

export const META_DIR = ".agentbox";
export const META_FILE = "project.json";

/** Relative path of a Project's metadata file, from the Project directory. */
export const metaRelPath = `${META_DIR}/${META_FILE}`;

export function serializeProjectMeta(meta: ProjectMeta): string {
  // Rebuilt rather than serialized as given: an absent optional key is what both
  // sides read as "the default", so writing `"agent": undefined`-shaped noise —
  // or carrying a stray key some other build wrote — is not the same file.
  const trimmed: ProjectMeta = { name: meta.name, slug: meta.slug };
  if (meta.seedPrompt) trimmed.seedPrompt = meta.seedPrompt;
  if (meta.agent) trimmed.agent = meta.agent;
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
 * imported (`box/bin/agentbox-session`, `box/terminal/paths.py`);
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

