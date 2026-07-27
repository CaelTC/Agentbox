import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineCli } from "../src/core/config";
import { mustSucceed, run } from "../src/main/exec";
import { engineFor } from "../src/main/engine";

vi.mock("../src/main/exec", () => ({
  run: vi.fn(),
  mustSucceed: vi.fn(),
}));

/** Every spawn the adapter made, in order, as `command arg arg…`. */
const calls: string[] = [];
const record = (command: string, args: readonly string[]) => {
  calls.push([command, ...args].join(" "));
};

const ok = { code: 0, stdout: "", stderr: "" };
/** `podman machine inspect` on a machine that is not there. */
const absent = { code: 125, stdout: "", stderr: "Error: claudebox: VM does not exist" };

beforeEach(() => {
  calls.length = 0;
  vi.mocked(mustSucceed).mockImplementation(async (c, a) => record(c, a));
  vi.mocked(run).mockImplementation(async (c, a) => (record(c, a), ok));
});

describe("engineCli", () => {
  it("is podman on Windows and docker everywhere else", () => {
    expect(engineCli("win32")).toBe("podman");
    expect(engineCli("darwin")).toBe("docker");
    expect(engineCli("linux")).toBe("docker");
  });
});

describe("Engine.start", () => {
  it("on the Mac runs exactly one `colima start` at the Resource Cap — unchanged", async () => {
    await engineFor("darwin").start();
    expect(calls).toEqual(["colima start --profile claudebox --cpu 4 --memory 6 --disk 25"]);
  });

  it("never mentions podman on the Mac", async () => {
    await engineFor("darwin").start();
    expect(calls.join(" ")).not.toContain("podman");
  });

  it("on Windows inspects, inits the absent machine, sets it rootful, then starts", async () => {
    // `machine inspect` exits non-zero when there is no such machine.
    vi.mocked(run).mockImplementation(async (c, a) => (record(c, a), absent));

    await engineFor("win32").start();

    expect(calls).toEqual([
      "podman machine inspect --format {{.State}} claudebox",
      "podman machine init --cpus 4 --memory 6144 --disk-size 25 claudebox",
      "podman machine set --rootful claudebox",
      "podman machine start claudebox",
    ]);
  });

  it("on Windows starts an existing machine without re-initing it", async () => {
    await engineFor("win32").start(); // `run` defaults to exit 0 = machine present

    expect(calls).toEqual([
      "podman machine inspect --format {{.State}} claudebox",
      "podman machine set --rootful claudebox",
      "podman machine start claudebox",
    ]);
  });

  it("re-applies rootful to an existing machine, so a stranded rootless one heals", async () => {
    // The case this pins: `init` succeeded on an earlier run and `set --rootful`
    // did not. The machine exists from then on, so if rootful lived in the init
    // branch it would never be attempted again and the Box would run rootless
    // forever — where boxRunArgs' NET_ADMIN and net.ipv6 sysctls are refused.
    await engineFor("win32").start();
    expect(calls).toContain("podman machine set --rootful claudebox");
  });

  it("self-heals: a machine deleted behind the Launcher's back is re-created on the next start", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => (record(c, a), absent));
    await engineFor("win32").start();
    expect(calls).toContain("podman machine init --cpus 4 --memory 6144 --disk-size 25 claudebox");
  });
});

describe("Engine.isRunning", () => {
  it("on the Mac reads `colima status`, which prints on stderr", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "", stderr: 'msg="colima [profile=claudebox] is running"' };
    });

    expect(await engineFor("darwin").isRunning()).toBe(true);
    expect(calls).toEqual(["colima status --profile claudebox"]);
  });

  it("on the Mac is false when colima reports the profile down", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "", stderr: "colima is not running" };
    });
    expect(await engineFor("darwin").isRunning()).toBe(false);
  });

  it("on Windows reads `podman machine inspect`'s State", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "running\n", stderr: "" };
    });

    expect(await engineFor("win32").isRunning()).toBe(true);
    expect(calls).toEqual(["podman machine inspect --format {{.State}} claudebox"]);
  });

  it("on Windows is false when the machine exists but is stopped", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "stopped\n", stderr: "" };
    });
    expect(await engineFor("win32").isRunning()).toBe(false);
  });

  it("on Windows is false when there is no machine (non-zero exit)", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 125, stdout: "", stderr: "Error: claudebox: VM does not exist" };
    });
    expect(await engineFor("win32").isRunning()).toBe(false);
  });
});
