import { describe, expect, it } from "vitest";
import { failureMessage, run, spawnPath } from "../src/main/exec";

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

/**
 * The deadline (#26). Every command against the running Box carries one, because
 * the Box Gate is single-file: a `docker exec` that never returns — Claude having
 * SIGSTOPped the sandbox's tmux server is enough — is not one dead operation but
 * every Box channel dead for the life of the Launcher, Update Agentbox included.
 *
 * Real processes, because what is being asserted is that a child which IGNORES
 * the polite signal still dies and still settles.
 */
describe("run's deadline", () => {
  it("kills a child that never exits — even one that ignores SIGTERM — and settles", async () => {
    const started = Date.now();
    const res = await run("sh", ["-c", "trap '' TERM; while :; do sleep 0.2; done"], undefined, 150);

    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timed out after 150ms");
    // It went the whole way to SIGKILL: the SIGTERM at 150ms was ignored.
    expect(Date.now() - started).toBeGreaterThan(1_000);
  }, 20_000);

  it("leaves a command that finishes inside the deadline alone", async () => {
    expect(await run("sh", ["-c", "printf hi"], undefined, 10_000)).toMatchObject({
      code: 0,
      stdout: "hi",
      stderr: "",
    });
  });

  it("has no deadline at all when none is asked for (the copies)", async () => {
    expect(await run("sh", ["-c", "printf hi"])).toMatchObject({ code: 0, stdout: "hi" });
  });
});

/**
 * What a failed command is allowed to put on screen. The Launcher ships with no
 * log file and no devtools, so this sentence is the ONLY place the reason
 * survives — and it is also a paragraph in front of a non-technical Sandbox
 * User, who a failed `docker build` would otherwise hand several hundred lines.
 */
describe("failureMessage", () => {
  const res = (stderr: string, code = 1) => ({ code, stdout: "", stderr });

  it("passes a short failure through untouched", () => {
    expect(failureMessage("`docker start`", res("no such container"))).toBe(
      "`docker start` failed (exit 1): no such container",
    );
  });

  it("keeps the TAIL of a long build log — the error is at the end, not the top", () => {
    const log = [...Array(200).keys()].map((i) => `#${i} [ ${i}/200] CACHED`).join("\n");
    const message = failureMessage("Box rebuild", res(`${log}\nERROR: no space left on device`));

    expect(message).toContain("ERROR: no space left on device");
    expect(message).not.toContain("#0 [ 0/200] CACHED");
    expect(message).toContain("…"); // says it was cut, rather than pretending
    expect(message.split("\n").length).toBeLessThan(20);
  });

  it("bounds one enormous line too — BuildKit's default output is ANSI redraws", () => {
    const message = failureMessage("Box rebuild", res("x".repeat(50_000)));
    expect(message.length).toBeLessThan(1_000);
  });

  it("says something when the command failed silently", () => {
    expect(failureMessage("`docker build`", res(""))).toContain("no output");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(failureMessage("`git pull`", { code: 1, stdout: "diverged", stderr: "" })).toContain("diverged");
  });
});
