import { describe, expect, it } from "vitest";
import { BOX_ROOT_PATH, DB_NETWORK, DB_SUBNET } from "../src/core/config";
import {
  assertNoHostMounts,
  boxConnectDbArgs,
  boxRunArgs,
  boxUpdateClaudeArgs,
  dbNetworkCreateArgs,
  dbRunArgs,
  isHostMount,
} from "../src/core/box";

describe("boxRunArgs", () => {
  const args = boxRunArgs();

  it("runs the Box detached with the stable container name", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(args[args.indexOf("--name") + 1]).toBe("agentbox");
  });

  it("mounts the Workspace as a NAMED VOLUME, never a host path (ADR 0001, threat A)", () => {
    const vol = args[args.indexOf("-v") + 1];
    expect(vol).toBe("agentbox-workspace:/workspace");
  });

  it("persists the Claude login on a named home volume (survives restart/rebuild)", () => {
    expect(args.join(" ")).toContain("agentbox-home:/home/sandbox");
  });

  it("mounts nothing from the host filesystem", () => {
    expect(() => assertNoHostMounts(args)).not.toThrow();
  });

  it("disables IPv6 so the IPv4 Egress Policy can't be bypassed over v6 (threat B)", () => {
    expect(args.join(" ")).toContain("--sysctl net.ipv6.conf.all.disable_ipv6=1");
    expect(args.join(" ")).toContain("--sysctl net.ipv6.conf.default.disable_ipv6=1");
  });

  it("publishes the web terminal on loopback so the Mac's browser can open the tmux session", () => {
    expect(args.join(" ")).toContain("-p 127.0.0.1:7681:7681");
  });

  it("keeps the container alive so a Claude session can be exec'd into it", () => {
    // last tokens are the long-lived command
    expect(args.slice(-2).join(" ")).toBe("sleep infinity");
  });
});

describe("the Database (postgres beside the Box)", () => {
  const net = dbNetworkCreateArgs();
  const db = dbRunArgs();

  it("creates the network INTERNAL — no route out is what 'cannot escape' means", () => {
    expect(net).toContain("--internal");
  });

  it("pins the subnet the Egress Policy's allow names", () => {
    expect(net[net.indexOf("--subnet") + 1]).toBe(DB_SUBNET);
  });

  it("puts postgres on the internal network ONLY", () => {
    expect(db[db.indexOf("--network") + 1]).toBe(DB_NETWORK);
  });

  it("publishes NO port — the DB is reachable from inside the Box and nowhere else", () => {
    expect(db).not.toContain("-p");
    expect(db).not.toContain("--publish");
  });

  it("persists data on a named volume, never a host mount", () => {
    expect(db[db.indexOf("-v") + 1]).toBe("agentbox-postgres:/var/lib/postgresql/data");
    expect(() => assertNoHostMounts(db)).not.toThrow();
  });

  it("attaches the Box to the db network as a second interface", () => {
    expect(boxConnectDbArgs()).toEqual(["network", "connect", DB_NETWORK, "agentbox"]);
  });
});

describe("boxUpdateClaudeArgs", () => {
  const args = boxUpdateClaudeArgs();

  it("updates Claude Code as root in the running Box (root owns the global install)", () => {
    expect(args.join(" ")).toBe(
      `exec -u root -e PATH=${BOX_ROOT_PATH} agentbox timeout 180 claude update`,
    );
  });
});

describe("isHostMount", () => {
  it("flags absolute host paths", () => {
    expect(isHostMount("/Users/alex/secrets:/workspace")).toBe(true);
  });
  it("flags relative host paths", () => {
    expect(isHostMount("./data:/workspace")).toBe(true);
    expect(isHostMount("~/data:/workspace")).toBe(true);
  });
  it("does not flag named volumes", () => {
    expect(isHostMount("agentbox-workspace:/workspace")).toBe(false);
  });
});

describe("assertNoHostMounts", () => {
  it("throws if any -v is a host bind mount", () => {
    expect(() =>
      assertNoHostMounts(["run", "-v", "/Users/alex:/workspace", "agentbox:latest"]),
    ).toThrow(/host mount/i);
  });
});
