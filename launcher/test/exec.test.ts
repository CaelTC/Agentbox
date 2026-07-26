import { describe, expect, it } from "vitest";
import { runPipe, spawnPath } from "../src/main/exec";

const allExist = () => true;
const noneExist = () => false;

describe("spawnPath", () => {
  it("prepends Homebrew bin so GUI-launched apps find colima", () => {
    const path = spawnPath("/usr/bin:/bin", allExist);
    expect(path.split(":")[0]).toBe("/opt/homebrew/bin");
    expect(path).toContain("/usr/bin");
  });

  it("leaves PATH unchanged when Homebrew is not installed", () => {
    expect(spawnPath("/usr/bin:/bin", noneExist)).toBe("/usr/bin:/bin");
  });

  it("does not duplicate a dir already on PATH", () => {
    const path = spawnPath("/opt/homebrew/bin:/usr/bin", allExist);
    expect(path.split(":").filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("leaves PATH untouched on Windows — no Homebrew, and ':' is not the separator", () => {
    expect(spawnPath("C:\\Windows;C:\\podman", allExist, "win32")).toBe("C:\\Windows;C:\\podman");
  });
});

describe("runPipe", () => {
  // The precedence rule below is the whole reason this function was rewritten:
  // Import shipped once reporting success on a copy that moved nothing.
  it("reports the FIRST stage's failure even when the second exits 0", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf partial; exit 3"] },
      { command: "cat", args: [] },
    );
    expect(res.code).toBe(3);
  });

  it("reports the second stage's failure when the first is clean", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf ok"] },
      { command: "sh", args: ["-c", "cat >/dev/null; exit 4"] },
    );
    expect(res.code).toBe(4);
  });

  it("succeeds and returns the second stage's stdout when both are clean", async () => {
    const res = await runPipe({ command: "cat", args: [] }, { command: "cat", args: [] }, "hello");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hello");
  });

  // A second stage that exits before reading makes the pipe write EPIPE. An
  // unlistened 'error' takes the Launcher's main process down — and merely
  // swallowing it is not enough either: the first stage then blocks forever on
  // a buffer nobody drains, so this test hangs rather than fails if that
  // teardown regresses. Resolving at all IS the assertion.
  it("survives the second stage exiting without reading its input", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "printf 'x%.0s' $(seq 1 200000)"] },
      { command: "sh", args: ["-c", "exit 0"] },
    );
    expect(typeof res.code).toBe("number");
  }, 5_000);

  // The mirror case: a first stage that exits without reading its stdin. EPIPE
  // lands on the write side instead, and is just as fatal unlistened.
  it("survives the first stage exiting without reading its input", async () => {
    const res = await runPipe(
      { command: "sh", args: ["-c", "exit 5"] },
      { command: "cat", args: [] },
      "x".repeat(200_000),
    );
    expect(res.code).toBe(5);
  }, 5_000);
});
