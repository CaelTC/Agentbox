import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BOX_IMAGE, DEFINITION_REPO, ENGINE_CLI, PINNED_DEFINITION_COMMIT } from "../core/config";
import { commitTrusted, hashDefinition, refreshDecision, type DefinitionFile } from "../core/refresh";
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
      // Integrity gate (threat B): never auto-build a definition we don't trust.
      // Fail CLOSED — on any doubt keep the last-known-good image if we have one,
      // else surface an error rather than build something unverified.
      const untrusted = await definitionDistrustReason();
      if (untrusted) {
        return previousHash === undefined
          ? { action: "error", reason: untrusted }
          : { action: "started", reason: `${untrusted} Keeping the last-built Box image.` };
      }

      const built = await run(ENGINE_CLI, ["build", "-t", BOX_IMAGE, hostBoxDefinitionDir()]);
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

/**
 * Return a reason string if the pulled definition must NOT be trusted for an
 * auto-build, or undefined if it's safe. Checks (a) the origin remote is exactly
 * the expected public repo — a repointed origin could feed a malicious
 * definition — and (b) the pulled HEAD matches PINNED_DEFINITION_COMMIT when a
 * pin is configured. An unpinned boundary is allowed but logged.
 */
async function definitionDistrustReason(): Promise<string | undefined> {
  const dir = hostDefinitionDir();

  const origin = (await run("git", ["-C", dir, "config", "--get", "remote.origin.url"])).stdout.trim();
  if (origin && origin !== DEFINITION_REPO) {
    return `Refusing to build: the Box definition's origin is '${origin}', not the expected ${DEFINITION_REPO}.`;
  }

  const head = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() || undefined;
  if (!commitTrusted(PINNED_DEFINITION_COMMIT, head)) {
    return `Refusing to build: definition HEAD ${head ?? "(unknown)"} does not match the pinned commit ${PINNED_DEFINITION_COMMIT}.`;
  }
  if (!PINNED_DEFINITION_COMMIT) {
    console.warn(
      "Refresh on Launch: Box definition is UNPINNED — building whatever upstream serves. " +
        "Set PINNED_DEFINITION_COMMIT to a reviewed commit to close this (threat B).",
    );
  }
  return undefined;
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
