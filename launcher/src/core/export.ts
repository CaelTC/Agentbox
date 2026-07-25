import { join, resolve, sep } from "node:path";

/**
 * Export (ticket 07/08): a one-way, user-initiated copy of a Project's documents
 * out of the Box onto the user's computer — the mirror of Upload, and the first
 * Box→host path in the system (ADR 0003). This module holds every DECISION; the
 * Docker calls and the filesystem writes live in the effects layer.
 *
 * Four rules make the feature safe enough to exist:
 *   - only document-shaped files cross (threat C is reduced to the risk class of
 *     an email attachment — it is not eliminated);
 *   - what lands carries the host OS's own untrusted mark, so "the risk class of
 *     an email attachment" is literally true and not merely aspirational (#12);
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

/**
 * The Windows `Zone.Identifier` stream's body. Zone 3 is URLZONE_INTERNET —
 * the zone a browser download lands in, which is what makes Office open the
 * file in Protected View and SmartScreen evaluate it. CRLF and the trailing
 * newline are the format Explorer actually writes and parses.
 */
export const ZONE_IDENTIFIER_CONTENT = "[ZoneTransfer]\r\nZoneId=3\r\n";

/**
 * The macOS quarantine attribute's four semicolon-separated fields:
 * `flags;hex-epoch-seconds;agent;event-uuid`. `0001` is the download flag on its
 * own — deliberately none of the "user approved"/"assessment ok" bits, so
 * Gatekeeper still gets its say on what the Box wrote. The UUID names a row in
 * the LaunchServices quarantine database; the Launcher writes no row, so the
 * field is left empty, which is legal and is what plain `xattr -w` users do.
 */
const QUARANTINE_FLAGS = "0001";
const QUARANTINE_AGENT = "Claudebox";

export function quarantineValue(nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000).toString(16).padStart(8, "0");
  return `${QUARANTINE_FLAGS};${seconds};${QUARANTINE_AGENT};`;
}

/**
 * How this host marks a file as "came from somewhere else". A `stream` is a
 * plain file write (an NTFS alternate data stream is addressed as a path); a
 * `command` is spawned, because Node has no xattr API.
 */
export type UntrustedMark =
  | { readonly kind: "stream"; readonly path: string; readonly content: string }
  | { readonly kind: "command"; readonly command: string; readonly args: readonly string[] };

/**
 * The untrusted mark for one exported file (#12). Threat C's second layer used
 * to be `chmod 0o644` alone, which on Windows only toggles the read-only bit —
 * executability there is decided by extension — so the defence silently dropped
 * to the allowlist on half the platforms we ship to. Both hosts now get their
 * native mark instead, and the decision of WHICH is testable from either one.
 *
 * `undefined` for any other platform: the Launcher ships on macOS and Windows,
 * and a host whose mark we do not know must be reported as unmarked rather than
 * counted as a success (`ExportResult.unmarked`).
 */
export function untrustedMark(
  target: string,
  platform: NodeJS.Platform,
  nowMs: number,
): UntrustedMark | undefined {
  if (platform === "win32") {
    // Not path.join: the stream is a suffix on the file's own path, not a child.
    return { kind: "stream", path: `${target}:Zone.Identifier`, content: ZONE_IDENTIFIER_CONTENT };
  }
  if (platform === "darwin") {
    return {
      kind: "command",
      command: "xattr",
      args: ["-w", "com.apple.quarantine", quarantineValue(nowMs), target],
    };
  }
  return undefined;
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
  /**
   * How many of the saved files landed WITHOUT their untrusted mark (#12).
   * Surfaced rather than swallowed: the files are on the user's disk either way,
   * and a threat-C mitigation that quietly stopped applying is the thing this
   * whole change exists to prevent.
   */
  readonly unmarked: number;
}
