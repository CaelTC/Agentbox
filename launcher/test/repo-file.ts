import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One file from the repository, named by its path from the ROOT — `repoFile("box",
 * "Dockerfile")`, `repoFile("launcher", "src", "renderer", "app.ts")`.
 *
 * The drift tests all read sources this way, and each had grown its own private
 * spelling (`src`, `boxFile`, `repoFile`, inline `readFileSync`) with its own
 * hard-coded `..` depth. Moving a test file broke each one differently; the depth
 * is written once, here.
 */
export const repoFile = (...parts: string[]) =>
  readFileSync(join(__dirname, "..", "..", ...parts), "utf8");

/**
 * The names in one directory of the repository, sorted. A drift test that has to
 * cover EVERY file of a kind (every renderer script, say) enumerates them rather
 * than listing them, so a file added tomorrow is covered without an edit here.
 */
export const repoDir = (...parts: string[]) =>
  readdirSync(join(__dirname, "..", "..", ...parts)).sort();
