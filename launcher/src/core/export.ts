import { join, resolve, sep } from "node:path";

/**
 * Export (ticket 07/08): a one-way, user-initiated copy of a Project's documents
 * out of the Box onto the MacBook — the mirror of Upload, and the first Box→host
 * path in the system (ADR 0003). This module holds every DECISION; the Docker
 * calls and the filesystem writes live in the effects layer.
 *
 * Three rules make the feature safe enough to exist:
 *   - only document-shaped files cross (threat C is reduced to the risk class of
 *     an email attachment — it is not eliminated);
 *   - the total is bounded, because an unbounded copy onto the user's real disk
 *     is threat A by name;
 *   - every path that reaches a host write is asserted inside the landing root,
 *     because both the friendly Project name and the renderer's selection are
 *     untrusted input.
 */

/**
 * Ceiling on one Export. The Resource Cap bounds the Box at ~25 GB; without a
 * ceiling here a runaway Project could pour that onto the host.
 * ponytail: a flat 2 GiB is plenty for document-shaped output — make it a
 * preference the day someone legitimately needs more.
 */
export const EXPORT_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Documents plus web files, so a "personal webpage" Project is useful when it
 * lands. Deliberately no source code, archives or binaries: anything that is not
 * here is shown to the user with a reason rather than silently dropped.
 */
const EXPORTABLE_EXTENSIONS = new Set([
  // documents
  "txt", "md", "markdown", "rtf", "pdf", "doc", "docx", "odt",
  "csv", "tsv", "xls", "xlsx", "ods", "ppt", "pptx", "odp",
  // structured text people actually open
  "json", "xml", "yaml", "yml",
  // web files — a built page has to keep working on the host
  "html", "htm", "css", "js", "mjs",
  // images a page or a document refers to
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico",
]);

/** One regular file inside a Project, as enumerated inside the Box. */
export interface BoxFile {
  /** Path relative to the Project directory, e.g. "site/css/styles.css". */
  readonly path: string;
  readonly size: number;
  /** True if any executable bit is set on the file inside the Box. */
  readonly executable: boolean;
}

/**
 * Parse the Box's file listing — one `mode<TAB>size<TAB>path` line per regular
 * file, as `find -printf '%m\t%s\t%P\n'` emits it. Lines that don't parse are
 * dropped rather than guessed at: this is Box-side output feeding a host copy.
 */
export function parseBoxFileListing(stdout: string): BoxFile[] {
  const files: BoxFile[] = [];
  for (const line of stdout.split("\n")) {
    const [mode, size, ...rest] = line.split("\t");
    const path = rest.join("\t"); // a tab in a filename must not shift the fields
    const bytes = Number(size);
    if (!mode || !path || !Number.isFinite(bytes)) continue;

    const bits = parseInt(mode, 8);
    if (!Number.isFinite(bits)) continue;
    files.push({ path, size: bytes, executable: (bits & 0o111) !== 0 });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export type ExportVerdict =
  | { readonly exportable: true; readonly reason?: undefined }
  | { readonly exportable: false; readonly reason: string };

const OK: ExportVerdict = { exportable: true };
const no = (reason: string): ExportVerdict => ({ exportable: false, reason });

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : "";
}

/**
 * Decide whether one file may cross onto the host, and say why not in words a
 * Sandbox User can act on. Reasons are ordered most-specific-first so the user
 * is told the real obstacle, not just "wrong file type".
 */
export function classifyBoxFile(file: BoxFile): ExportVerdict {
  const segments = file.path.split("/");

  if (file.path.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
    return no("This file is not inside the Project.");
  }
  if (segments.some((s) => s.startsWith("."))) {
    return no("Hidden files aren't saved.");
  }
  if (segments.some((s) => s === "node_modules")) {
    return no("Program libraries aren't saved.");
  }
  if (file.executable) {
    return no("Programs aren't saved.");
  }
  if (!EXPORTABLE_EXTENSIONS.has(extensionOf(file.path))) {
    return no("Only documents and web files can be saved.");
  }
  return OK;
}

/** C0/C1 control characters — stripped before a Box-written name reaches a host path. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Turn a friendly Project name into a host folder name. Unlike the Project slug
 * this keeps spaces, capitals and accents — it is what the Sandbox User sees in
 * Finder. The name is read from `.claudebox/project.json` INSIDE the Box, so
 * Claude can write it: strip everything that could steer a filesystem path, and
 * fall back to the (already validated) slug if nothing usable is left.
 */
export function exportFolderName(name: string, slug: string): string {
  const safe = name
    .replace(CONTROL_CHARS, "")
    .replace(/[/\\:]/g, " ") // path separators, and ":" which Finder treats as one
    .replace(/\.{2,}/g, ".") // no "..", however the name spelled it
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "") // no leading dots: an exported Project is never hidden
    .replace(/[.\s]+$/, ""); // macOS dislikes trailing dots and spaces

  return safe.length > 0 ? safe : slug;
}

export interface ProjectIdentity {
  readonly name: string;
  readonly slug: string;
}

/**
 * Where a Project's files land on the host. Two Projects whose names sanitize
 * alike are disambiguated by slug, which is unique by construction.
 */
export function resolveExportDir(
  exportRoot: string,
  project: ProjectIdentity,
  allProjects: readonly ProjectIdentity[] = [],
): string {
  const base = resolve(exportRoot);
  let folder = exportFolderName(project.name, project.slug);

  const clashes = allProjects.some(
    (p) => p.slug !== project.slug && exportFolderName(p.name, p.slug) === folder,
  );
  if (clashes) folder = `${folder} (${project.slug})`;

  const dir = resolve(base, folder);
  // The sanitizer above can only produce a single path segment, but assert it:
  // this is the boundary between Box-written text and a host filesystem write.
  if (dir !== join(base, folder) || !dir.startsWith(base + sep)) {
    throw new Error(`Refusing to save '${project.slug}' outside '${base}'.`);
  }
  return dir;
}

/** Resolve one file's landing path, refusing anything outside the Project's folder. */
export function resolveExportTarget(exportDir: string, relPath: string): string {
  const base = resolve(exportDir);
  const target = resolve(base, relPath);
  if (!target.startsWith(base + sep)) {
    throw new Error(`Refusing to save '${relPath}' outside '${base}'.`);
  }
  return target;
}

export interface ExportCandidate extends BoxFile {
  readonly exportable: boolean;
  /** Why this file cannot be saved — shown to the user, absent when exportable. */
  readonly reason?: string;
}

export interface ExportPlan {
  /** Every file the Box listed, classified. Refused ones stay visible. */
  readonly candidates: readonly ExportCandidate[];
  /** The files that will actually be copied. */
  readonly selected: readonly ExportCandidate[];
  /** Bytes of `selected`. */
  readonly totalBytes: number;
  /** How many listed files are not being saved. */
  readonly skipped: number;
  readonly capBytes: number;
  readonly overCap: boolean;
}

/**
 * Classify a Project's files and work out what crosses.
 *
 * `pick` is the renderer's ticked list (ticket 08) and is treated as input, not
 * truth: a ticked path is only ever honoured if the Box listed it AND it passes
 * the classifier. Omit it to select everything exportable (ticket 07).
 */
export function planExport(files: readonly BoxFile[], pick?: readonly string[]): ExportPlan {
  const wanted = pick && new Set(pick);

  const candidates = files.map((file): ExportCandidate => {
    const verdict = classifyBoxFile(file);
    return { ...file, exportable: verdict.exportable, reason: verdict.reason };
  });

  const selected = candidates.filter((c) => c.exportable && (!wanted || wanted.has(c.path)));
  const totalBytes = selected.reduce((sum, c) => sum + c.size, 0);

  return {
    candidates,
    selected,
    totalBytes,
    skipped: candidates.length - selected.length,
    capBytes: EXPORT_CAP_BYTES,
    overCap: totalBytes > EXPORT_CAP_BYTES,
  };
}

export interface ExportListing {
  /** Every file in the Project, exportable or not, each with its reason. */
  readonly files: readonly ExportCandidate[];
  /** The host folder these files would land in. */
  readonly dir: string;
  /** Ceiling on one Export — the running total is shown against this. */
  readonly capBytes: number;
}

/** What one Export actually did, for the confirmation the Sandbox User sees. */
export interface ExportResult {
  /** The host folder the files landed in. */
  readonly dir: string;
  readonly saved: number;
  readonly skipped: number;
  readonly totalBytes: number;
  readonly capBytes: number;
  /** True when the Export was refused for size — nothing at all was written. */
  readonly overCap: boolean;
}
