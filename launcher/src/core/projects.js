import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
export const META_DIR = ".claudebox";
export const META_FILE = "project.json";
/** Relative path of a Project's metadata file, from the Project directory. */
export const metaRelPath = `${META_DIR}/${META_FILE}`;
export function serializeProjectMeta(meta) {
    const trimmed = meta.seedPrompt
        ? { name: meta.name, slug: meta.slug, seedPrompt: meta.seedPrompt }
        : { name: meta.name, slug: meta.slug };
    return JSON.stringify(trimmed, null, 2);
}
export function parseProjectMeta(json) {
    try {
        return JSON.parse(json);
    }
    catch {
        return undefined;
    }
}
/**
 * Turn a friendly name into a safe folder slug. Rejects names that reduce to
 * nothing, and can never produce a `..` or path separator — so a Project can
 * never escape the Workspace.
 */
export function sanitizeProjectName(raw) {
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
/** The exact shape sanitizeProjectName produces: lowercase a–z / 0–9 / single dashes. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Guard a slug that is about to be interpolated into a Box-side shell command
 * (workspace.ts). Slugs are always sanitizeProjectName output, but IPC could in
 * principle hand us anything — so re-validate at the effect boundary rather than
 * trust the caller. Defence in depth against shell injection into the Box.
 */
export function assertValidSlug(slug) {
    if (!SLUG_RE.test(slug)) {
        throw new Error(`Unsafe Project slug: '${slug}'.`);
    }
    return slug;
}
/** Safely resolve a Project slug to a directory, refusing anything outside the Workspace. */
export function resolveProjectDir(workspaceDir, slug) {
    const base = resolve(workspaceDir);
    const dir = resolve(base, slug);
    if (dir !== join(base, slug) || !(dir === base || dir.startsWith(base + sep))) {
        throw new Error(`Refusing to resolve '${slug}' outside the Workspace.`);
    }
    return dir;
}
export function createProject(workspaceDir, name, options = {}) {
    const slug = sanitizeProjectName(name);
    const dir = resolveProjectDir(workspaceDir, slug);
    if (existsSync(dir)) {
        throw new Error(`A Project already exists at '${slug}'.`);
    }
    mkdirSync(dir, { recursive: true });
    const metaDir = join(dir, META_DIR);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, META_FILE), serializeProjectMeta({ name, slug, seedPrompt: options.seedPrompt }));
    return { name, slug, dir };
}
function readMeta(dir) {
    const path = join(dir, META_DIR, META_FILE);
    if (!existsSync(path))
        return undefined;
    return parseProjectMeta(readFileSync(path, "utf8"));
}
/** List Projects in the Workspace, newest naming preserved. Ignores loose files and dotfiles. */
export function listProjects(workspaceDir) {
    const base = resolve(workspaceDir);
    if (!existsSync(base))
        return [];
    return readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => {
        const dir = join(base, e.name);
        const meta = readMeta(dir);
        return {
            name: meta?.name ?? e.name,
            slug: e.name,
            dir,
        };
    })
        .sort((a, b) => a.slug.localeCompare(b.slug));
}
/** Read a Project's seeded first prompt, if any (ticket 08). */
export function projectSeedPrompt(workspaceDir, slug) {
    return readMeta(resolveProjectDir(workspaceDir, slug))?.seedPrompt;
}
