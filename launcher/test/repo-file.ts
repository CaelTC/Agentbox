import { readFileSync } from "node:fs";
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
