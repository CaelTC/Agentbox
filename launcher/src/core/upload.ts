import { copyFileSync, existsSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

/**
 * Upload (ticket 06): a one-way, user-initiated copy of files from the MacBook
 * into a Project's Workspace. The Launcher (trusted host code) picks the files
 * via a native dialog; this module decides where each lands and performs the
 * copy. Two invariants (ADR 0001, threat A):
 *   - destinations are ALWAYS inside the Project (only the basename is used);
 *   - it is a COPY, never a bind mount or symlink — the Box gets no path back
 *     to the host filesystem.
 */
export interface UploadTarget {
  readonly source: string;
  readonly dest: string;
}

/** Split "notes.txt" -> {stem:"notes", ext:".txt"}; "archive.tar.gz" keeps only the last ext. */
function splitName(name: string): { stem: string; ext: string } {
  const ext = extname(name);
  return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}

export interface ResolveUploadOptions {
  /**
   * Predicate for whether a destination is already occupied. Defaults to the
   * host filesystem; the Launcher injects a Box-backed check when the Workspace
   * lives on a named volume (no host mirror to stat).
   */
  exists?: (path: string) => boolean;
}

export function resolveUploadTargets(
  sources: string[],
  projectDir: string,
  options: ResolveUploadOptions = {},
): UploadTarget[] {
  const base = resolve(projectDir);
  const exists = options.exists ?? existsSync;
  const taken = new Set<string>();
  const targets: UploadTarget[] = [];

  for (const source of sources) {
    // Only the basename crosses the boundary — a crafted "../../x" can't escape.
    const { stem, ext } = splitName(basename(source));

    let candidate = join(base, `${stem}${ext}`);
    let n = 1;
    while (taken.has(candidate) || exists(candidate)) {
      n += 1;
      candidate = join(base, `${stem}-${n}${ext}`);
    }

    // Defence in depth: the join above can only produce a path inside `base`,
    // but assert it so any future change can't silently break the invariant.
    if (!(candidate === base || candidate.startsWith(base + sep))) {
      throw new Error(`Refusing to write '${candidate}' outside the Project.`);
    }

    taken.add(candidate);
    targets.push({ source, dest: candidate });
  }

  return targets;
}

/** Resolve targets and copy each file. Returns what was written. */
export function performUpload(sources: string[], projectDir: string): UploadTarget[] {
  const targets = resolveUploadTargets(sources, projectDir);
  for (const { source, dest } of targets) {
    copyFileSync(source, dest); // a real copy: independent bytes, no link back
  }
  return targets;
}
