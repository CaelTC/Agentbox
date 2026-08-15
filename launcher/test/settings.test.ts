import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HARNESS, type Harness } from "../src/core/config";
import { settingsPath } from "../src/main/paths";
import { harness, setHarness } from "../src/main/settings";

/**
 * The Harness setting: one app-level choice, in one small file (main/settings.ts).
 *
 * Run against a temporary AGENTBOX_HOME — the override main/paths.ts exists for —
 * so the suite never reads the developer's own setting or writes over it. The
 * default matters most here: it is what makes the whole feature free for every
 * Project that already exists, because "no key" means the same thing on the Box
 * side (box/bin/agentbox-session).
 */
const saved = process.env.AGENTBOX_HOME;

beforeEach(() => {
  process.env.AGENTBOX_HOME = mkdtempSync(join(tmpdir(), "agentbox-settings-"));
});

afterEach(() => {
  if (saved === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved;
});

describe("the Harness setting", () => {
  it("is Claude on a Launcher nobody has set it on, with nothing written anywhere", () => {
    expect(harness()).toBe("claude");
    expect(DEFAULT_HARNESS).toBe("claude");
    expect(() => readFileSync(settingsPath(), "utf8")).toThrow(); // reading created no file
  });

  it("persists the choice, so the next launch opens the agent this one picked", () => {
    setHarness("codex");

    expect(harness()).toBe("codex");
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ harness: "codex" });
  });

  it("goes back", () => {
    setHarness("codex");
    setHarness("claude");
    expect(harness()).toBe("claude");
  });

  it("keeps whatever else is in the file — one setting must not erase the next", () => {
    writeFileSync(settingsPath(), JSON.stringify({ somethingElse: true }));

    setHarness("codex");

    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      somethingElse: true,
      harness: "codex",
    });
  });

  // A picker is not worth a Launcher that won't start: every unreadable file is
  // the default, which is exactly the state of a Launcher that never had one.
  it("falls back to the default over a file that was hand-edited into nonsense", () => {
    writeFileSync(settingsPath(), '{"harness":"codex"');
    expect(harness()).toBe("claude");

    writeFileSync(settingsPath(), '{"harness":"gpt-9"}');
    expect(harness()).toBe("claude");
  });

  // The value is written into a Project's metadata and then read by the Box, so
  // an unknown name would land as a session that refuses to open.
  it("refuses to store an agent the Box has never heard of", () => {
    expect(() => setHarness("gpt-9" as Harness)).toThrow(/Unknown harness/);
  });
});
