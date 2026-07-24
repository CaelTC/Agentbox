import { copyFileSync, existsSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
/** Split "notes.txt" -> {stem:"notes", ext:".txt"}; "archive.tar.gz" keeps only the last ext. */
function splitName(name) {
    const ext = extname(name);
    return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}
export function resolveUploadTargets(sources, projectDir, options = {}) {
    const base = resolve(projectDir);
    const exists = options.exists ?? existsSync;
    const taken = new Set();
    const targets = [];
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
export function performUpload(sources, projectDir) {
    const targets = resolveUploadTargets(sources, projectDir);
    for (const { source, dest } of targets) {
        copyFileSync(source, dest); // a real copy: independent bytes, no link back
    }
    return targets;
}
