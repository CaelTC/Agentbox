import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportRoot } from "../src/main/paths";

const saved = process.env.CLAUDEBOX_EXPORT_ROOT;
afterEach(() => {
  // The whole suite shares one process, so an override left set here would
  // silently redirect every later test that resolves a host path.
  if (saved === undefined) delete process.env.CLAUDEBOX_EXPORT_ROOT;
  else process.env.CLAUDEBOX_EXPORT_ROOT = saved;
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
