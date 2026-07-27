import { describe, expect, it, vi } from "vitest";
import type { RefreshResult } from "../src/core/refresh";
import type { BootstrapStatus } from "../src/shared/api";
import { bootstrap, type BootstrapSteps } from "../src/main/bootstrap";

/**
 * The launch sequence (issue #27). A first launch builds the Box image, which is
 * minutes long, and until this the Sandbox User watched one motionless screen
 * for all of it — indistinguishable from a Launcher that had hung.
 *
 * What is asserted here is the SEQUENCE and the statuses, because that is what
 * broke: a `working` has to reach the screen BEFORE the step it describes, bad
 * news that did not stop the launch has to reach it at all, and — the invariant
 * a comment used to defend alone — exactly one `ok` may ever be sent, since an
 * `ok` is what makes the renderer replace whatever is on screen with the home
 * screen.
 */

// bootstrap.ts reaches ipc.ts for `homeListedProjects`, which reaches electron.
vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { getPath: vi.fn(() => "/tmp/claudebox-test-home") },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => "") },
}));

const refreshed = (over: Partial<RefreshResult> = {}): RefreshResult => ({
  action: "started",
  reason: "Box definition unchanged; starting quickly.",
  online: true,
  ...over,
});

/**
 * A recording set of steps. `calls` is the order things happened in — the steps
 * themselves and the messages they emitted, interleaved, so "the message came
 * before the work" is a fact about one array rather than two.
 */
function fakeSteps(over: Partial<BootstrapSteps> = {}) {
  const calls: string[] = [];
  const sent: BootstrapStatus[] = [];
  const steps: BootstrapSteps = {
    ensureEngine: async (onStep) => {
      calls.push("ensureEngine");
      onStep("Starting the engine…");
    },
    refresh: async (onStep) => {
      calls.push("refresh");
      onStep("Building the image…");
      return refreshed();
    },
    removeBoxContainer: async () => void calls.push("removeBoxContainer"),
    ensureBoxReady: async (onStep) => {
      calls.push("ensureBoxReady");
      onStep("Starting the container…");
    },
    updateClaudeCode: async () => (calls.push("updateClaudeCode"), true),
    homeListed: Promise.resolve(),
    ...over,
  };
  // The emit order matters, so `working` messages are recorded in `calls` too.
  const send = (status: BootstrapStatus) => {
    sent.push(status);
    calls.push("phase" in status ? `say:${status.message}` : `terminal:${status.ok}`);
  };
  return { steps, calls, sent, send };
}

describe("bootstrap", () => {
  it("names each slow step BEFORE doing it, then reports ready exactly once", async () => {
    const { steps, calls, sent, send } = fakeSteps();

    await bootstrap(send, steps);

    expect(calls).toEqual([
      "ensureEngine",
      "say:Starting the engine…",
      "refresh",
      "say:Building the image…",
      "ensureBoxReady",
      "say:Starting the container…",
      "terminal:true",
      "updateClaudeCode",
    ]);
    expect(sent.filter((s) => "ok" in s)).toHaveLength(1);
  });

  it("updates Claude Code AFTER the home screen is drawn, never in front of it", async () => {
    const { steps, calls, send } = fakeSteps();

    await bootstrap(send, steps);

    // The whole reason `claude update` takes a second turn at the gate: held as
    // one, up to `timeout 180` of it sat in front of every launch's first paint.
    expect(calls.indexOf("terminal:true")).toBeLessThan(calls.indexOf("updateClaudeCode"));
  });

  it("recreates the container when the refresh rebuilt, and not when it didn't", async () => {
    const rebuilt = fakeSteps({ refresh: async () => refreshed({ action: "rebuilt" }) });
    await bootstrap(rebuilt.send, rebuilt.steps);
    expect(rebuilt.calls).toContain("removeBoxContainer");

    const unchanged = fakeSteps();
    await bootstrap(unchanged.send, unchanged.steps);
    expect(unchanged.calls).not.toContain("removeBoxContainer");
  });

  it("still opens on the last-built image when the rebuild failed — and SAYS so", async () => {
    const { steps, sent, send } = fakeSteps({
      refresh: async () => refreshed({ action: "error", reason: "Box rebuild failed (exit 1): no space left" }),
    });

    await bootstrap(send, steps);

    const ready = sent.find((s) => "ok" in s && s.ok === true);
    expect(ready).toBeDefined();
    // The launch succeeded, so this is a notice on the home screen rather than
    // the cold-room screen — but it is not nothing, which is what it used to be.
    expect(ready).toMatchObject({ ok: true });
    expect((ready as { notice?: string }).notice).toContain("no space left");
  });

  it("says it when the integrity gate refused the definition", async () => {
    const { steps, sent, send } = fakeSteps({
      refresh: async () =>
        refreshed({ action: "blocked", reason: "Refusing to build: definition HEAD abc does not match the pinned commit def." }),
    });

    await bootstrap(send, steps);

    const ready = sent.find((s) => "ok" in s && s.ok === true) as { notice?: string };
    expect(ready.notice).toContain("Refusing to build");
  });

  it("says it when a build ran with no reviewed commit pinned (threat B)", async () => {
    const { steps, sent, send } = fakeSteps({
      refresh: async () => refreshed({ action: "rebuilt", unpinned: true }),
    });

    await bootstrap(send, steps);

    const ready = sent.find((s) => "ok" in s && s.ok === true) as { notice?: string };
    expect(ready.notice).toContain("UNPINNED");
  });

  it("carries no notice when nothing went wrong", async () => {
    const { steps, sent, send } = fakeSteps();

    await bootstrap(send, steps);

    const ready = sent.find((s) => "ok" in s && s.ok === true) as { notice?: string };
    expect(ready.notice).toBeUndefined();
  });

  it("reports a failed launch as the one status that draws the cold room", async () => {
    const { steps, sent, send } = fakeSteps({
      ensureBoxReady: async () => {
        throw new Error("`docker start claudebox` failed (exit 1): no such container");
      },
    });

    await bootstrap(send, steps);

    expect(sent.filter((s) => "ok" in s && s.ok === true)).toHaveLength(0);
    const failed = sent.at(-1) as { ok: boolean; message: string };
    expect(failed.ok).toBe(false);
    expect(failed.message).toBe(
      "Couldn't start Claudebox: `docker start claudebox` failed (exit 1): no such container",
    );
  });

  it("does not wait forever on a window that never asks for its Projects", async () => {
    const { steps, calls, send } = fakeSteps({ homeListed: new Promise<void>(() => {}) });

    // Resolves on the grace timer rather than the never-resolving listing.
    vi.useFakeTimers();
    const done = bootstrap(send, steps);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
    vi.useRealTimers();

    expect(calls).toContain("updateClaudeCode");
  });

  it("emits no message for a warm launch that had nothing slow to do", async () => {
    const { steps, sent, send } = fakeSteps({
      ensureEngine: async () => undefined, // engine already up
      refresh: async () => refreshed(),
      ensureBoxReady: async () => undefined, // plan collapsed to [attach]
    });

    await bootstrap(send, steps);

    expect(sent.map((s) => s.message)).toEqual(["Claudebox is ready."]);
  });
});
