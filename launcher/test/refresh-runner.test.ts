import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFINITION_REPO } from "../src/core/config";
import type { RefreshResult } from "../src/core/refresh";
import { run } from "../src/main/exec";
import { refreshOnLaunch, updateClaudebox, type UpdateSteps } from "../src/main/refresh-runner";

/**
 * The definition has to be ON the host before it can be pulled. Every install
 * path that isn't the Install Script leaves `~/.claudebox/definition` missing —
 * a repo checkout, a copied .app, a deleted folder — and `git -C <missing> pull`
 * then fails on EVERY launch, is read as "offline", and Refresh on Launch (the
 * sole update mechanism, ADR 0002) silently never runs again.
 *
 * That failure is invisible by construction: the Launcher opens normally on its
 * last-built image and says nothing. So the clone is pinned here.
 */

vi.mock("../src/main/exec", () => ({ run: vi.fn(), runOk: vi.fn(), mustSucceed: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "storedhash"),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
}));

const HOME = "/tmp/claudebox-test-home";
const DEFINITION = `${HOME}/definition`;
const ok = { code: 0, stdout: "", stderr: "" };

/** Every command the runner spawned, as `command arg arg…`. */
const calls = () => vi.mocked(run).mock.calls.map(([c, a]) => `${c} ${a.join(" ")}`);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLAUDEBOX_HOME = HOME;
  vi.mocked(run).mockResolvedValue(ok);
});

afterEach(() => {
  delete process.env.CLAUDEBOX_HOME;
});

describe("fetchDefinition (via refreshOnLaunch)", () => {
  it("CLONES the public repo when the definition isn't on the host yet", async () => {
    // Nothing exists: no clone, and no stored image hash either (first launch).
    vi.mocked(existsSync).mockReturnValue(false);

    await refreshOnLaunch();

    expect(calls()[0]).toBe(`git clone --depth 1 ${DEFINITION_REPO} ${DEFINITION}`);
  });

  it("pulls (never re-clones) once the definition is there", async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    await refreshOnLaunch();

    expect(calls()[0]).toBe(`git -C ${DEFINITION} pull --ff-only`);
    expect(calls().some((c) => c.includes("clone"))).toBe(false);
  });

  it("clones over HTTPS with no credential of any kind (ADR 0002)", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await refreshOnLaunch();

    const clone = calls()[0]!;
    expect(clone).toContain("https://");
    expect(clone).not.toMatch(/token|@github\.com|password|ssh/i);
  });

  it("reports offline — not a crash — when git itself can't be run", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(run).mockRejectedValueOnce(new Error("spawn git ENOENT"));

    // A prior image exists (readFileSync returns a hash), so the honest outcome
    // is to keep running it rather than fail the launch.
    const result = await refreshOnLaunch();

    expect(result).toMatchObject({ action: "started", online: false });
  });

  it("does not build when the fetch failed — a stale image beats an unknown one", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not a git repository" });

    const result = await refreshOnLaunch();

    expect(result.online).toBe(false);
    expect(calls().some((c) => c.includes("build"))).toBe(false);
  });
});

/**
 * "Update Claudebox" on the home screen. This used to live inside the IPC
 * handler, closed over the BrowserWindow, so the one thing it must get right —
 * only a REBUILT definition may end an open Claude session — could not be
 * asserted at all. The lifecycle is an argument now, so it can be.
 */
describe("updateClaudebox", () => {
  const rebuilt: RefreshResult = { action: "rebuilt", reason: "changed upstream", online: true };

  interface Recorded extends UpdateSteps {
    readonly calls: string[];
  }

  function fakeSteps(result: RefreshResult, claudeUpdated = true): Recorded {
    const calls: string[] = [];
    const step = <T>(name: string, value: T) => async (): Promise<T> => {
      calls.push(name);
      return value;
    };
    return {
      calls,
      refresh: step("refresh", result),
      ensureEngine: step("ensureEngine", undefined),
      removeBoxContainer: step("removeBoxContainer", undefined),
      ensureBoxReady: step("ensureBoxReady", undefined),
      updateClaudeCode: step("updateClaudeCode", claudeUpdated),
    };
  }

  it("recreates the Box on the new image and re-updates Claude, in that order", async () => {
    const steps = fakeSteps(rebuilt);

    const message = await updateClaudebox(steps);

    expect(steps.calls).toEqual([
      "ensureEngine", // the build needs the Engine, exactly as at launch
      "refresh",
      "removeBoxContainer", // a rebuilt image does nothing while the old one runs
      "ensureBoxReady",
      "updateClaudeCode", // the image's npm layer can be months stale
    ]);
    expect(message).toMatch(/up to date.*restarted/);
  });

  // The recreate ends every open Claude session. Being told "already up to date"
  // and losing your work to it anyway is the failure this guards.
  it("restarts NOTHING when there was nothing new to build", async () => {
    const steps = fakeSteps({ action: "started", reason: "unchanged", online: true });

    const message = await updateClaudebox(steps);

    expect(steps.calls).toEqual(["ensureEngine", "refresh"]);
    expect(message).toBe("Claudebox is already up to date.");
  });

  it("passes the integrity gate's own words through when it refuses to build", async () => {
    const steps = fakeSteps({ action: "blocked", reason: "origin is not the public repo", online: true });

    expect(await updateClaudebox(steps)).toBe("origin is not the public repo");
    expect(steps.calls).not.toContain("removeBoxContainer");
  });

  // Best effort by design: the version baked into the freshly-built image still
  // works, so a slow registry must not turn a successful update into a failure.
  it("still reports the update when the Claude Code refresh could not run", async () => {
    const steps = fakeSteps(rebuilt, false);

    expect(await updateClaudebox(steps)).toMatch(/up to date/);
    expect(steps.calls).toContain("updateClaudeCode");
  });
});
