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
