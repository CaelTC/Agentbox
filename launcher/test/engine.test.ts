import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineCli } from "../src/core/config";
import { mustSucceed, run, runOk } from "../src/main/exec";
import { isEngineRunning, startEngine } from "../src/main/engine";

vi.mock("../src/main/exec", () => ({
  run: vi.fn(),
  runOk: vi.fn(),
  mustSucceed: vi.fn(),
}));

/** Every spawn the adapter made, in order, as `command arg arg…`. */
const calls: string[] = [];
const record = (command: string, args: readonly string[]) => {
  calls.push([command, ...args].join(" "));
};

const ok = { code: 0, stdout: "", stderr: "" };

beforeEach(() => {
  calls.length = 0;
  vi.mocked(mustSucceed).mockImplementation(async (c, a) => record(c, a));
  vi.mocked(runOk).mockImplementation(async (c, a) => (record(c, a), true));
  vi.mocked(run).mockImplementation(async (c, a) => (record(c, a), ok));
});

describe("engineCli", () => {
  it("is podman on Windows and docker everywhere else", () => {
    expect(engineCli("win32")).toBe("podman");
    expect(engineCli("darwin")).toBe("docker");
    expect(engineCli("linux")).toBe("docker");
  });
});

describe("startEngine", () => {
  it("on the Mac runs exactly one `colima start` at the Resource Cap — unchanged", async () => {
    await startEngine("darwin");
    expect(calls).toEqual(["colima start --profile claudebox --cpu 4 --memory 6 --disk 25"]);
  });

  it("never mentions podman on the Mac", async () => {
    await startEngine("darwin");
    expect(calls.join(" ")).not.toContain("podman");
  });

  it("on Windows inspects, inits the absent machine, sets it rootful, then starts", async () => {
    // `machine inspect` exits non-zero when there is no such machine.
    vi.mocked(runOk).mockImplementation(async (c, a) => (record(c, a), false));

    await startEngine("win32");

    expect(calls).toEqual([
      "podman machine inspect claudebox",
      "podman machine init --cpus 4 --memory 6144 --disk-size 25 claudebox",
      "podman machine set --rootful claudebox",
      "podman machine start claudebox",
    ]);
  });

  it("on Windows starts an existing machine without re-initing it", async () => {
    await startEngine("win32"); // runOk defaults to true = machine present

    expect(calls).toEqual([
      "podman machine inspect claudebox",
      "podman machine start claudebox",
    ]);
  });

  it("self-heals: a machine deleted behind the Launcher's back is re-created on the next start", async () => {
    vi.mocked(runOk).mockImplementation(async (c, a) => (record(c, a), false));
    await startEngine("win32");
    expect(calls).toContain("podman machine init --cpus 4 --memory 6144 --disk-size 25 claudebox");
  });
});

describe("isEngineRunning", () => {
  it("on the Mac reads `colima status`, which prints on stderr", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "", stderr: 'msg="colima [profile=claudebox] is running"' };
    });

    expect(await isEngineRunning("darwin")).toBe(true);
    expect(calls).toEqual(["colima status --profile claudebox"]);
  });

  it("on the Mac is false when colima reports the profile down", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: "", stderr: "colima is not running" };
    });
    expect(await isEngineRunning("darwin")).toBe(false);
  });

  it("on Windows reads `podman machine inspect`'s State", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 0, stdout: '[{"Name":"claudebox","State":"running"}]', stderr: "" };
    });

    expect(await isEngineRunning("win32")).toBe(true);
    expect(calls).toEqual(["podman machine inspect claudebox"]);
  });

  it("on Windows is false when there is no machine (non-zero exit)", async () => {
    vi.mocked(run).mockImplementation(async (c, a) => {
      record(c, a);
      return { code: 125, stdout: "", stderr: "Error: claudebox: VM does not exist" };
    });
    expect(await isEngineRunning("win32")).toBe(false);
  });
});
