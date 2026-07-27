import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BOX_IMAGE, DEFINITION_REPO, ENGINE_CLI, PINNED_DEFINITION_COMMIT } from "../core/config";
import {
  buildMessage,
  commitTrusted,
  hashDefinition,
  refreshDecision,
  updateMessage,
  type DefinitionFile,
  type RefreshResult,
} from "../core/refresh";
import type { OnStep } from "../core/startup";
import { failureMessage, run } from "./exec";
import { claudeboxHome, hostBoxDefinitionDir, hostDefinitionDir } from "./paths";
import { ensureBoxReady, ensureEngine, removeBoxContainer, updateClaudeCode } from "./session";

/**
 * Refresh on Launch (ticket 09 / ADR 0002): on every start, pull the latest Box
 * definition from the PUBLIC repo and rebuild the image only if it changed.
 * Stays usable offline. The DECISION is the pure refreshDecision(); this runner
 * supplies the effects (git pull, hash, docker build).
 *
 * Also runs on demand, from "Update Claudebox" on the home screen — same pull,
 * same gate, same build. What that button adds around this call is
 * `updateClaudebox()` below, not something the IPC router assembles.
 */
const hashFile = () => join(claudeboxHome(), "image.hash");

export async function refreshOnLaunch(onStep?: OnStep): Promise<RefreshResult> {
  const previousHash = readStoredHash();

  // Get the public definition onto the host (HTTPS, no credentials). Failure ⇒
  // treat as offline: the last-built image keeps running (ADR 0002).
  onStep?.("Checking for updates…");
  const online = await fetchDefinition();
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
          ? { action: "error", reason: untrusted, online }
          : { action: "blocked", reason: `${untrusted} Keeping the last-built Box image.`, online };
      }

      onStep?.(buildMessage(previousHash === undefined));
      const built = await run(ENGINE_CLI, ["build", "-t", BOX_IMAGE, hostBoxDefinitionDir()]);
      if (built.code !== 0) {
        // Through `failureMessage` like every other failed command, rather than
        // pasting the whole build log into a reason that now reaches a screen:
        // this is the one composer that bounds what a Sandbox User is shown.
        return { action: "error", reason: failureMessage("Box rebuild", built), online };
      }
      if (currentHash) writeStoredHash(currentHash);
      return {
        action: "rebuilt",
        reason: decision.reason,
        online,
        unpinned: !PINNED_DEFINITION_COMMIT,
      };
    }
    case "start":
      return { action: "started", reason: decision.reason, online };
    case "error":
      return { action: "error", reason: decision.reason, online };
  }
}

/**
 * The Box lifecycle "Update Claudebox" drives, as an injectable seam. Every
 * member is a real Engine call in production; passing a fake is what makes the
 * SEQUENCE below assertable without an Engine, a Box, or a window.
 */
export interface UpdateSteps {
  /** The same pull + integrity gate + conditional build as Refresh on Launch. */
  refresh(): Promise<RefreshResult>;
  ensureEngine(): Promise<void>;
  removeBoxContainer(): Promise<void>;
  ensureBoxReady(): Promise<void>;
  updateClaudeCode(): Promise<boolean>;
}

const engineSteps: UpdateSteps = {
  refresh: refreshOnLaunch,
  ensureEngine,
  removeBoxContainer,
  ensureBoxReady: () => ensureBoxReady(hostBoxDefinitionDir()),
  updateClaudeCode,
};

/**
 * Update Claudebox (ADR 0002): Refresh on Launch, on a button. Same pull, same
 * integrity gate, same conditional build — what this adds is the RECREATE,
 * because a rebuilt image does nothing while the old container is still the one
 * running (the same two lines bootstrap does).
 *
 * Nothing is recreated unless the refresh actually rebuilt: an "already up to
 * date" must not end anyone's open Claude session. The caller confirms first —
 * the recreate closes every session — and that confirmation is the router's
 * native dialog, which is why it is not in here.
 *
 * Returns the sentence to show, composed by the tested `updateMessage`.
 */
export async function updateClaudebox(steps: UpdateSteps = engineSteps): Promise<string> {
  await steps.ensureEngine(); // the build needs the Engine, exactly as at launch
  const result = await steps.refresh();
  if (result.action !== "rebuilt") return updateMessage(result);

  await steps.removeBoxContainer();
  await steps.ensureBoxReady();
  // A recreate drops back to the Claude Code baked into the image, which the
  // Dockerfile's cached npm layer can leave months old — so without this an
  // "update" could hand back an older Claude than the one just running.
  if (!(await steps.updateClaudeCode())) {
    console.warn("Claude Code update skipped; keeping the version baked into the Box image.");
  }
  return updateMessage(result);
}

/**
 * Put the public definition on the host and bring it up to date: CLONE it when
 * it isn't there, pull it when it is.
 *
 * The clone is not a convenience. The Install Script clones this too, but the
 * Launcher cannot assume the Install Script ran — a machine that got Claudebox
 * any other way (a repo checkout, a copied .app, a `~/.claudebox` that lost the
 * folder) has no clone, and then every `git -C <missing dir> pull` fails, is read
 * as "offline", and the SOLE update mechanism silently never runs again. That is
 * a permanently stale Box, and a stale Box is a stale `apply-egress.sh`.
 *
 * False means the definition could not be fetched — the offline case
 * refreshDecision is built around. git's own words are logged either way,
 * because "offline" is the diagnosis that hides every other reason a pull fails
 * (no upstream, a diverged clone, git missing from a GUI app's PATH).
 */
async function fetchDefinition(): Promise<boolean> {
  const dir = hostDefinitionDir();
  const cloning = !existsSync(join(dir, ".git"));

  try {
    mkdirSync(claudeboxHome(), { recursive: true });
    const result = cloning
      ? // Shallow: the Launcher builds the definition, it never needs its history.
        await run("git", ["clone", "--depth", "1", DEFINITION_REPO, dir])
      : await run("git", ["-C", dir, "pull", "--ff-only"]);

    if (result.code === 0) return true;
    console.warn(
      `Refresh on Launch: could not ${cloning ? "clone" : "pull"} the Box definition ` +
        `into ${dir}: ${result.stderr.trim()}`,
    );
  } catch (error) {
    // `run` rejects when the binary isn't there at all — git missing from the
    // PATH a Finder-launched app inherits looks exactly like being offline.
    console.warn(`Refresh on Launch: could not run git: ${String(error)}`);
  }
  return false;
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
