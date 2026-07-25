import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeboxHome, exportRoot } from "../src/main/paths";

const saved = {
  CLAUDEBOX_HOME: process.env.CLAUDEBOX_HOME,
  CLAUDEBOX_EXPORT_ROOT: process.env.CLAUDEBOX_EXPORT_ROOT,
};
afterEach(() => {
  // The whole suite shares one process, so an override left set here would
  // silently redirect every later test that resolves a host path.
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// Both host roots are overridable for the same reason, and the pair is tested
// together so the symmetry can't rot on one side.
describe("claudeboxHome", () => {
  it("keeps the Launcher's own state out of sight, beside the user's other dotfiles", () => {
    delete process.env.CLAUDEBOX_HOME;
    expect(claudeboxHome()).toBe(join(homedir(), ".claudebox"));
  });

  it("can be pointed elsewhere, so a test never writes to the real home", () => {
    process.env.CLAUDEBOX_HOME = "/tmp/claudebox-home";
    expect(claudeboxHome()).toBe("/tmp/claudebox-home");
  });
});

describe("exportRoot", () => {
  it("lands Exported work in a visible folder the Sandbox User can find in Finder", () => {
    delete process.env.CLAUDEBOX_EXPORT_ROOT;
    expect(exportRoot()).toBe(join(homedir(), "Claudebox"));
  });

  it("can be pointed elsewhere, so a test or a second install never writes to the real home", () => {
    process.env.CLAUDEBOX_EXPORT_ROOT = "/tmp/claudebox-export";
    expect(exportRoot()).toBe("/tmp/claudebox-export");
  });
});
