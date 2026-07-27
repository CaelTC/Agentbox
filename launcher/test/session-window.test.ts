import { describe, expect, it } from "vitest";
import {
  ensureSessionArgs,
  isConsoleUrl,
  killSessionArgs,
  sessionUrl,
  sessionWindowOptions,
} from "../src/core/session-window";

describe("sessionUrl", () => {
  it("points at the loopback-forwarded console port for the Project", () => {
    expect(sessionUrl("my-project")).toBe("http://localhost:7681/sessions/my-project");
  });
  it("refuses an unsafe slug (defence in depth against a crafted URL)", () => {
    expect(() => sessionUrl("../etc")).toThrow(/unsafe/i);
  });
});

describe("ensureSessionArgs", () => {
  // The `exec <container>` prefix is the Box-exec seam's, exactly as for
  // `killSessionArgs`: the router has the Box up before this ever runs, so
  // nothing here reaches past the seam.
  it("routes through the single funnel, passing the slug as its own argv", () => {
    expect(ensureSessionArgs("game2")).toEqual(["claudebox-session", "game2"]);
  });
  it("carries no `exec`/container prefix of its own — that belongs to the seam", () => {
    expect(ensureSessionArgs("game2")).not.toContain("exec");
    expect(ensureSessionArgs("game2")).not.toContain("claudebox");
  });
  it("never runs interactively (-it) — off a TTY the funnel only ensures the session", () => {
    expect(ensureSessionArgs("game2")).not.toContain("-it");
  });
  it("refuses an unsafe slug", () => {
    expect(() => ensureSessionArgs("a; rm -rf /")).toThrow(/unsafe/i);
  });
});

describe("killSessionArgs", () => {
  // The `exec <container>` prefix is the Box-exec seam's (main/box-exec.ts), so
  // what lives here is only the command that runs INSIDE the Box.
  it("kills the Project's tmux session by name, slug as its own argv", () => {
    expect(killSessionArgs("game2")).toEqual(["tmux", "kill-session", "-t", "game2"]);
  });

  it("targets exactly the session the funnel would re-attach to", () => {
    // The funnel does `tmux new-session -A -s <slug>`, so a Project deleted while
    // its session lives would otherwise leave that session to be re-attached by
    // the next Project with the same slug — cwd on a directory that is gone.
    const killed = killSessionArgs("portfolio").at(-1);
    const ensured = ensureSessionArgs("portfolio");
    expect(killed).toBe(ensured[ensured.length - 1]);
  });

  it("refuses an unsafe slug", () => {
    expect(() => killSessionArgs("a; rm -rf /")).toThrow(/unsafe/i);
  });
});

describe("isConsoleUrl", () => {
  it("accepts the console's own pages — the session, its Files view, other sessions", () => {
    expect(isConsoleUrl("http://localhost:7681/sessions/demo")).toBe(true);
    expect(isConsoleUrl("http://localhost:7681/sessions/demo/files")).toBe(true);
    expect(isConsoleUrl("http://localhost:7681/sessions/other")).toBe(true);
  });

  it("rejects a lookalike host that merely starts with ours", () => {
    // The reason this is a parsed origin and not a string prefix: a page served
    // from the Box could otherwise walk the window off onto its own host.
    expect(isConsoleUrl("http://localhost:7681.example.com/sessions/demo")).toBe(false);
  });

  it("rejects another port, another host, and another scheme", () => {
    expect(isConsoleUrl("http://localhost:5173/sessions/demo")).toBe(false);
    expect(isConsoleUrl("http://example.com/sessions/demo")).toBe(false);
    expect(isConsoleUrl("file:///etc/passwd")).toBe(false);
    expect(isConsoleUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects anything that isn't a URL at all, without throwing", () => {
    expect(isConsoleUrl("")).toBe(false);
    expect(isConsoleUrl("not a url")).toBe(false);
  });
});

describe("sessionWindowOptions", () => {
  it("hands the Box's page a renderer with nothing in it: no preload, no Node, sandboxed", () => {
    const { webPreferences } = sessionWindowOptions("demo");
    // The IPC bridge belongs to the home window alone — this page comes from the
    // untrusted side of the boundary (ADR 0001).
    expect(webPreferences?.preload).toBeUndefined();
    expect(webPreferences?.nodeIntegration).toBe(false);
    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.sandbox).toBe(true);
    expect(webPreferences?.webviewTag).toBe(false);
  });

  it("names the window after the Project for the moment before the page loads", () => {
    expect(sessionWindowOptions("demo").title).toBe("demo · Claudebox");
  });

  it("refuses an unsafe slug rather than titling a window with it", () => {
    expect(() => sessionWindowOptions("../etc")).toThrow(/unsafe/i);
  });
});
