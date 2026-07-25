import { describe, expect, it } from "vitest";
import { RESOURCE_CAP } from "../src/core/config";
import {
  isPodmanMachineRunning,
  podmanMachineInitArgs,
  podmanMachineInspectArgs,
  podmanMachineSetRootfulArgs,
  podmanMachineStartArgs,
} from "../src/core/podman";

describe("podmanMachineInitArgs", () => {
  it("creates the claudebox machine at the Resource Cap", () => {
    expect(podmanMachineInitArgs()).toEqual([
      "machine",
      "init",
      "--cpus",
      "4",
      "--memory",
      "6144",
      "--disk-size",
      "25",
      "claudebox",
    ]);
  });

  it("converts the Resource Cap's GiB to the MiB podman expects", () => {
    // colima's --memory is GiB, podman machine's is MiB. Passing 6 here would
    // hand the Box 6 MiB.
    const args = podmanMachineInitArgs({ cpu: 2, memoryGiB: 4, diskGiB: 10 });
    expect(args[args.indexOf("--memory") + 1]).toBe("4096");
  });

  it("passes CPU and the disk ceiling through verbatim (--disk-size is GiB, like colima)", () => {
    const args = podmanMachineInitArgs({ cpu: 2, memoryGiB: 4, diskGiB: 10 });
    expect(args[args.indexOf("--cpus") + 1]).toBe("2");
    expect(args[args.indexOf("--disk-size") + 1]).toBe("10");
  });

  it("names the machine last, so it is the positional arg and not a flag value", () => {
    expect(podmanMachineInitArgs(RESOURCE_CAP, "other").at(-1)).toBe("other");
  });
});

describe("podmanMachineStartArgs / podmanMachineInspectArgs", () => {
  it("start and inspect address the claudebox machine", () => {
    expect(podmanMachineStartArgs()).toEqual(["machine", "start", "claudebox"]);
    expect(podmanMachineInspectArgs()).toEqual(["machine", "inspect", "claudebox"]);
  });
});

describe("podmanMachineSetRootfulArgs", () => {
  it("sets the machine rootful — rootless rejects the Box's net.* sysctls and NET_ADMIN", () => {
    expect(podmanMachineSetRootfulArgs()).toEqual([
      "machine",
      "set",
      "--rootful",
      "claudebox",
    ]);
  });
});

describe("isPodmanMachineRunning", () => {
  it("is true for the JSON array podman machine inspect prints when the VM is up", () => {
    expect(isPodmanMachineRunning('[{"Name":"claudebox","State":"running"}]')).toBe(true);
  });

  it("is false when the machine exists but is stopped", () => {
    expect(isPodmanMachineRunning('[{"Name":"claudebox","State":"stopped"}]')).toBe(false);
  });

  it("is false for a bare error line or empty output, rather than throwing", () => {
    expect(isPodmanMachineRunning("Error: claudebox: VM does not exist")).toBe(false);
    expect(isPodmanMachineRunning("")).toBe(false);
    expect(isPodmanMachineRunning("null")).toBe(false);
  });
});
