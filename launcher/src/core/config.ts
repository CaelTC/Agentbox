/**
 * Load-bearing constants for Agentbox. These encode the decisions from
 * ADR 0001 (the container is the permission boundary) and the ticket
 * acceptance criteria. They are pure data so they can be asserted in tests.
 *
 * This file is the declared source of truth, but three scripts that run without
 * the Launcher must carry their own copies (`install/install.sh`,
 * `install/install.ps1`, `scripts/agentbox.sh`). `test/config.test.ts` reads
 * those scripts and fails on any value that drifts from what is declared here.
 */

/** The tuned Engine allocation baked into the Launcher (see CONTEXT.md: Resource Cap). */
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

/**
 * Names the Colima profile on the Mac and the podman machine on Windows — one
 * host only ever runs one of them — so Agentbox is isolated from any other use
 * of either engine.
 */
export const ENGINE_PROFILE = "agentbox";

/**
 * The container engine's CLI (issue #10). The Mac drives Colima+Docker; Colima
 * does not exist on Windows and Docker Desktop reintroduces exactly the licence
 * Colima was chosen to avoid, so a Windows Launcher drives Podman instead.
 * Podman's CLI covers every verb the Launcher uses. One Box, one threat model —
 * only the host-side binary differs.
 *
 * `platform` is injectable so the Windows argv is assertable from a Mac.
 */
export function engineCli(platform: NodeJS.Platform = process.platform): "docker" | "podman" {
  return platform === "win32" ? "podman" : "docker";
}

export const ENGINE_CLI = engineCli();

/** The Box image tag and the long-lived container name. */
export const BOX_IMAGE = "agentbox:latest";
export const BOX_CONTAINER = "agentbox";

/** The unprivileged user everything in the Box runs as (`box/Dockerfile`). */
export const BOX_USER = "sandbox";

/**
 * PATH for everything the Launcher runs in the Box AS ROOT. The image's own
 * PATH puts /usr/local/cargo/bin — a directory the sandbox user can write —
 * FIRST, so resolving a bare `chown`/`rm`/`claude` through it as root would let
 * a compromised session plant a binary and escalate (root + NET_ADMIN can flush
 * the egress wall). Root needs nothing from the cargo toolchain, so root execs
 * carry this sanitized PATH instead of the image's.
 */
export const BOX_ROOT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The Workspace lives on a named Docker volume — NOT a host mount — so the Box
 * cannot see a single real file on the laptop (ADR 0001, threat A) yet work
 * survives stop/start.
 */
export const WORKSPACE_VOLUME = "agentbox-workspace";

/** Absolute path the Workspace volume is mounted at inside the Box. */
export const WORKSPACE_DIR = "/workspace";

/**
 * A named volume for the sandbox user's home, so the Login-with-Claude session
 * (and the pre-baked plugin) survive not just restarts but image rebuilds. It
 * holds only credentials that grant access to Claude itself (Credential Hygiene).
 */
export const HOME_VOLUME = "agentbox-home";

/** Where the home volume mounts — the sandbox user's home inside the Box. */
export const HOME_DIR = "/home/sandbox";

/**
 * Scratch volume bridging the two halves of "Save to GitHub" (ADR 0006). The
 * Workspace-side container writes a git bundle here; the credentialed container
 * reads it. The long-lived Box NEVER mounts this, and the credentialed container
 * never mounts the Workspace — that separation is the whole defence, and
 * `assertNoWorkspaceMount` enforces it.
 */
export const GIT_SCRATCH_VOLUME = "agentbox-git";

/** Where the scratch volume mounts inside both ephemeral publish containers. */
export const GIT_SCRATCH_DIR = "/scratch";

/**
 * The Database (CONTEXT.md): postgres in its own container beside the Box, on
 * an INTERNAL docker network. Internal is the wall — docker gives that network
 * no route out, so postgres cannot escape it, and nothing but the Box (attached
 * as a second interface) can reach it. The subnet is PINNED so the Egress
 * Policy can hold one static allow (DB_PORT to DB_SUBNET) instead of chasing
 * whatever docker allocates. The password is a fixed non-secret: the socket is
 * unreachable from the host, the LAN, and the internet by construction, and it
 * grants access to nothing but this DB (Credential Hygiene is untouched).
 */
export const DB_NETWORK = "agentbox-db";
export const DB_SUBNET = "172.30.0.0/24";
export const DB_CONTAINER = "agentbox-postgres";
export const DB_IMAGE = "postgres:16";
export const DB_VOLUME = "agentbox-postgres";
export const DB_PORT = 5432;

/**
 * The Agentbox OAuth App's client id (ADR 0006). Public by design — a client id
 * is not a credential, and the device flow explicitly sends no client secret, so
 * this stays consistent with ADR 0002's "no keys anywhere".
 *
 * Empty means no OAuth App has been registered yet: the Launcher then says so
 * rather than starting a device flow that can only fail. Register one with
 * "Enable Device Flow" ticked (otherwise GitHub answers `device_flow_disabled`)
 * and paste its client id here.
 */
export const GITHUB_CLIENT_ID = "Ov23limPFjpMgumhxfZI";

/** Public GitHub repo the Box definition is refreshed from (ADR 0002). */
export const DEFINITION_REPO = "https://github.com/CaelTC/Agentbox.git";

/**
 * The reviewed Box-definition commit to build. The definition IS the security
 * boundary and Refresh-on-Launch builds it automatically, so an unpinned build
 * trusts whatever upstream currently serves (a compromised repo/namespace would
 * silently redefine the walls — threat B). Set this to a maintainer-reviewed
 * commit SHA on each Box release: the Launcher will then refuse to build any
 * other HEAD and keep the last-known-good image. `undefined` = unpinned (the
 * runner logs a warning). A pinned commit is NOT a credential — it stays
 * consistent with ADR 0002's "no keys".
 */
export const PINNED_DEFINITION_COMMIT: string | undefined = undefined;
