import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BOX_IMAGE } from "../core/config";
import { hashDefinition, refreshDecision, type DefinitionFile } from "../core/refresh";
import { run, runOk } from "./exec";
import { claudeboxHome, hostBoxDefinitionDir, hostDefinitionDir } from "./paths";

/**
 * Refresh on Launch (ticket 09 / ADR 0002): on every start, pull the latest Box
 * definition from the PUBLIC repo and rebuild the image only if it changed.
 * Stays usable offline. The DECISION is the pure refreshDecision(); this runner
 * supplies the effects (git pull, hash, docker build).
 */
export interface RefreshResult {
  action: "rebuilt" | "started" | "error";
  reason: string;
}

const hashFile = () => join(claudeboxHome(), "image.hash");

export async function refreshOnLaunch(): Promise<RefreshResult> {
  const previousHash = readStoredHash();

  // Pull from the public repo (HTTPS, no credentials). Failure ⇒ treat as offline.
  const online = await runOk("git", ["-C", hostDefinitionDir(), "pull", "--ff-only"]);
  const currentHash = online ? hashDefinition(readDefinitionFiles()) : undefined;

  const decision = refreshDecision({ previousHash, currentHash, online });

  switch (decision.action) {
    case "rebuild": {
      const built = await run("docker", ["build", "-t", BOX_IMAGE, hostBoxDefinitionDir()]);
      if (built.code !== 0) {
        return { action: "error", reason: `Box rebuild failed: ${built.stderr}` };
      }
      if (currentHash) writeStoredHash(currentHash);
      return { action: "rebuilt", reason: decision.reason };
    }
    case "start":
      return { action: "started", reason: decision.reason };
    case "error":
      return { action: "error", reason: decision.reason };
  }
}

function readStoredHash(): string | undefined {
  const path = hashFile();
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

function writeStoredHash(hash: string): void {
  writeFileSync(hashFile(), hash);
}

/** Read every file under the Box definition dir as {path, content} for hashing. */
function readDefinitionFiles(): DefinitionFile[] {
  const base = hostBoxDefinitionDir();
  const files: DefinitionFile[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && statSync(p).size < 1_000_000) {
        files.push({ path: relative(base, p), content: readFileSync(p, "utf8") });
      }
    }
  };
  walk(base);
  return files;
}
