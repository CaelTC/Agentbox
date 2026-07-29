import {
  BOX_CONTAINER,
  BOX_IMAGE,
  BOX_ROOT_PATH,
  DB_CONTAINER,
  DB_IMAGE,
  DB_NETWORK,
  DB_SUBNET,
  DB_VOLUME,
  HOME_DIR,
  HOME_VOLUME,
  WORKSPACE_DIR,
  WORKSPACE_VOLUME,
} from "./config";
import { PREVIEW_PORTS, TERMINAL_PORT, loopbackPublishArgs } from "./preview";

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
 * The Database's network: INTERNAL (no route out — that is the wall, see
 * DB_NETWORK in config.ts) with the pinned subnet the Egress Policy's allow
 * names. Creating it when it already exists is an error the caller tolerates.
 */
export function dbNetworkCreateArgs(): string[] {
  return ["network", "create", "--internal", "--subnet", DB_SUBNET, DB_NETWORK];
}

/**
 * `docker run` args for the Database container. On the internal network ONLY,
 * and publishes no port: reachable from inside the Box and from nowhere else.
 * Data persists on a named volume — never a host mount, same as the Workspace.
 */
export function dbRunArgs(): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    DB_CONTAINER,
    "--network",
    DB_NETWORK,
    // Docker restarts a crashed DB by itself; the Launcher only creates/starts.
    "--restart",
    "unless-stopped",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-v",
    `${DB_VOLUME}:/var/lib/postgresql/data`,
    DB_IMAGE,
  ];
  assertNoHostMounts(args);
  return args;
}

/**
 * Attach the Box to the Database network as a SECOND interface — its default
 * bridge, published ports, and egress firewall all stay exactly as they are.
 * Run once, when the container is created; membership survives stop/start.
 */
export function boxConnectDbArgs(): string[] {
  return ["network", "connect", DB_NETWORK, BOX_CONTAINER];
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
  // Sanitized PATH for the same reason as box-exec's root seam: never resolve a
  // root command through the sandbox-writable /usr/local/cargo/bin.
  return [
    "exec",
    "-u",
    "root",
    "-e",
    `PATH=${BOX_ROOT_PATH}`,
    container,
    "timeout",
    "180",
    "claude",
    "update",
  ];
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
