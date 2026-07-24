/**
 * Load-bearing constants for Claudebox. These encode the decisions from
 * ADR 0001 (the container is the permission boundary) and the ticket
 * acceptance criteria. They are pure data so they can be asserted in tests.
 */

/** The tuned Colima allocation baked into the Launcher (see CONTEXT.md: Resource Cap). */
export interface ResourceCap {
  /** CPU cores. */
  readonly cpu: number;
  /** RAM in gibibytes. */
  readonly memoryGiB: number;
  /** Disk ceiling in gibibytes — bounds threat A on the host. */
  readonly diskGiB: number;
}

export const RESOURCE_CAP: ResourceCap = {
  cpu: 4,
  memoryGiB: 6,
  diskGiB: 25,
};

/** Colima profile that isolates Claudebox from any other Colima use on the Mac. */
export const COLIMA_PROFILE = "claudebox";

/** The Box image tag and the long-lived container name. */
export const BOX_IMAGE = "claudebox:latest";
export const BOX_CONTAINER = "claudebox";

/**
 * The Workspace lives on a named Docker volume — NOT a host mount — so the Box
 * cannot see a single real file on the laptop (ADR 0001, threat A) yet work
 * survives stop/start.
 */
export const WORKSPACE_VOLUME = "claudebox-workspace";

/** Absolute path the Workspace volume is mounted at inside the Box. */
export const WORKSPACE_DIR = "/workspace";

/**
 * A named volume for the sandbox user's home, so the Login-with-Claude session
 * (and the pre-baked plugin) survive not just restarts but image rebuilds. It
 * holds only credentials that grant access to Claude itself (Credential Hygiene).
 */
export const HOME_VOLUME = "claudebox-home";

/** Where the home volume mounts — the sandbox user's home inside the Box. */
export const HOME_DIR = "/home/sandbox";

/** Public GitHub repo the Box definition is refreshed from (ADR 0002). */
export const DEFINITION_REPO = "https://github.com/claudebox/claudebox.git";
