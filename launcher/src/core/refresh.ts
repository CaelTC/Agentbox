import { createHash } from "node:crypto";

/**
 * Refresh on Launch (ticket 09 / ADR 0002): on every start the Launcher pulls
 * the latest Box definition from the PUBLIC repo and rebuilds the image only if
 * it changed. No credentials are involved anywhere — the repo is public.
 *
 * This module is the pure decision logic: hash the definition, decide whether a
 * rebuild is warranted, and stay usable offline.
 */
export interface DefinitionFile {
  path: string;
  content: string;
}

/** A stable content hash of the whole Box definition, order-independent. */
export function hashDefinition(files: readonly DefinitionFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    // Length-prefix each field so ("ab","c") can't collide with ("a","bc").
    hash.update(`${f.path.length}:${f.path}\n${f.content.length}:${f.content}\n`);
  }
  return hash.digest("hex");
}

/** Rebuild if we've never built (no previous hash) or the definition changed. */
export function shouldRebuild(previousHash: string | undefined, currentHash: string): boolean {
  return previousHash === undefined || previousHash !== currentHash;
}

/**
 * Is the pulled definition trusted enough to auto-build? The definition IS the
 * security boundary (it ships apply-egress.sh / entrypoint.sh), and Refresh
 * builds it automatically — so a compromised upstream would silently redefine
 * the walls. When a commit is pinned (config.PINNED_DEFINITION_COMMIT, set to a
 * reviewed commit), the pulled HEAD must match it exactly; otherwise we refuse
 * to build and keep running the last-known-good image. No pin ⇒ trust the pull
 * (the runner logs that the boundary is unpinned).
 */
export function commitTrusted(pinned: string | undefined, head: string | undefined): boolean {
  if (!pinned) return true;
  return head !== undefined && head === pinned;
}

export interface RefreshInputs {
  /** Hash of the image we last built, if any. */
  previousHash: string | undefined;
  /** Hash of the freshly-pulled definition; undefined when offline (no pull). */
  currentHash: string | undefined;
  /** Whether the pull succeeded / the machine is online. */
  online: boolean;
}

export type RefreshAction = "rebuild" | "start" | "error";

export interface RefreshOutcome {
  action: RefreshAction;
  reason: string;
}

/**
 * Decide what the Launcher should do on start.
 *  - offline with a prior image  -> start it (an offline machine keeps running
 *    its last-built image, ADR 0002).
 *  - offline with no image       -> error (first run needs the network once).
 *  - online + changed/first      -> rebuild.
 *  - online + unchanged          -> start quickly.
 */
export function refreshDecision(inputs: RefreshInputs): RefreshOutcome {
  const { previousHash, currentHash, online } = inputs;

  if (!online || currentHash === undefined) {
    if (previousHash === undefined) {
      return {
        action: "error",
        reason: "Offline and no Box image has ever been built — connect once to set up Claudebox.",
      };
    }
    return { action: "start", reason: "Offline; starting the last-built Box image." };
  }

  if (shouldRebuild(previousHash, currentHash)) {
    return {
      action: "rebuild",
      reason:
        previousHash === undefined
          ? "First launch; building the Box image."
          : "Box definition changed upstream; rebuilding.",
    };
  }

  return { action: "start", reason: "Box definition unchanged; starting quickly." };
}

/**
 * What one run of the refresh actually did. Reported to the renderer as well as
 * to the console, because Refresh is no longer only a launch step: "Update
 * Claudebox" runs the same thing on a button, and then someone is waiting to be
 * told whether they got the new version.
 */
export interface RefreshResult {
  /**
   * `blocked` is the integrity gate declining to build (a repointed origin, or a
   * HEAD that isn't the pinned commit) while a last-known-good image keeps
   * running — a refusal, not a failure, and never silent.
   */
  action: "rebuilt" | "started" | "blocked" | "error";
  reason: string;
  /** False when the definition couldn't be pulled at all — offline, or a clone that won't fast-forward. */
  online: boolean;
}

/**
 * The sentence the Sandbox User sees after clicking "Update Claudebox". The
 * `reason` strings above are written for a launch log ("starting quickly"), which
 * is the wrong voice for someone who just asked a question and wants the answer.
 * A refusal is the exception: it is passed through verbatim, because a gate that
 * says only "no" teaches nobody what tripped it.
 */
export function updateMessage(result: RefreshResult): string {
  switch (result.action) {
    case "rebuilt":
      return "Claudebox is up to date. The sandbox restarted on the new version.";
    case "blocked":
      return result.reason;
    case "error":
      return `Couldn't update Claudebox: ${result.reason}`;
    case "started":
      return result.online
        ? "Claudebox is already up to date."
        : "Couldn't fetch the latest Claudebox, so it's still on the version it had.";
  }
}
