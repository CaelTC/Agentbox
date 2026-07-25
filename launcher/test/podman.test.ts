import { describe, expect, it } from "vitest";
import {
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
    expect(podmanMachineInitArgs().at(-1)).toBe("claudebox");
  });
});

describe("podmanMachineStartArgs / podmanMachineInspectArgs", () => {
  it("start addresses the claudebox machine", () => {
    expect(podmanMachineStartArgs()).toEqual(["machine", "start", "claudebox"]);
  });

  it("inspect asks podman for the State alone, so nothing here parses its JSON", () => {
    expect(podmanMachineInspectArgs()).toEqual([
      "machine",
      "inspect",
      "--format",
      "{{.State}}",
      "claudebox",
    ]);
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
