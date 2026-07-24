import {
  BOX_CONTAINER,
  BOX_IMAGE,
  HOME_DIR,
  HOME_VOLUME,
  WORKSPACE_DIR,
  WORKSPACE_VOLUME,
} from "./config";
import { PREVIEW_PORTS, loopbackPublishArgs } from "./preview";

export interface BoxBuildOptions {
  /** Directory containing the Box's Dockerfile (the checked-in `box/` dir). */
  contextDir: string;
  image?: string;
}

export function boxBuildArgs({ contextDir, image = BOX_IMAGE }: BoxBuildOptions): string[] {
  return ["build", "-t", image, contextDir];
}

export interface BoxRunOptions {
  image?: string;
  container?: string;
  volume?: string;
  workspaceDir?: string;
  homeVolume?: string;
  homeDir?: string;
  /** Preview ports to publish, each bound to loopback (ticket 07). */
  previewPorts?: readonly number[];
}

/**
 * Build the `docker run` args for the long-lived Box container.
 *
 * Invariants (ADR 0001):
 *  - the Workspace is a NAMED VOLUME, never a host bind mount (threat A);
 *  - the container stays alive (`sleep infinity`) so Claude sessions are
 *    exec'd into it and survive individual session exits.
 */
export function boxRunArgs(options: BoxRunOptions = {}): string[] {
  const {
    image = BOX_IMAGE,
    container = BOX_CONTAINER,
    volume = WORKSPACE_VOLUME,
    workspaceDir = WORKSPACE_DIR,
    homeVolume = HOME_VOLUME,
    homeDir = HOME_DIR,
    previewPorts = PREVIEW_PORTS,
  } = options;

  const args = [
    "run",
    "-d",
    "--name",
    container,
    // Grant the capability the egress firewall needs to install its rules,
    // without granting broad privilege.
    "--cap-add",
    "NET_ADMIN",
    // Publish preview ports on loopback so the Mac's browser can reach a served
    // page, without exposing the Box to the LAN (ticket 07).
    ...loopbackPublishArgs(previewPorts),
    // Workspace (the user's work) and home (the Claude login) both persist as
    // NAMED VOLUMES — never host mounts (ADR 0001, threat A).
    "-v",
    `${volume}:${workspaceDir}`,
    "-v",
    `${homeVolume}:${homeDir}`,
    image,
    "sleep",
    "infinity",
  ];
  assertNoHostMounts(args);
  return args;
}

export interface ClaudeExecOptions {
  container?: string;
  /** Project working directory inside the Box (ticket 05). */
  cwd?: string;
}

/**
 * Build the `docker exec` args that drop the user into a Claude Code session
 * with permissions bypassed — because the container is the boundary, the
 * per-action prompts guard nothing (ADR 0001, decision 4).
 */
export function claudeExecArgs(options: ClaudeExecOptions = {}): string[] {
  const { container = BOX_CONTAINER, cwd } = options;
  const args = ["exec", "-it", container];
  if (cwd) {
    args.push("-w", cwd);
  }
  args.push("claude", "--dangerously-skip-permissions");
  return args;
}

/** A `-v` value is a host bind mount unless its source is a bare named volume. */
export function isHostMount(volumeSpec: string): boolean {
  const source = volumeSpec.split(":")[0] ?? "";
  return (
    source.startsWith("/") ||
    source.startsWith(".") ||
    source.startsWith("~")
  );
}

/**
 * Guard: refuse to launch the Box if any `-v` flag would bind-mount the host
 * filesystem. This turns ADR 0001's "no host mounts" from a convention into an
 * enforced precondition.
 */
export function assertNoHostMounts(runArgs: readonly string[]): void {
  for (let i = 0; i < runArgs.length - 1; i++) {
    if (runArgs[i] === "-v" || runArgs[i] === "--volume") {
      const spec = runArgs[i + 1] ?? "";
      if (isHostMount(spec)) {
        throw new Error(
          `Refusing to start the Box: '${spec}' is a host mount. The Workspace ` +
            `must be a named volume (ADR 0001, threat A).`,
        );
      }
    }
  }
}
