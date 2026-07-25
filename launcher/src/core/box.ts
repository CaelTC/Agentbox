import {
  BOX_CONTAINER,
  BOX_IMAGE,
  HOME_DIR,
  HOME_VOLUME,
  WORKSPACE_DIR,
  WORKSPACE_VOLUME,
} from "./config";
import { PREVIEW_PORTS, TERMINAL_PORT, loopbackPublishArgs } from "./preview";

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
    // Disable IPv6 on the Box's interfaces. The Egress Policy is IPv4 (iptables);
    // without this, any v6 route would bypass it entirely (threat B). There is no
    // legitimate v6 need in the Box. Backstopped by the ip6tables deny-all in
    // apply-egress.sh.
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl",
    "net.ipv6.conf.default.disable_ipv6=1",
    // Publish preview ports + the web terminal on loopback so the Mac's browser
    // can reach a served page or the tmux session, without exposing the Box to
    // the LAN (ticket 07, ADR 0001).
    ...loopbackPublishArgs([...previewPorts, TERMINAL_PORT]),
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

/**
 * `docker exec` argv that updates Claude Code inside the Box to the latest
 * release — run on every launch (ADR 0002, refresh on launch). A rebuild alone
 * is not enough: the Dockerfile's `npm install -g` layer is cached, so the image
 * can keep shipping a months-old Claude.
 *
 * `claude update` over `npm install -g`: it detects the global install and only
 * downloads when a newer version exists (~1s no-op vs ~15s every launch).
 * Runs as root because that global install lives in /usr/local, which the Box's
 * `sandbox` user deliberately can't write to — as `sandbox` the updater would
 * migrate Claude into ~/.claude/local, which a session's PATH never sees.
 * `timeout` is applied IN the Box so a stalled download can't hang startup.
 */
export function boxUpdateClaudeArgs(container: string = BOX_CONTAINER): string[] {
  return ["exec", "-u", "root", container, "timeout", "180", "claude", "update"];
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
