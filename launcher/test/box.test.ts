import { describe, expect, it } from "vitest";
import {
  assertNoHostMounts,
  boxBuildArgs,
  boxRunArgs,
  claudeExecArgs,
  isHostMount,
} from "../src/core/box";

describe("boxBuildArgs", () => {
  it("builds the Box image from a context directory", () => {
    expect(boxBuildArgs({ contextDir: "/opt/claudebox/box", image: "claudebox:latest" })).toEqual([
      "build",
      "-t",
      "claudebox:latest",
      "/opt/claudebox/box",
    ]);
  });
});

describe("boxRunArgs", () => {
  const args = boxRunArgs();

  it("runs the Box detached with the stable container name", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("-d");
    expect(args[args.indexOf("--name") + 1]).toBe("claudebox");
  });

  it("mounts the Workspace as a NAMED VOLUME, never a host path (ADR 0001, threat A)", () => {
    const vol = args[args.indexOf("-v") + 1];
    expect(vol).toBe("claudebox-workspace:/workspace");
  });

  it("persists the Claude login on a named home volume (survives restart/rebuild)", () => {
    expect(args.join(" ")).toContain("claudebox-home:/home/sandbox");
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

describe("isHostMount", () => {
  it("flags absolute host paths", () => {
    expect(isHostMount("/Users/alex/secrets:/workspace")).toBe(true);
  });
  it("flags relative host paths", () => {
    expect(isHostMount("./data:/workspace")).toBe(true);
    expect(isHostMount("~/data:/workspace")).toBe(true);
  });
  it("does not flag named volumes", () => {
    expect(isHostMount("claudebox-workspace:/workspace")).toBe(false);
  });
});

describe("assertNoHostMounts", () => {
  it("throws if any -v is a host bind mount", () => {
    expect(() =>
      assertNoHostMounts(["run", "-v", "/Users/alex:/workspace", "claudebox:latest"]),
    ).toThrow(/host mount/i);
  });
});

describe("claudeExecArgs", () => {
  it("runs Claude Code with permissions bypassed (no per-action prompts)", () => {
    const args = claudeExecArgs();
    expect(args.slice(0, 3)).toEqual(["exec", "-it", "claudebox"]);
    expect(args).toContain("claude");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("scopes the session to a Project working directory when given one", () => {
    const args = claudeExecArgs({ cwd: "/workspace/my-project" });
    expect(args[args.indexOf("-w") + 1]).toBe("/workspace/my-project");
  });

  it("omits -w when no Project directory is given", () => {
    expect(claudeExecArgs()).not.toContain("-w");
  });
});
