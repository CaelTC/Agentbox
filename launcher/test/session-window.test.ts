import { describe, expect, it } from "vitest";
import {
  chromeAppOpenArgs,
  ensureSessionExecArgs,
  sessionUrl,
} from "../src/core/session-window";

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

describe("chromeAppOpenArgs", () => {
  it("opens a chromeless app-mode window (no URL bar or tabs)", () => {
    expect(chromeAppOpenArgs("http://localhost:7681/sessions/x")).toEqual([
      "-na",
      "Google Chrome",
      "--args",
      "--app=http://localhost:7681/sessions/x",
    ]);
  });
});
