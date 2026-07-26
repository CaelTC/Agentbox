import { describe, expect, it } from "vitest";
import {
  chromeAppLaunch,
  ensureSessionExecArgs,
  killSessionExecArgs,
  sessionUrl,
  windowsChromePaths,
} from "../src/core/session-window";

const windowsEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\sandbox\\AppData\\Local",
};

describe("sessionUrl", () => {
  it("points at the loopback-forwarded console port for the Project", () => {
    expect(sessionUrl("my-project")).toBe("http://localhost:7681/sessions/my-project");
  });
  it("refuses an unsafe slug (defence in depth against a crafted URL)", () => {
    expect(() => sessionUrl("../etc")).toThrow(/unsafe/i);
  });
});

describe("ensureSessionExecArgs", () => {
  it("routes through the single funnel, passing the slug as its own argv", () => {
    expect(ensureSessionExecArgs("game2")).toEqual([
      "exec",
      "claudebox",
      "claudebox-session",
      "game2",
    ]);
  });
  it("never runs interactively (-it) — off a TTY the funnel only ensures the session", () => {
    expect(ensureSessionExecArgs("game2")).not.toContain("-it");
  });
  it("refuses an unsafe slug", () => {
    expect(() => ensureSessionExecArgs("a; rm -rf /")).toThrow(/unsafe/i);
  });
});

describe("killSessionExecArgs", () => {
  it("kills the Project's tmux session by name, slug as its own argv", () => {
    expect(killSessionExecArgs("game2")).toEqual([
      "exec",
      "claudebox",
      "tmux",
      "kill-session",
      "-t",
      "game2",
    ]);
  });

  it("targets exactly the session the funnel would re-attach to", () => {
    // The funnel does `tmux new-session -A -s <slug>`, so a Project deleted while
    // its session lives would otherwise leave that session to be re-attached by
    // the next Project with the same slug — cwd on a directory that is gone.
    const [, , , , , killed] = killSessionExecArgs("portfolio");
    const ensured = ensureSessionExecArgs("portfolio");
    expect(killed).toBe(ensured[ensured.length - 1]);
  });

  it("does not run as root — the tmux server belongs to the sandbox user", () => {
    expect(killSessionExecArgs("game2")).not.toContain("-u");
  });

  it("refuses an unsafe slug", () => {
    expect(() => killSessionExecArgs("a; rm -rf /")).toThrow(/unsafe/i);
  });
});

describe("windowsChromePaths", () => {
  it("probes the three standard install locations, in order", () => {
    expect(windowsChromePaths(windowsEnv)).toEqual([
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Users\\sandbox\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  it("skips roots the environment doesn't define (no `undefined\\Google\\…` path)", () => {
    expect(windowsChromePaths({ LOCALAPPDATA: "C:\\local" })).toEqual([
      "C:\\local\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });
});

describe("chromeAppLaunch", () => {
  const url = "http://localhost:7681/sessions/x";

  it("on the Mac still goes through `open`, in a chromeless app-mode window", () => {
    expect(chromeAppLaunch(url, "darwin")).toEqual({
      command: "open",
      args: ["-na", "Google Chrome", "--args", `--app=${url}`],
    });
  });

  it("on the Mac never probes for chrome.exe", () => {
    const exists = () => {
      throw new Error("the Mac must not probe the filesystem");
    };
    expect(chromeAppLaunch(url, "darwin", windowsEnv, exists)?.command).toBe("open");
  });

  it("on Windows spawns the first chrome.exe found, in app mode", () => {
    const launch = chromeAppLaunch(url, "win32", windowsEnv, (p) => p.startsWith("C:\\Users"));
    expect(launch).toEqual({
      command: "C:\\Users\\sandbox\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      args: [`--app=${url}`],
    });
  });

  it("on Windows prefers ProgramFiles when several copies exist", () => {
    expect(chromeAppLaunch(url, "win32", windowsEnv, () => true)?.command).toBe(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    );
  });

  it("is undefined when Chrome is absent, so the caller falls back to the default browser", () => {
    expect(chromeAppLaunch(url, "win32", windowsEnv, () => false)).toBeUndefined();
  });
});
